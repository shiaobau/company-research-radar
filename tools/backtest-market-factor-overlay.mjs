import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fetchJson, readJson, round, toNumber, writeJson } from "./data-sources.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");
const defaultBacktestId = "2026-Q2-market-factor-overlay";
const factorDefinitions = [
  { id: "valuation_favorable_pct", label: "同業估值有利度", direction: "higher_is_more_favorable" },
  { id: "institutional_net_percentile", label: "法人淨買賣同業百分位", direction: "higher_is_more_buying" },
  { id: "financing_change_percentile", label: "融資增減同業百分位", direction: "higher_is_more_financing" },
  { id: "short_change_percentile", label: "融券增減同業百分位", direction: "higher_is_more_shorting" },
  { id: "volume_activity_percentile", label: "量能活躍度同業百分位", direction: "higher_is_more_active" }
];

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function validTicker(value) {
  return /^\d{4}$/.test(String(value || "").trim());
}

function marketKey(market, ticker) {
  return `${market}:${ticker}`;
}

function dateParam(date) {
  return date.replaceAll("-", "");
}

function tpexDateParam(date) {
  const [year, month, day] = date.split("-").map(Number);
  return `${year - 1911}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
}

function previousCalendarDate(date, offset) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - offset);
  return value.toISOString().slice(0, 10);
}

async function fetchJsonViaPowerShell(url) {
  const command = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $r=Invoke-WebRequest -Uri $env:MARKET_FACTOR_URL -UseBasicParsing -TimeoutSec 45; Write-Output $r.Content";
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
      cwd: root,
      env: { ...process.env, MARKET_FACTOR_URL: url },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(stderr || `PowerShell exited with ${code}`));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(new Error(`PowerShell returned invalid JSON: ${error.message}`));
        }
      }
    });
  });
}

async function fetchOfficialJson(url) {
  const sourceCache = argValue("source-cache", "");
  if (sourceCache) {
    const filename = `${createHash("sha256").update(url).digest("hex")}.json`;
    try {
      return JSON.parse(await readFile(path.join(root, sourceCache, filename), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (process.env.MARKET_FACTOR_FORCE_POWERSHELL === "1") return fetchJsonViaPowerShell(url);
  try {
    return await fetchJson(url, 3, 20000);
  } catch (error) {
    console.warn(`Node fetch failed; using PowerShell fallback for ${url}. ${error.message}`);
    return fetchJsonViaPowerShell(url);
  }
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function pearson(points, leftKey, rightKey) {
  if (points.length < 3) return null;
  const leftMean = mean(points.map((point) => point[leftKey]));
  const rightMean = mean(points.map((point) => point[rightKey]));
  const numerator = points.reduce((sum, point) => sum + (point[leftKey] - leftMean) * (point[rightKey] - rightMean), 0);
  const leftSpread = Math.sqrt(points.reduce((sum, point) => sum + (point[leftKey] - leftMean) ** 2, 0));
  const rightSpread = Math.sqrt(points.reduce((sum, point) => sum + (point[rightKey] - rightMean) ** 2, 0));
  return leftSpread && rightSpread ? numerator / (leftSpread * rightSpread) : null;
}

function ranks(values) {
  const indexed = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
  const result = Array(values.length);
  for (let start = 0; start < indexed.length;) {
    let end = start;
    while (end + 1 < indexed.length && indexed[end + 1].value === indexed[start].value) end += 1;
    const rank = (start + end + 2) / 2;
    for (let position = start; position <= end; position += 1) result[indexed[position].index] = rank;
    start = end + 1;
  }
  return result;
}

function spearman(points, leftKey, rightKey) {
  if (points.length < 3) return null;
  const leftRanks = ranks(points.map((point) => point[leftKey]));
  const rightRanks = ranks(points.map((point) => point[rightKey]));
  return pearson(leftRanks.map((value, index) => ({ left: value, right: rightRanks[index] })), "left", "right");
}

function partialCorrelation(points, factorKey) {
  const rxy = pearson(points, factorKey, "relative_return_pct");
  const rxz = pearson(points, factorKey, "base_score");
  const ryz = pearson(points, "relative_return_pct", "base_score");
  if (![rxy, rxz, ryz].every(Number.isFinite)) return null;
  const denominator = Math.sqrt((1 - rxz ** 2) * (1 - ryz ** 2));
  return denominator ? (rxy - rxz * ryz) / denominator : null;
}

function percentile(value, values) {
  const comparable = values.filter(Number.isFinite);
  if (!Number.isFinite(value) || comparable.length < 10) return null;
  return round(comparable.filter((item) => item <= value).length / comparable.length * 100, 0);
}

function tableRows(payload, tableIndex = 0) {
  const table = payload?.tables?.[tableIndex];
  const fields = table?.fields || [];
  if (!Array.isArray(fields) || !Array.isArray(table?.data)) return [];
  return table.data.map((values) => Object.fromEntries(fields.map((field, index) => [field, values[index]])));
}

function sourceRowCount(payload) {
  if (Array.isArray(payload)) return payload.length;
  if (Array.isArray(payload?.data)) return payload.data.length;
  return payload?.tables?.[1]?.data?.length || payload?.tables?.[0]?.data?.length || 0;
}

function codeFrom(row, fields) {
  for (const field of fields) {
    const value = String(row?.[field] || "").trim();
    if (validTicker(value)) return value;
  }
  return null;
}

function numberFrom(row, fields) {
  for (const field of fields) {
    const value = toNumber(row?.[field]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function normalizeTwseValuation(rows) {
  return rows.map((row) => ({
    ticker: String(row.Code || "").trim(),
    pe_ratio: toNumber(row.PEratio),
    pb_ratio: toNumber(row.PBratio),
    dividend_yield_pct: toNumber(row.DividendYield)
  })).filter((row) => validTicker(row.ticker));
}

function normalizeTpexValuation(payload) {
  return tableRows(payload).map((row) => ({
    ticker: codeFrom(row, ["股票代號", "代號"]),
    pe_ratio: numberFrom(row, ["本益比"]),
    pb_ratio: numberFrom(row, ["股價淨值比"]),
    dividend_yield_pct: numberFrom(row, ["殖利率(%)"])
  })).filter((row) => row.ticker);
}

function normalizeTwseMargin(payload) {
  const rows = payload?.tables?.[1]?.data || [];
  return rows.map((values) => ({
    ticker: validTicker(values?.[0]) ? String(values[0]).trim() : null,
    financing_change_lots: (() => {
      const previous = toNumber(values?.[4]);
      const current = toNumber(values?.[5]);
      return Number.isFinite(previous) && Number.isFinite(current) ? current - previous : null;
    })(),
    short_change_lots: (() => {
      const previous = toNumber(values?.[11]);
      const current = toNumber(values?.[12]);
      return Number.isFinite(previous) && Number.isFinite(current) ? current - previous : null;
    })()
  })).filter((row) => row.ticker);
}

function normalizeTpexMargin(payload) {
  return tableRows(payload).map((row) => ({
    ticker: codeFrom(row, ["代號", "股票代號"]),
    financing_change_lots: (() => {
      const previous = numberFrom(row, ["前資餘額(張)"]);
      const current = numberFrom(row, ["資餘額"]);
      return Number.isFinite(previous) && Number.isFinite(current) ? current - previous : null;
    })(),
    short_change_lots: (() => {
      const previous = numberFrom(row, ["前券餘額(張)"]);
      const current = numberFrom(row, ["券餘額"]);
      return Number.isFinite(previous) && Number.isFinite(current) ? current - previous : null;
    })()
  })).filter((row) => row.ticker);
}

function normalizeTwseInstitutional(payload) {
  return (payload?.data || []).map((values) => Object.fromEntries((payload.fields || []).map((field, index) => [field, values[index]])))
    .map((row) => ({
      ticker: codeFrom(row, ["證券代號", "股票代號"]),
      total_net_shares: numberFrom(row, ["三大法人買賣超股數"])
    })).filter((row) => row.ticker);
}

function normalizeTpexInstitutional(payload) {
  return (payload?.tables?.[0]?.data || []).map((values) => ({
    ticker: validTicker(values?.[0]) ? String(values[0]).trim() : null,
    total_net_shares: toNumber(values?.[23])
  })).filter((row) => row.ticker);
}

function normalizeTwseDailyVolume(payload) {
  return tableRows(payload, 8).map((row) => ({
    ticker: codeFrom(row, ["證券代號"]),
    volume_shares: numberFrom(row, ["成交股數"])
  })).filter((row) => row.ticker && Number.isFinite(row.volume_shares));
}

function normalizeTpexDailyVolume(payload) {
  return tableRows(payload).map((row) => ({
    ticker: codeFrom(row, ["代號"]),
    volume_shares: numberFrom(row, ["成交股數"])
  })).filter((row) => row.ticker && Number.isFinite(row.volume_shares));
}

function indexRows(rows) {
  return new Map(rows.map((row) => [row.ticker, row]));
}

function groupUniverse(universe) {
  const groups = new Map();
  for (const company of universe) {
    const key = company.official_industry_label || company.official_industry_code || "未分類";
    groups.set(key, [...(groups.get(key) || []), company]);
  }
  return groups;
}

function buildMarketFactors(universe, payloads, volumeHistory) {
  const valuation = {
    TWSE: indexRows(normalizeTwseValuation(payloads.twseValuation)),
    TPEx: indexRows(normalizeTpexValuation(payloads.tpexValuation))
  };
  const margin = {
    TWSE: indexRows(normalizeTwseMargin(payloads.twseMargin)),
    TPEx: indexRows(normalizeTpexMargin(payloads.tpexMargin))
  };
  const institutional = {
    TWSE: indexRows(normalizeTwseInstitutional(payloads.twseInstitutional)),
    TPEx: indexRows(normalizeTpexInstitutional(payloads.tpexInstitutional))
  };
  const volumeByDate = volumeHistory.map((day) => ({
    TWSE: indexRows(normalizeTwseDailyVolume(day.payloads.twseDailyVolume)),
    TPEx: indexRows(normalizeTpexDailyVolume(day.payloads.tpexDailyVolume))
  }));
  const groups = groupUniverse(universe);
  const factors = new Map();

  for (const company of universe) {
    const peers = groups.get(company.official_industry_label || company.official_industry_code || "未分類") || [];
    const peerValuation = peers.map((item) => valuation[item.market]?.get(item.ticker)).filter(Boolean);
    const peerInstitutional = peers.map((item) => institutional[item.market]?.get(item.ticker)?.total_net_shares).filter(Number.isFinite);
    const peerFinancing = peers.map((item) => margin[item.market]?.get(item.ticker)?.financing_change_lots).filter(Number.isFinite);
    const peerShort = peers.map((item) => margin[item.market]?.get(item.ticker)?.short_change_lots).filter(Number.isFinite);
    const volumeRatioFor = (item) => {
      const current = volumeByDate.at(-1)?.[item.market]?.get(item.ticker)?.volume_shares;
      const history = volumeByDate.slice(0, -1)
        .map((day) => day[item.market]?.get(item.ticker)?.volume_shares)
        .filter(Number.isFinite);
      const baseline = mean(history);
      return Number.isFinite(current) && Number.isFinite(baseline) && baseline > 0 ? current / baseline : null;
    };
    const peerVolumeRatios = peers.map(volumeRatioFor).filter(Number.isFinite);
    const currentValuation = valuation[company.market]?.get(company.ticker);
    const currentMargin = margin[company.market]?.get(company.ticker);
    const currentInstitutional = institutional[company.market]?.get(company.ticker);
    const volumeRatio20d = volumeRatioFor(company);
    const valuationComponents = currentValuation ? [
      // Lower PE/PB and higher yield are treated as favourable only for this diagnostic.
      Number.isFinite(currentValuation.pe_ratio) ? 100 - percentile(currentValuation.pe_ratio, peerValuation.map((item) => item.pe_ratio)) : null,
      Number.isFinite(currentValuation.pb_ratio) ? 100 - percentile(currentValuation.pb_ratio, peerValuation.map((item) => item.pb_ratio)) : null,
      percentile(currentValuation.dividend_yield_pct, peerValuation.map((item) => item.dividend_yield_pct))
    ].filter(Number.isFinite) : [];
    factors.set(marketKey(company.market, company.ticker), {
      peer_count: peers.length,
      valuation_favorable_pct: valuationComponents.length >= 2 ? round(mean(valuationComponents), 1) : null,
      institutional_net_percentile: percentile(currentInstitutional?.total_net_shares, peerInstitutional),
      financing_change_percentile: percentile(currentMargin?.financing_change_lots, peerFinancing),
      short_change_percentile: percentile(currentMargin?.short_change_lots, peerShort),
      volume_activity_percentile: percentile(volumeRatio20d, peerVolumeRatios),
      raw: {
        pe_ratio: currentValuation?.pe_ratio ?? null,
        pb_ratio: currentValuation?.pb_ratio ?? null,
        dividend_yield_pct: currentValuation?.dividend_yield_pct ?? null,
        institutional_net_shares: currentInstitutional?.total_net_shares ?? null,
        financing_change_lots: currentMargin?.financing_change_lots ?? null,
        short_change_lots: currentMargin?.short_change_lots ?? null,
        volume_ratio_20d: Number.isFinite(volumeRatio20d) ? round(volumeRatio20d, 2) : null
      }
    });
  }
  return factors;
}

async function fetchHistoricalPayloads(date) {
  for (let offset = 0; offset < 7; offset += 1) {
    const sourceDate = previousCalendarDate(date, offset);
    const twseDate = dateParam(sourceDate);
    const tpexDate = tpexDateParam(sourceDate);
    const urls = {
      twseValuation: `https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_d?date=${twseDate}`,
      tpexValuation: `https://www.tpex.org.tw/web/stock/aftertrading/peratio_analysis/pera_result.php?l=zh-tw&o=json&d=${encodeURIComponent(tpexDate)}&s=0`,
      twseMargin: `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${twseDate}&selectType=ALL&response=json`,
      tpexMargin: `https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d=${encodeURIComponent(tpexDate)}`,
      twseInstitutional: `https://www.twse.com.tw/rwd/zh/fund/T86?date=${twseDate}&selectType=ALLBUT0999&response=json`,
      tpexInstitutional: `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&d=${encodeURIComponent(tpexDate)}&se=AL`
    };
    const entries = await Promise.all(Object.entries(urls).map(async ([id, url]) => [id, await fetchOfficialJson(url)]));
    const payloads = Object.fromEntries(entries);
    const hasTpexValuation = (payloads.tpexValuation?.tables?.[0]?.data || []).length > 0;
    const hasTwseMargin = (payloads.twseMargin?.tables?.[1]?.data || []).length > 0;
    const hasTwseInstitutional = (payloads.twseInstitutional?.data || []).length > 0;
    if (hasTpexValuation && hasTwseMargin && hasTwseInstitutional) return { payloads, urls, sourceDate };
  }
  throw new Error(`No complete market-data trading day was found on or before ${date}.`);
}

