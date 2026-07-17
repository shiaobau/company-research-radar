import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  average,
  clamp,
  readJson,
  rocDateToIso,
  rocMonthToIso,
  round,
  scoreByThresholds,
  toNumber,
  tpexDateParam,
  twDateParam,
  writeJson
} from "./data-sources.mjs";
import { getCachedRows } from "./source-cache.mjs";
import { classifyMaterialEvents, loadEventTaxonomy, scoreRiskDimension } from "./event-risk.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const startDate = argValue("start", "2026-06-09");
const endDate = argValue("end", "2026-07-09");
const backtestId = argValue("backtest-id", `${startDate}_to_${endDate}_15_templates`);
const referenceOnly = argValue("reference-only", "false") === "true";
const outDir = path.join(root, "backtests", backtestId);
const cohortPath = path.resolve(root, argValue("cohort", path.join("backtests", backtestId, "cohort.json")));
const generatedAt = new Date().toISOString();
let scoreBands = [
  { id: "priority", min: 75, label: "優先觀察" },
  { id: "monitor", min: 55, label: "持續追蹤" },
  { id: "defer", min: 0, label: "訊號待確認" }
];
let scoreCalibration = null;
let eventTaxonomy = null;
let riskDimensionDefinition = null;
let coreWeights = {};

const SCORE_DIMENSIONS = [
  { id: "catalyst", label: "催化事件", weight: 0.2 },
  { id: "revenueMomentum", label: "營收動能", weight: 0.18 },
  { id: "cashProfitQuality", label: "現金/獲利品質", weight: 0.17 },
  { id: "priceTrend", label: "股價趨勢", weight: 0.15 },
  { id: "ownership", label: "籌碼/治理結構", weight: 0.1 },
  { id: "riskNews", label: "風險與重大訊息", weight: 0.1 }
];

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function getJsonWithPowerShell(url) {
  await mkdir(outDir, { recursive: true });
  const tempFile = path.join(outDir, `.price-fetch-${process.pid}-${Date.now()}.json`);
  const command = "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri $env:CODEX_FETCH_URL -UseBasicParsing -TimeoutSec 35 -OutFile $env:CODEX_FETCH_OUT";
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
        cwd: root,
        env: { ...process.env, CODEX_FETCH_URL: url, CODEX_FETCH_OUT: tempFile },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stderr = "";
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`PowerShell timeout for ${url}`));
      }, 50000);
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("exit", (code) => finish(code === 0 ? null : new Error(stderr || `PowerShell exited with ${code}`)));
      child.on("error", finish);
    });
    return JSON.parse(await readFile(tempFile, "utf8"));
  } finally {
    await unlink(tempFile).catch(() => {});
  }
}