async function fetchFullMarketVolume(date) {
  const twseDate = dateParam(date);
  const tpexDate = tpexDateParam(date);
  const urls = {
    twseDailyVolume: `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${twseDate}&type=ALLBUT0999&response=json`,
    tpexDailyVolume: `https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&o=json&d=${encodeURIComponent(tpexDate)}`
  };
  const payloads = Object.fromEntries(await Promise.all(Object.entries(urls).map(async ([id, url]) => [id, await fetchOfficialJson(url)])));
  const rows = {
    twse: normalizeTwseDailyVolume(payloads.twseDailyVolume).length,
    tpex: normalizeTpexDailyVolume(payloads.tpexDailyVolume).length
  };
  return { date, urls, payloads, rows };
}

async function fetchVolumeHistory(asOfDate, requiredDays = 21) {
  const history = [];
  for (let offset = 0; offset < 45 && history.length < requiredDays; offset += 1) {
    const date = previousCalendarDate(asOfDate, offset);
    const day = await fetchFullMarketVolume(date);
    // TPEx includes roughly 900 four-digit listed companies; the raw table also carries funds and other instruments.
    if (day.rows.twse > 1000 && day.rows.tpex > 700) history.push(day);
  }
  if (history.length < requiredDays) throw new Error(`Only ${history.length}/${requiredDays} historical full-market volume days were available by ${asOfDate}.`);
  return history.reverse();
}