async function getJsonFast(url, timeoutMs = 15000, redirects = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json,text/plain,*/*",
        "user-agent": "company-research-radar/0.9"
      },
      redirect: "manual",
      signal: controller.signal
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location") && redirects < 3) {
      const nextUrl = new URL(response.headers.get("location"), url).toString();
      return getJsonFast(nextUrl, timeoutMs, redirects + 1);
    }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function keyIncludes(row, terms, excludes = []) {
  return Object.keys(row || {}).find((key) => {
    return terms.every((term) => key.includes(term)) && excludes.every((term) => !key.includes(term));
  });
}

function valueByKey(row, terms, excludes = []) {
  const key = keyIncludes(row, terms, excludes);
  return key ? row[key] : null;
}

function codeOf(row) {
  return row?.["公司代號"] || row?.SecuritiesCompanyCode || valueByKey(row, ["代號"]) || "";
}

function nameOf(company) {
  return company.name || company.abbreviation || company.legal_name || company.ticker;
}

function normalizeUrl(url) {
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function companyId(company) {
  return `${company.market === "TPEx" ? "tpex" : "twse"}-${company.ticker}`;
}

function monthStartsBetween(start, end) {
  const startAt = new Date(`${start}T00:00:00Z`);
  startAt.setUTCMonth(startAt.getUTCMonth() - 3);
  startAt.setUTCDate(1);
  const endAt = new Date(`${end}T00:00:00Z`);
  endAt.setUTCDate(1);
  const months = [];
  for (let d = new Date(startAt); d <= endAt; d.setUTCMonth(d.getUTCMonth() + 1)) {
    months.push(new Date(d));
  }
  return months;
}

function isoToYmd(date) {
  return String(date).replace(/-/g, "");
}

function pricePositionScore(positionPct) {
  if (!Number.isFinite(positionPct)) return 50;
  if (positionPct <= 15) return 45;
  if (positionPct <= 35) return 60;
  if (positionPct <= 70) return 72;
  if (positionPct <= 90) return 65;
  return 55;
}

function return20Score(value) {
  return scoreByThresholds(value, [[10, 78], [3, 68], [0, 60], [-5, 52], [-999, 42]], 50);
}

function return60Score(value) {
  return scoreByThresholds(value, [[20, 80], [5, 70], [0, 60], [-10, 50], [-999, 38]], 50);
}

function revenueScoreFrom(row) {
  if (!row) return 50;
  const yoy = toNumber(valueByKey(row, ["去年", "增減"], ["累計"]));
  const mom = toNumber(valueByKey(row, ["上月", "增減"], ["累計"]));
  const cumulativeYoy = toNumber(valueByKey(row, ["累計", "增減"]));
  const yoyScore = scoreByThresholds(yoy, [[20, 85], [10, 75], [3, 65], [0, 58], [-10, 48], [-999, 35]], 45);
  const momScore = scoreByThresholds(mom, [[10, 70], [0, 58], [-10, 50], [-999, 42]], 50);
  const cumulativeScore = scoreByThresholds(cumulativeYoy, [[15, 82], [8, 72], [3, 64], [0, 58], [-10, 48], [-999, 35]], 45);
  return Math.round(yoyScore * 0.5 + momScore * 0.2 + cumulativeScore * 0.3);
}

function marginScore(value, thresholds) {
  return scoreByThresholds(value, thresholds, 45);
}

function financialScoreFrom(income, balance) {
  if (!income && !balance) return { score: 50 };
  const revenue = toNumber(valueByKey(income, ["營業收入"], ["累計"]));
  const grossProfit = toNumber(valueByKey(income, ["營業毛利"])) ?? toNumber(valueByKey(income, ["毛利"]));
  const operatingIncome = toNumber(valueByKey(income, ["營業利益"]));
  const netIncome = toNumber(valueByKey(income, ["本期淨利"])) ?? toNumber(valueByKey(income, ["稅後淨利"]));
  const eps = toNumber(valueByKey(income, ["每股盈餘"])) ?? toNumber(valueByKey(income, ["EPS"]));
  const currentAssets = toNumber(valueByKey(balance, ["流動資產"]));
  const currentLiabilities = toNumber(valueByKey(balance, ["流動負債"]));
  const totalAssets = toNumber(valueByKey(balance, ["資產總計"])) ?? toNumber(valueByKey(income, ["資產總計"]));
  const totalLiabilities = toNumber(valueByKey(balance, ["負債總計"])) ?? toNumber(valueByKey(income, ["負債總計"]));

  const grossMargin = revenue ? (grossProfit / revenue) * 100 : null;
  const operatingMargin = revenue ? (operatingIncome / revenue) * 100 : null;
  const netMargin = revenue ? (netIncome / revenue) * 100 : null;
  const currentRatio = currentLiabilities ? currentAssets / currentLiabilities : null;
  const debtRatio = totalAssets ? (totalLiabilities / totalAssets) * 100 : null;

  const grossScore = marginScore(grossMargin, [[50, 85], [35, 75], [25, 65], [15, 55], [-999, 45]]);
  const opScore = marginScore(operatingMargin, [[20, 85], [10, 75], [5, 65], [0, 55], [-999, 35]]);
  const netScore = marginScore(netMargin, [[15, 80], [8, 70], [0, 58], [-999, 35]]);
  const liquidityScore = scoreByThresholds(currentRatio, [[2, 75], [1.2, 65], [1, 55], [-999, 40]], 50);
  const debtScore = Number.isFinite(debtRatio)
    ? debtRatio <= 30 ? 75 : debtRatio <= 50 ? 65 : debtRatio <= 70 ? 55 : 40
    : 50;
  const epsScore = Number.isFinite(eps) ? (eps > 0 ? 65 : 40) : 50;

  return {
    score: clamp(Math.round(grossScore * 0.2 + opScore * 0.25 + netScore * 0.15 + liquidityScore * 0.15 + debtScore * 0.15 + epsScore * 0.1)),
    gross_margin_pct: round(grossMargin),
    operating_margin_pct: round(operatingMargin),
    net_margin_pct: round(netMargin),
    current_ratio: round(currentRatio),
    debt_ratio_pct: round(debtRatio),
    eps: round(eps, 2)
  };
}

function dateFromRow(row) {
  const value = valueByKey(row, ["發言", "日期"]) || valueByKey(row, ["公告", "日期"]) || valueByKey(row, ["日期"]);
  if (!value) return null;
  const text = String(value).trim();
  if (text.includes("/")) return rocDateToIso(text);
  const compact = text.replace(/\D/g, "");
  if (compact.length === 7) {
    const year = Number(compact.slice(0, 3)) + 1911;
    return `${year}-${compact.slice(3, 5)}-${compact.slice(5, 7)}`;
  }
  if (compact.length === 8) return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  return null;
}

function eventTitle(row) {
  return String(
    valueByKey(row, ["主旨"]) ||
    valueByKey(row, ["重大訊息"]) ||
    valueByKey(row, ["標題"]) ||
    valueByKey(row, ["說明"]) ||
    ""
  ).replace(/\s+/g, " ").trim();
}

const positiveKeywords = ["增資", "授權", "取得", "核准", "合作", "新產品", "訂單", "合約", "營收成長", "獲利", "通過", "併購"];
const negativeKeywords = ["處分", "裁罰", "違反", "虧損", "訴訟", "減損", "終止", "解約", "下修", "停工", "召回", "警示"];

function classifyEventsLegacy(events) {
  let positive = 0;
  let negative = 0;
  const tagged = events.map((event) => {
    const text = `${event.title} ${event.description || ""}`;
    const pos = positiveKeywords.some((keyword) => text.includes(keyword));
    const neg = negativeKeywords.some((keyword) => text.includes(keyword));
    if (pos && !neg) positive += 1;
    if (neg) negative += 1;
    return { ...event, sentiment: neg ? "negative" : pos ? "positive" : "neutral" };
  });
  return { events: tagged, positive, negative };
}

function classifyEvents(events) {
  const classifiedRisk = classifyMaterialEvents(events, eventTaxonomy);
  let positive = 0;
  const tagged = classifiedRisk.events.map((event) => {
    const text = `${event.title} ${event.description || ""}`;
    const positiveHit = event.risk_class === "neutral" && positiveKeywords.some((keyword) => text.includes(keyword));
    if (positiveHit) positive += 1;
    return { ...event, sentiment: positiveHit ? "positive" : event.sentiment };
  });
  return {
    ...classifiedRisk,
    events: tagged,
    positive,
    negative: classifiedRisk.negative_event_count,
    review: classifiedRisk.review_event_count
  };
}

function catalystScore({ events, revenueScore, financialScore }) {
  const classified = classifyEvents(events);
  let score = 45;
  if (revenueScore >= 80) score += 20;
  else if (revenueScore >= 70) score += 14;
  else if (revenueScore >= 60) score += 8;
  if (financialScore >= 75) score += 12;
  else if (financialScore >= 65) score += 8;
  score += Math.min(classified.positive * 8, 20);
  score += events.length ? 3 : 0;
  score -= Math.min(classified.negative * 6, 18);
  return clamp(Math.round(score), 30, 90);
}

function riskScore({ events, violations }) {
  const classified = classifyEvents(events);
  return scoreRiskDimension({
    negative_event_points: classified.negative_event_points,
    review_event_count: classified.review_event_count,
    disclosure_violation_count: violations?.length || 0
  }, riskDimensionDefinition) ?? 50;
}

function ownershipScore({ holders, insiderTransfers, violations }) {
  let score = 55;
  if (holders.length) score += 10;
  if (!insiderTransfers.length) score += 8;
  if (insiderTransfers.length) score -= Math.min(insiderTransfers.length * 10, 25);
  if (violations.length) score -= Math.min(violations.length * 15, 30);
  return clamp(Math.round(score), 30, 80);
}

function industryDimensionScore(id, context) {
  const { revenueScore, financialScore, riskScoreValue, catalystScoreValue, ownershipScoreValue, traceability } = context;
  const text = id.toLowerCase();
  let score = 52 + traceability * 0.12;
  if (/revenue|order|sales|channel|brand|project|pipeline|backlog|contract/.test(text)) {
    score = score * 0.45 + revenueScore * 0.4 + catalystScoreValue * 0.15;
  } else if (/margin|cash|capital|asset|balance|spread|cost|capacity|utilization|interest|fee/.test(text)) {
    score = score * 0.4 + financialScore * 0.45 + revenueScore * 0.15;
  } else if (/risk|compliance|recall|regulatory|safety|permit|environment|tfda|tariff/.test(text)) {
    score = score * 0.35 + riskScoreValue * 0.5 + ownershipScoreValue * 0.15;
  } else if (/technology|customer|clinical|model|data|deployment|product|platform|ev|auto|partner|quality/.test(text)) {
    score = score * 0.45 + catalystScoreValue * 0.25 + revenueScore * 0.2 + financialScore * 0.1;
  } else {
    score = score * 0.35 + revenueScore * 0.25 + financialScore * 0.25 + riskScoreValue * 0.15;
  }
  return clamp(Math.round(score), 35, 82);
}

function industryScore(company, template, context) {
  const dimensions = template?.industry_evidence_dimensions || [];
  if (!dimensions.length) return context.traceability;
  let weighted = 0;
  let weightSum = 0;
  const rows = dimensions.map((dimension) => {
    const score = industryDimensionScore(dimension.id, context);
    weighted += score * (dimension.weight || 0);
    weightSum += dimension.weight || 0;
    return {
      id: dimension.id,
      label: dimension.label,
      weight: dimension.weight,
      score,
      rationale: `以 ${company.template_label || template?.label || company.industry_template} 模板，混合公開財務、營收、風險、催化與資料可追蹤性估算。`
    };
  });
  return {
    score: weightSum ? clamp(Math.round(weighted / weightSum)) : context.traceability,
    dimensions: rows
  };
}

function scorePriceAt(history, cutoffDate) {
  const filtered = history.filter((row) => row.date <= cutoffDate);
  const closes = filtered.map((row) => row.close).filter(Number.isFinite);
  const latest = filtered.at(-1);
  if (!latest || !closes.length) return { score: 50, status: "missing" };
  const yearHigh = Math.max(...closes);
  const yearLow = Math.min(...closes);
  const rangeHistory = yearHigh && yearLow && yearHigh / yearLow > 4 ? filtered.slice(-60) : filtered;
  const rangeCloses = rangeHistory.map((row) => row.close).filter(Number.isFinite);
  const scoringHigh = Math.max(...rangeCloses);
  const scoringLow = Math.min(...rangeCloses);
  const positionPct = scoringHigh !== scoringLow ? ((latest.close - scoringLow) / (scoringHigh - scoringLow)) * 100 : null;
  const close20 = closes.length > 20 ? closes.at(-21) : null;
  const close60 = closes.length > 60 ? closes.at(-61) : null;
  const return20d = close20 ? ((latest.close / close20) - 1) * 100 : null;
  const return60d = close60 ? ((latest.close / close60) - 1) * 100 : null;
  const score = Math.round(pricePositionScore(positionPct) * 0.4 + return20Score(return20d) * 0.3 + return60Score(return60d) * 0.3);
  return {
    status: "ok",
    trade_date: latest.date,
    close: latest.close,
    score: clamp(score),
    position_pct: round(positionPct),
    ma20: round(average(closes.slice(-20))),
    ma60: round(average(closes.slice(-60))),
    return_20d_pct: round(return20d),
    return_60d_pct: round(return60d)
  };
}

function computeRawTotal(scores) {
  const weighted = SCORE_DIMENSIONS.reduce((sum, dimension) => sum + (scores[dimension.id] || 0) * (coreWeights[dimension.id] || 0), 0);
  const weightSum = Object.values(coreWeights).reduce((sum, weight) => sum + weight, 0);
  return Math.round(weighted / weightSum);
}

function calibrateScore(rawScore) {
  const anchors = (scoreCalibration?.anchors || [])
    .map((anchor) => ({ raw: Number(anchor.raw), display: Number(anchor.display) }))
    .filter((anchor) => Number.isFinite(anchor.raw) && Number.isFinite(anchor.display))
    .sort((left, right) => left.raw - right.raw);
  if (!anchors.length) return Math.round(rawScore);
  if (rawScore <= anchors[0].raw) return Math.round(anchors[0].display);
  for (let index = 1; index < anchors.length; index += 1) {
    const lower = anchors[index - 1];
    const upper = anchors[index];
    if (rawScore <= upper.raw) {
      const progress = (rawScore - lower.raw) / (upper.raw - lower.raw);
      return Math.round(lower.display + (upper.display - lower.display) * progress);
    }
  }
  return Math.round(anchors.at(-1).display);
}

function band(score) {
  return scoreBands.find((item) => score >= item.min)?.label || scoreBands.at(-1)?.label || "未分級";
}

function dataCoverage(row) {
  const weights = {
    price: 0.35,
    revenue: 0.2,
    financial: 0.2,
    events: 0.15,
    governance: 0.1
  };
  const score = Object.entries(weights).reduce((sum, [key, weight]) => {
    const status = row.evidence_status?.[key];
    if (status === "ok") return sum + weight;
    if (status === "partial") return sum + weight * 0.45;
    if (status === "none") return sum + weight * 0.2;
    return sum;
  }, 0);
  return round(score, 3);
}

function coverageLevel(coverage) {
  if (coverage >= 0.75) return "high";
  if (coverage >= 0.55) return "medium";
  return "low";
}

function predictionSignal(row) {
  if ((row.data_coverage_score ?? 0) < 0.55) return "insufficient";
  if (row.as_of_score >= scoreBands[0].min) return "positive";
  if (row.as_of_score >= scoreBands[1].min) return "watch_positive";
  if ((row.data_coverage_score ?? 0) >= 0.75) return "weak";
  return "insufficient";
}

function consistency(row) {
  const coverage = row.data_coverage_score ?? dataCoverage(row);
  const signal = row.prediction_signal || predictionSignal(row);
  const priceReturn = row.outcome.price_return_pct;
  const hasPrice = Number.isFinite(priceReturn);
  const positiveOutcome = (hasPrice && priceReturn >= 5) || row.score_change >= 4 || row.current_dimensions.revenueMomentum >= 65;
  const negativeOutcome = (hasPrice && priceReturn <= -5) || row.score_change <= -4 || row.current_dimensions.riskNews < 60;

  if (coverage < 0.55) return "資料不足";
  if (signal === "positive") {
    if (positiveOutcome && !negativeOutcome) return "符合";
    if (!negativeOutcome) return "部分符合";
    return "不符合";
  }
  if (signal === "watch_positive") {
    if (positiveOutcome && !negativeOutcome) return "符合";
    if (negativeOutcome && !positiveOutcome) return "不符合";
    return "部分符合";
  }
  if (signal === "neutral") {
    if ((hasPrice && Math.abs(priceReturn) <= 5) || (!positiveOutcome && !negativeOutcome)) return "符合";
    return "部分符合";
  }
  if (signal === "weak") {
    if (negativeOutcome && !positiveOutcome) return "符合";
    if (positiveOutcome && !negativeOutcome) return "不符合";
    return "部分符合";
  }
  return "資料不足";
}

function formatPct(value) {
  return Number.isFinite(value) ? `${round(value)}%` : "NA";
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

async function fetchPriceHistory(company) {
  const months = monthStartsBetween(startDate, endDate);
  const rows = [];
  const errors = [];
  for (const month of months) {
    try {
      if (company.market === "TWSE") {
        let payload;
        try {
          payload = await getJsonFast(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${twDateParam(month)}&stockNo=${company.ticker}&response=json`);
        } catch {
          payload = await getJsonFast(`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${twDateParam(month)}&stockNo=${company.ticker}`);
        }
        if (payload.stat === "OK" && Array.isArray(payload.data)) {
          for (const item of payload.data) {
            rows.push({ date: rocDateToIso(item[0]), close: toNumber(item[6]), volume: toNumber(item[1]) });
          }
        }
      } else {
        const payload = await getJsonFast(`https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${company.ticker}&date=${encodeURIComponent(tpexDateParam(month))}&id=&response=json`);
        const table = payload.tables?.[0];
        if (payload.stat === "ok" && Array.isArray(table?.data)) {
          for (const item of table.data) {
            rows.push({ date: rocDateToIso(item[0]), close: toNumber(item[6]), volume: toNumber(item[1]) ? toNumber(item[1]) * 1000 : null });
          }
        }
      }
    } catch (error) {
      errors.push(`${month.toISOString().slice(0, 7)} ${error.message}`);
    }
  }
  const byDate = new Map();
  for (const row of rows) {
    if (row.date && Number.isFinite(row.close)) byDate.set(row.date, row);
  }
  return { history: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)), errors };
}

function parseTwseMiIndex(payload, date) {
  const table = (payload.tables || []).find((item) => {
    const fields = item.fields || [];
    return fields.includes("證券代號") && fields.includes("收盤價");
  });
  if (!table) return new Map();
  const codeIndex = table.fields.indexOf("證券代號");
  const closeIndex = table.fields.indexOf("收盤價");
  const rows = new Map();
  for (const row of table.data || []) {
    const ticker = String(row[codeIndex] || "").trim();
    const close = toNumber(row[closeIndex]);
    if (/^\d{4}$/.test(ticker) && Number.isFinite(close)) {
      rows.set(ticker, { date, close, volume: null, source: "twse_mi_index" });
    }
  }
  return rows;
}

async function fetchTwseMarketFallbacks(dates) {
  const result = new Map();
  for (const date of unique(dates)) {
    try {
      const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${isoToYmd(date)}&type=ALLBUT0999&response=json`;
      result.set(date, parseTwseMiIndex(await getJsonWithPowerShell(url), date));
    } catch (error) {
      console.warn(`WARN: TWSE MI_INDEX fallback failed for ${date}: ${error.message}`);
      result.set(date, new Map());
    }
  }
  return result;
}

function applyTwseMarketFallback(company, priceFetch, fallbackByDate) {
  if (company.market !== "TWSE") return priceFetch;
  const byDate = new Map(priceFetch.history.map((row) => [row.date, row]));
  for (const date of [startDate, endDate]) {
    if (byDate.has(date)) continue;
    const row = fallbackByDate.get(date)?.get(company.ticker);
    if (row) byDate.set(date, row);
  }
  return {
    ...priceFetch,
    history: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  };
}

async function fetchReferenceData() {
  const sources = [
    ["twseRevenue", "twse_monthly_revenue"],
    ["tpexRevenue", "tpex_monthly_revenue"],
    ["twseIncome", "twse_income_statement"],
    ["tpexIncome", "tpex_income_statement"],
    ["twseBalance", "twse_balance_sheet"],
    ["tpexBalance", "tpex_balance_sheet"],
    ["twseEvents", "twse_material_events"],
    ["tpexEvents", "tpex_material_events"],
    ["twseHolders", "twse_major_shareholders"],
    ["tpexHolders", "tpex_major_shareholders"],
    ["twseInsider", "twse_insider_transfer"],
    ["tpexInsider", "tpex_insider_transfer"],
    ["twseViolations", "twse_disclosure_violations"],
    ["tpexViolations", "tpex_disclosure_violations"]
  ];
  const data = {};
  const warnings = [];
  for (const [name, sourceId] of sources) {
    try {
      const value = await getCachedRows(sourceId);
      data[name] = Array.isArray(value) ? value : [];
    } catch (error) {
      data[name] = [];
      warnings.push(`${name} failed: ${error?.message || error} (${sourceId})`);
      console.warn(`WARN: ${warnings.at(-1)}`);
    }
  }

  return {
    warnings,
    revenueRows: [...data.twseRevenue, ...data.tpexRevenue],
    incomeRows: [...data.twseIncome, ...data.tpexIncome],
    balanceRows: [...data.twseBalance, ...data.tpexBalance],
    eventRows: [...data.twseEvents, ...data.tpexEvents],
    holderRows: [...data.twseHolders, ...data.tpexHolders],
    insiderRows: [...data.twseInsider, ...data.tpexInsider],
    violationRows: [...data.twseViolations, ...data.tpexViolations]
  };
}

function normalizeEvent(row) {
  return {
    date: dateFromRow(row),
    title: eventTitle(row),
    description: String(valueByKey(row, ["說明"]) || ""),
    raw: row
  };
}

function rowDateBefore(row, cutoff) {
  const date = dateFromRow(row);
  return !date || date <= cutoff;
}

function rowDateBetween(row, start, end) {
  const date = dateFromRow(row);
  return !date || (date >= start && date <= end);
}

function revenueRecord(company, reference) {
  const row = reference.revenueRows.find((item) => codeOf(item) === company.ticker);
  const dataMonth = rocMonthToIso(valueByKey(row, ["資料年月"]) || valueByKey(row, ["年月"]));
  return {
    row,
    data_month: dataMonth,
    score: revenueScoreFrom(row),
    yoy_pct: round(toNumber(valueByKey(row, ["去年", "增減"], ["累計"]))),
    mom_pct: round(toNumber(valueByKey(row, ["上月", "增減"], ["累計"]))),
    cumulative_yoy_pct: round(toNumber(valueByKey(row, ["累計", "增減"]))),
    current_revenue_thousand_twd: toNumber(valueByKey(row, ["當月營收"], ["去年", "上月", "累計"]))
  };
}

function financialRecord(company, reference) {
  const income = reference.incomeRows.find((item) => codeOf(item) === company.ticker);
  const balance = reference.balanceRows.find((item) => codeOf(item) === company.ticker);
  return financialScoreFrom(income, balance);
}

function governanceRecord(company, reference, cutoff) {
  const holders = reference.holderRows.filter((row) => codeOf(row) === company.ticker && rowDateBefore(row, cutoff));
  const insiderTransfers = reference.insiderRows.filter((row) => codeOf(row) === company.ticker && rowDateBefore(row, cutoff));
  const violations = reference.violationRows.filter((row) => codeOf(row) === company.ticker && rowDateBefore(row, cutoff));
  return {
    holders,
    insiderTransfers,
    violations,
    score: ownershipScore({ holders, insiderTransfers, violations })
  };
}

function traceabilityScore(company) {
  let score = 45;
  if (company.website) score += 8;
  if (company.official_industry_code) score += 8;
  if (company.match_reason) score += 5;
  if (company.market) score += 5;
  return clamp(score, 35, 80);
}

function availableRevenueScore(record, cutoffDate) {
  if (!record.row) return 50;
  if (!record.data_month) return 50;
  const cutoffMonth = cutoffDate.slice(0, 7);
  return record.data_month < cutoffMonth ? record.score : 50;
}

function buildCompanyScores(company, reference, template, priceStart, priceEnd) {
  const revenue = revenueRecord(company, reference);
  const financial = financialRecord(company, reference);
  const eventsToStart = reference.eventRows
    .filter((row) => codeOf(row) === company.ticker && rowDateBefore(row, startDate))
    .map(normalizeEvent)
    .filter((event) => event.title);
  const eventsToEnd = reference.eventRows
    .filter((row) => codeOf(row) === company.ticker && rowDateBefore(row, endDate))
    .map(normalizeEvent)
    .filter((event) => event.title);
  const newEvents = reference.eventRows
    .filter((row) => codeOf(row) === company.ticker && rowDateBetween(row, startDate, endDate))
    .map(normalizeEvent)
    .filter((event) => event.title);
  const governanceStart = governanceRecord(company, reference, startDate);
  const governanceEnd = governanceRecord(company, reference, endDate);
  const traceability = traceabilityScore(company);
  const revenueStartScore = availableRevenueScore(revenue, startDate);
  const revenueEndScore = revenue.row ? revenue.score : 50;
  const financialScore = financial.score ?? 50;
  const catalystStart = catalystScore({ events: eventsToStart, revenueScore: revenueStartScore, financialScore });
  const catalystEnd = catalystScore({ events: eventsToEnd, revenueScore: revenueEndScore, financialScore });
  const riskStart = riskScore({ events: eventsToStart, violations: governanceStart.violations });
  const riskEnd = riskScore({ events: eventsToEnd, violations: governanceEnd.violations });
  const industryStart = industryScore(company, template, {
    revenueScore: revenueStartScore,
    financialScore,
    riskScoreValue: riskStart,
    catalystScoreValue: catalystStart,
    ownershipScoreValue: governanceStart.score,
    traceability
  });
  const industryEnd = industryScore(company, template, {
    revenueScore: revenueEndScore,
    financialScore,
    riskScoreValue: riskEnd,
    catalystScoreValue: catalystEnd,
    ownershipScoreValue: governanceEnd.score,
    traceability
  });

  const asOfDimensions = {
    catalyst: catalystStart,
    revenueMomentum: revenueStartScore,
    cashProfitQuality: financialScore,
    priceTrend: priceStart.score ?? 50,
    ownership: governanceStart.score,
    riskNews: riskStart,
    industryFundamental: industryStart.score
  };
  const currentDimensions = {
    catalyst: catalystEnd,
    revenueMomentum: revenueEndScore,
    cashProfitQuality: financialScore,
    priceTrend: priceEnd.score ?? 50,
    ownership: governanceEnd.score,
    riskNews: riskEnd,
    industryFundamental: industryEnd.score
  };
  const asOfRawScore = computeRawTotal(asOfDimensions);
  const currentRawScore = computeRawTotal(currentDimensions);
  const asOfScore = calibrateScore(asOfRawScore);
  const currentScore = calibrateScore(currentRawScore);
  const priceReturnPct = priceStart.close && priceEnd.close ? ((priceEnd.close / priceStart.close) - 1) * 100 : null;

  const row = {
    company_id: companyId(company),
    ticker: company.ticker,
    name: nameOf(company),
    legal_name: company.legal_name,
    market: company.market,
    official_industry_label: company.official_industry_label,
    industry_template: company.industry_template,
    template_label: template?.label || company.template_label,
    website: normalizeUrl(company.website),
    as_of_date: startDate,
    end_date: endDate,
    as_of_score: asOfScore,
    as_of_raw_score: asOfRawScore,
    as_of_band: band(asOfScore),
    current_score: currentScore,
    current_raw_score: currentRawScore,
    current_band: band(currentScore),
    score_change: currentScore - asOfScore,
    as_of_dimensions: asOfDimensions,
    current_dimensions: currentDimensions,
    industry_evidence: {
      as_of: industryStart,
      current: industryEnd
    },
    outcome: {
      start_trade_date: priceStart.trade_date || null,
      start_close: priceStart.close ?? null,
      end_trade_date: priceEnd.trade_date || null,
      end_close: priceEnd.close ?? null,
      price_return_pct: round(priceReturnPct),
      revenue_data_month: revenue.data_month,
      revenue_yoy_pct: revenue.yoy_pct,
      revenue_mom_pct: revenue.mom_pct,
      new_event_count: newEvents.length,
      new_negative_event_count: classifyEvents(newEvents).negative,
      new_review_event_count: classifyEvents(newEvents).review,
      new_negative_event_points: classifyEvents(newEvents).negative_event_points,
      new_negative_event_categories: classifyEvents(newEvents).negative_event_categories,
      disclosure_violation_count: governanceEnd.violations.length
    },
    evidence_status: {
      price: priceStart.status === "ok" && priceEnd.status === "ok" ? "ok" : "missing",
      revenue: revenue.row ? "ok" : "missing",
      financial: Number.isFinite(financialScore) && financialScore !== 50 ? "ok" : "partial",
      events: eventsToEnd.length ? "ok" : "none",
      governance: governanceEnd.holders.length || governanceEnd.violations.length || governanceEnd.insiderTransfers.length ? "ok" : "partial"
    },
    point_in_time_limits: unique([
      revenue.row && revenue.data_month && revenue.data_month >= startDate.slice(0, 7)
        ? "月營收最新資料晚於回測起點，起點營收分數以中性 50 處理，避免明顯偷看未來。"
        : null,
      "財報與治理資料採用公開 API 可得資料，尚未完整還原回測起點當日的歷史版本。"
    ])
  };
  row.data_coverage_score = dataCoverage(row);
  row.data_coverage_level = coverageLevel(row.data_coverage_score);
  row.prediction_signal = predictionSignal(row);
  row.consistency = consistency(row);
  row.consistency_reason = [
    `起點 ${asOfScore} (${row.as_of_band})`,
    `目前 ${currentScore} (${row.current_band})`,
    `股價 ${formatPct(row.outcome.price_return_pct)}`,
    `分數變化 ${row.score_change >= 0 ? "+" : ""}${row.score_change}`,
    `最新營收分數 ${currentDimensions.revenueMomentum}`,
    `資料覆蓋 ${row.data_coverage_score}`
  ].join("；");
  return row;
}

function markdownTable(rows) {
  const header = "| 股票 | 產業 | 起點分 | 目前分 | 分數變化 | 股價變化 | 覆蓋率 | 訊號 | 判定 |\n|---|---|---:|---:|---:|---:|---:|---|---|";
  const body = rows.map((row) => `| ${row.ticker} ${row.name} | ${row.official_industry_label || ""} | ${row.as_of_score} | ${row.current_score} | ${row.score_change >= 0 ? "+" : ""}${row.score_change} | ${formatPct(row.outcome.price_return_pct)} | ${row.data_coverage_score} | ${row.prediction_signal} | ${row.consistency} |`).join("\n");
  return `${header}\n${body}`;
}

function templateSummary(rows) {
  return {
    template_id: rows[0]?.industry_template,
    template_label: rows[0]?.template_label,
    company_count: rows.length,
    average_as_of_score: round(average(rows.map((row) => row.as_of_score))),
    average_current_score: round(average(rows.map((row) => row.current_score))),
    average_score_change: round(average(rows.map((row) => row.score_change))),
    average_price_return_pct: round(average(rows.map((row) => row.outcome.price_return_pct))),
    average_data_coverage_score: round(average(rows.map((row) => row.data_coverage_score)), 3),
    consistent_count: rows.filter((row) => row.consistency === "符合").length,
    partial_count: rows.filter((row) => row.consistency === "部分符合").length,
    miss_count: rows.filter((row) => row.consistency === "不符合").length,
    insufficient_count: rows.filter((row) => row.consistency === "資料不足").length
  };
}

function templateReport(summary, rows) {
  const misses = rows.filter((row) => row.consistency === "不符合");
  const weakFields = SCORE_DIMENSIONS
    .map((dimension) => ({
      label: dimension.label,
      avg: average(rows.map((row) => row.current_dimensions[dimension.id]))
    }))
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 2)
    .map((item) => `${item.label} ${round(item.avg)}`)
    .join("、");

  return [
    `# ${summary.template_label} 一個月模板回測`,
    "",
    `期間：${startDate} 到 ${endDate}`,
    "",
    `樣本數 ${summary.company_count}；平均起點分 ${summary.average_as_of_score}，目前 ${summary.average_current_score}，平均股價變化 ${formatPct(summary.average_price_return_pct)}。`,
    "",
    `判定：符合 ${summary.consistent_count}、部分符合 ${summary.partial_count}、不符合 ${summary.miss_count}。`,
    "",
    markdownTable(rows),
    "",
    "## 初步判讀",
    "",
    `目前最弱的評估軸大約是：${weakFields || "NA"}。`,
    misses.length
      ? `需要優先檢查的例外樣本：${misses.map((row) => `${row.ticker} ${row.name}`).join("、")}。`
      : "這組樣本暫時沒有明顯不符合的公司。",
    "",
    "## 樣本備註",
    "",
    ...rows.map((row) => [
      `- ${row.ticker} ${row.name}：${row.consistency}。${row.consistency_reason}`,
      row.point_in_time_limits.length ? `  - 限制：${row.point_in_time_limits.join("；")}` : ""
    ].filter(Boolean).join("\n"))
  ].join("\n");
}

function summaryReport(summaries, rows, referenceWarnings = []) {
  const header = "| 模板 | 家數 | 起點均分 | 目前均分 | 均分變化 | 平均股價 | 覆蓋率 | 符合 | 部分 | 不符合 | 資料不足 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|";
  const body = summaries.map((summary) => `| ${summary.template_label} | ${summary.company_count} | ${summary.average_as_of_score} | ${summary.average_current_score} | ${summary.average_score_change >= 0 ? "+" : ""}${summary.average_score_change} | ${formatPct(summary.average_price_return_pct)} | ${summary.average_data_coverage_score} | ${summary.consistent_count} | ${summary.partial_count} | ${summary.miss_count} | ${summary.insufficient_count} |`).join("\n");
  const missRows = rows.filter((row) => row.consistency === "不符合");
  const testableRows = rows.filter((row) => row.consistency !== "資料不足");
  const insufficientRows = rows.filter((row) => row.consistency === "資料不足");
  return [
    "# 15 類產業模板一個月回測",
    "",
    `期間：${startDate} 到 ${endDate}`,
    "",
    "這份回測包使用獨立樣本，不寫入主頁 watchlist 或 `data/companies.json`。",
    "",
    `可判定樣本 ${testableRows.length}/${rows.length}；資料不足樣本 ${insufficientRows.length}/${rows.length}。資料不足樣本不應用來計算模型命中或失準。`,
    "",
    header,
    body,
    "",
    "## 需要優先檢查",
    "",
    missRows.length
      ? missRows.map((row) => `- ${row.template_label}：${row.ticker} ${row.name}，${row.consistency_reason}`).join("\n")
      : "本次沒有明顯不符合樣本。",
    "",
    "## 方法限制",
    "",
    "- 股價使用實際歷史交易資料切分起點與終點。",
    "- 重大訊息依可解析日期切到回測起點與終點。",
    "- 月營收若最新資料晚於回測起點，起點分數以中性 50 處理，避免明顯偷看未來。",
    "- 財報、治理與部分產業證據尚未完整保存歷史快照，因此這次是模板壓力測試，不是嚴格投資績效歸因。",
    "",
    "## 資料來源警告",
    "",
    referenceWarnings.length ? referenceWarnings.map((warning) => `- ${warning}`).join("\n") : "- 本次共享資料來源沒有回報錯誤。"
  ].join("\n");
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const [cohortJson, templatesJson, scoringRules, taxonomy] = await Promise.all([
    readJson(cohortPath),
    readJson(path.join(dataDir, "industry_templates.json")),
    readJson(path.join(dataDir, "scoring_rules.json")),
    loadEventTaxonomy(path.join(dataDir, "event_taxonomy.json"))
  ]);
  scoreBands = [...(scoringRules.score_bands || scoreBands)].sort((left, right) => right.min - left.min);
  scoreCalibration = null;
  eventTaxonomy = taxonomy;
  riskDimensionDefinition = (scoringRules.common_dimensions || []).find((dimension) => dimension.id === "riskNews");
  coreWeights = Object.fromEntries((scoringRules.common_dimensions || [])
    .filter((dimension) => dimension.role !== "adjustment")
    .map((dimension) => [dimension.id, Number(dimension.weight) || 0]));
  const companies = cohortJson.companies || [];
  if (!companies.length) throw new Error(`No cohort companies found: ${cohortPath}`);

  console.log(`Fetching shared TWSE/TPEx reference data for ${companies.length} companies...`);
  const reference = await fetchReferenceData();
  if (referenceOnly) {
    await writeJson(path.join(outDir, "reference-status.json"), {
      version: "0.1.0",
      generated_at: generatedAt,
      warnings: reference.warnings || [],
      counts: {
        revenue_rows: reference.revenueRows.length,
        income_rows: reference.incomeRows.length,
        balance_rows: reference.balanceRows.length,
        event_rows: reference.eventRows.length,
        holder_rows: reference.holderRows.length,
        insider_rows: reference.insiderRows.length,
        violation_rows: reference.violationRows.length
      }
    });
    console.log(JSON.stringify({
      out: path.relative(root, path.join(outDir, "reference-status.json")),
      warnings: reference.warnings?.length || 0,
      revenue_rows: reference.revenueRows.length,
      income_rows: reference.incomeRows.length,
      balance_rows: reference.balanceRows.length,
      event_rows: reference.eventRows.length
    }, null, 2));
    return;
  }
  console.log("Fetching price histories...");
  const priceHistories = await mapLimit(companies, 5, async (company, index) => {
    const prices = await fetchPriceHistory(company);
    console.log(`${index + 1}/${companies.length} ${company.ticker} ${nameOf(company)} price days=${prices.history.length}`);
    return prices;
  });
  const twseMarketFallbacks = await fetchTwseMarketFallbacks([startDate, endDate]);

  const rows = companies.map((company, index) => {
    const prices = applyTwseMarketFallback(company, priceHistories[index], twseMarketFallbacks);
    const priceStart = scorePriceAt(prices.history, startDate);
    const priceEnd = scorePriceAt(prices.history, endDate);
    const template = templatesJson.industries?.[company.industry_template] || {};
    return {
      ...buildCompanyScores(company, reference, template, priceStart, priceEnd),
      price_fetch_errors: prices.errors
    };
  });

  const byTemplate = Object.groupBy
    ? Object.groupBy(rows, (row) => row.industry_template)
    : rows.reduce((acc, row) => {
      (acc[row.industry_template] ||= []).push(row);
      return acc;
    }, {});
  const summaries = Object.values(byTemplate).map(templateSummary);

  await writeJson(path.join(outDir, "backtest.json"), {
    version: "0.1.0",
    generated_at: generatedAt,
    start_date: startDate,
    end_date: endDate,
    cohort_file: path.relative(root, cohortPath),
    method: "15 類產業模板各 5 家獨立樣本；使用公開股價、月營收、財報、重大訊息、治理與違規資料評分，並以一個月股價與資料變化檢查模板方向。",
    reference_warnings: reference.warnings || [],
    dimensions: SCORE_DIMENSIONS,
    summaries,
    companies: rows
  });
  await writeFile(path.join(outDir, "summary.md"), `${summaryReport(summaries, rows, reference.warnings || [])}\n`, "utf8");
  await mkdir(path.join(outDir, "templates"), { recursive: true });
  for (const [templateId, templateRows] of Object.entries(byTemplate)) {
    await writeFile(
      path.join(outDir, "templates", `${templateId}.md`),
      `${templateReport(templateSummary(templateRows), templateRows)}\n`,
      "utf8"
    );
  }

  console.log(JSON.stringify({
    out: path.relative(root, outDir),
    companies: rows.length,
    templates: summaries.length,
    consistent: rows.filter((row) => row.consistency === "符合").length,
    partial: rows.filter((row) => row.consistency === "部分符合").length,
    missed: rows.filter((row) => row.consistency === "不符合").length
  }, null, 2));
}

await main();