function topBottomSpread(rows, factorKey) {
  const groups = new Map();
  for (const row of rows) groups.set(row.observation_date, [...(groups.get(row.observation_date) || []), row]);
  const top = [];
  const bottom = [];
  for (const dateRows of groups.values()) {
    const sorted = [...dateRows].sort((left, right) => left[factorKey] - right[factorKey]);
    const size = Math.max(1, Math.floor(sorted.length / 5));
    bottom.push(...sorted.slice(0, size));
    top.push(...sorted.slice(-size));
  }
  const topAverage = mean(top.map((row) => row.relative_return_pct));
  const bottomAverage = mean(bottom.map((row) => row.relative_return_pct));
  return {
    top_count: top.length,
    bottom_count: bottom.length,
    top_average_relative_return_pct: round(topAverage),
    bottom_average_relative_return_pct: round(bottomAverage),
    spread_pct: round(topAverage - bottomAverage),
    top_positive_relative_hit_pct: round(top.filter((row) => row.relative_return_pct > 0).length / top.length * 100, 1)
  };
}

function metrics(rows, factor) {
  const eligible = rows.filter((row) => Number.isFinite(row[factor.id]) && Number.isFinite(row.relative_return_pct) && Number.isFinite(row.base_score));
  const byDate = Object.fromEntries([...new Set(eligible.map((row) => row.observation_date))].map((date) => {
    const dateRows = eligible.filter((row) => row.observation_date === date);
    return [date, {
      count: dateRows.length,
      spearman: round(spearman(dateRows, factor.id, "relative_return_pct"), 3),
      spread_pct: topBottomSpread(dateRows, factor.id).spread_pct
    }];
  }));
  return {
    label: factor.label,
    direction: factor.direction,
    coverage_count: eligible.length,
    coverage_pct: round(eligible.length / rows.length * 100, 1),
    spearman_relative_return: round(spearman(eligible, factor.id, "relative_return_pct"), 3),
    partial_correlation_after_base_score: round(partialCorrelation(eligible, factor.id), 3),
    top_bottom_quintile: topBottomSpread(eligible, factor.id),
    by_observation_date: byDate
  };
}

async function main() {
  const backtestId = argValue("backtest-id", defaultBacktestId);
  const inputPath = path.join(root, "backtests", argValue("input", "full-six-140-2026-h1"), "snapshots.json");
  const outputDir = path.join(root, "backtests", backtestId);
  const [snapshotPayload, universePayload] = await Promise.all([
    JSON.parse(await readFile(inputPath, "utf8")),
    readJson(path.join(dataDir, "listed_companies_universe.json"))
  ]);
  const requestedDates = new Set(argValue("observation-dates", "").split(",").map((date) => date.trim()).filter(Boolean));
  const snapshots = (snapshotPayload.snapshots || []).filter((snapshot) => !requestedDates.size || requestedDates.has(snapshot.observation_date));
  if (!snapshots.length) throw new Error("No snapshots matched --observation-dates.");
  const observationDates = [...new Set(snapshots.map((snapshot) => snapshot.observation_date).filter(Boolean))].sort();
  const factorByDate = new Map();
  const sourceRequests = {};
  for (const date of observationDates) {
    console.log(`Fetching core market factors for ${date}.`);
    const { payloads, urls, sourceDate } = await fetchHistoricalPayloads(date);
    const volumeHistory = await fetchVolumeHistory(sourceDate);
    factorByDate.set(date, buildMarketFactors(universePayload.companies || [], payloads, volumeHistory));
    sourceRequests[date] = Object.fromEntries(Object.entries(payloads).map(([id, payload]) => [id, {
      url: urls[id],
      source_date: sourceDate,
      rows: sourceRowCount(payload)
    }]));
    sourceRequests[date].volume_history = {
      calculation: "Observation-day volume divided by the preceding 20 available trading-day average volume.",
      trading_dates: volumeHistory.map((day) => day.date),
      rows_per_day: volumeHistory.map((day) => ({ date: day.date, ...day.rows })),
      urls: volumeHistory.map((day) => ({ date: day.date, ...day.urls }))
    };
    console.log(`Collected historical market factors for ${date} using ${sourceDate}.`);
  }

  const baseRows = snapshots.map((snapshot) => ({
    observation_date: snapshot.observation_date,
    ticker: snapshot.company?.ticker,
    market: snapshot.company?.market,
    name: snapshot.company?.name,
    base_score: Number.isFinite(snapshot.score) ? snapshot.score : null,
    forward_return_pct: snapshot.outcomes?.return_20d_pct ?? null,
    factors: factorByDate.get(snapshot.observation_date)?.get(marketKey(snapshot.company?.market, snapshot.company?.ticker)) || null
  })).filter((row) => Number.isFinite(row.forward_return_pct));
  const relativeMeans = new Map(observationDates.map((date) => [date, mean(baseRows.filter((row) => row.observation_date === date).map((row) => row.forward_return_pct))]));
  const rows = baseRows.map((row) => ({
    ...row,
    relative_return_pct: round(row.forward_return_pct - relativeMeans.get(row.observation_date)),
    ...(row.factors || {})
  }));
  const report = {
    version: "1.0.0",
    generated_at: new Date().toISOString(),
    backtest_id: backtestId,
    methodology: {
      input_snapshot_file: inputPath,
      observation_dates: observationDates,
      forward_horizon: "20 trading days",
      relative_return: "Same-observation-date company return minus the cross-sectional mean return.",
      peer_definition: "All listed and OTC companies sharing the official industry label; values require at least 10 peer observations.",
      volume_factor: "Observation-day volume divided by the preceding 20 available full-market trading-day average volume, then ranked within official-industry peers.",
      guardrail: "Factors are tested independently. This report does not tune or modify the production score."
    },
    source_requests: sourceRequests,
    base_score: {
      coverage_count: rows.filter((row) => Number.isFinite(row.base_score)).length,
      spearman_relative_return: round(spearman(rows.filter((row) => Number.isFinite(row.base_score)), "base_score", "relative_return_pct"), 3),
      top_bottom_quintile: topBottomSpread(rows.filter((row) => Number.isFinite(row.base_score)), "base_score")
    },
    factors: Object.fromEntries(factorDefinitions.map((factor) => [factor.id, metrics(rows, factor)])),
    rows
  };
  await mkdir(outputDir, { recursive: true });
  await writeJson(path.join(outputDir, "report.json"), report);
  await writeJson(path.join(outputDir, "rows.json"), { generated_at: report.generated_at, rows });
  console.log(JSON.stringify({ outputDir, observations: rows.length, factors: Object.keys(report.factors) }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
}
