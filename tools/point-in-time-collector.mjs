import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMopsHistory } from "./mops-history-collector.mjs";
import { readJson, rocDateToIso, toNumber, tpexDateParam, twDateParam, writeJson } from "./data-sources.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");
const mopsWebBase = "https://mops.twse.com.tw/mops/web";

async function optionalJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function rocYear(date) {
  return String(date.getUTCFullYear() - 1911);
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function quarterKey(date) {
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function quarterFromKey(key) {
  const match = /^(\d{4})-Q([1-4])$/.exec(key);
  if (!match) return null;
  return { year: Number(match[1]), quarter: Number(match[2]) };
}

function observationDates(endDate, months, day) {
  const end = new Date(`${endDate}T00:00:00Z`);
  const dates = [];
  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const candidate = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - offset, day));
    const cutoff = candidate > end ? end : candidate;
    dates.push(isoDate(cutoff));
  }
  return [...new Set(dates)];
}

function evenlySpaced(items, count) {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, index) => {
    const position = Math.round(index * (items.length - 1) / (count - 1));
    return items[position];
  });
}

function buildCohort(universe, templates, startDate, perTemplate) {
  const minListing = new Date(`${startDate}T00:00:00Z`);
  const rows = [];
  for (const [templateId, template] of Object.entries(templates)) {
    const eligible = (universe.companies || [])
      .filter((company) => company.industry_template === templateId)
      .filter((company) => !company.listing_date || new Date(`${company.listing_date}T00:00:00Z`) <= minListing)
      .sort((left, right) => String(left.ticker).localeCompare(String(right.ticker)));
    const selected = evenlySpaced(eligible, perTemplate);
    rows.push({
      industry_template: templateId,
      template_label: template.label || templateId,
      eligible_count: eligible.length,
      selected_count: selected.length,
      companies: selected.map((company) => ({
        ticker: company.ticker,
        name: company.name || company.abbreviation || company.ticker,
        market: company.market,
        listing_date: company.listing_date || null,
        official_industry_label: company.official_industry_label || null
      }))
    });
  }
  return rows;
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTables(html) {
  const tables = [];
  for (const table of String(html || "").matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [];
    for (const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [];
      for (const cell of row[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
        const colspan = Number(/colspan=["']?(\d+)/i.exec(cell[1])?.[1] || 1);
        const value = decodeHtml(cell[2]);
        cells.push(value, ...Array.from({ length: Math.max(0, colspan - 1) }, () => ""));
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function extractRows(html, ticker = "") {
  const tables = parseTables(html);
  for (const table of tables) {
    const headerIndex = table.findIndex((row) => row.some((cell) => cell.includes("公司代號")));
    if (headerIndex < 0) continue;
    const header = table[headerIndex].map((cell) => cell.replace(/\s+/g, "").trim());
    const rows = table.slice(headerIndex + 1)
      .filter((row) => row.some((cell) => cell === ticker || cell.includes(ticker)))
      .map((row) => Object.fromEntries(header.map((name, index) => [name || `column_${index}`, row[index] || ""])));
    if (rows.length) return rows;
  }
  return [];
}

async function postMopsHtml(endpoint, params) {
  const body = new URLSearchParams(params).toString();
  const controller = new AbortController();
  // MOPS can hold a blocked legacy-form request open. Fail quickly and record the
  // source limitation instead of allowing one unavailable page to stall the run.
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${mopsWebBase}/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "accept": "text/html,application/xhtml+xml",
        "origin": "https://mops.twse.com.tw",
        "referer": `${mopsWebBase}/${endpoint.replace(/^ajax_/, "")}`,
        "user-agent": "Mozilla/5.0 (compatible; company-research-radar/1.0)"
      },
      body,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (/FOR SECURITY REASONS|安全性考量/i.test(text)) throw new Error("MOPS security response");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function getOfficialJson(url) {
  const command = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri $env:RADAR_SOURCE_URL -UseBasicParsing -TimeoutSec 15 | Select-Object -ExpandProperty Content";
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
      cwd: root,
      env: { ...process.env, RADAR_SOURCE_URL: url },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Official source request timed out."));
    }, 25000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr || `Official source exited with ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Official source returned invalid JSON: ${error.message}`));
      }
    });
  });
}

async function postJson(url, payload) {
  const command = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri $env:RADAR_SOURCE_URL -Method POST -ContentType 'application/json' -Body $env:RADAR_SOURCE_BODY -UseBasicParsing -TimeoutSec 20 | Select-Object -ExpandProperty Content";
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
      cwd: root,
      env: { ...process.env, RADAR_SOURCE_URL: url, RADAR_SOURCE_BODY: JSON.stringify(payload) },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Official POST request timed out."));
    }, 30000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr || `Official POST source exited with ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Official POST source returned invalid JSON: ${error.message}`));
      }
    });
  });
}

async function runPowerShellHtml(command, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); ${command}`], {
      cwd: root,
      env: { ...process.env, ...environment },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("MOPS transfer request timed out."));
    }, 45000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(stderr || `MOPS transfer source exited with ${code}.`));
      else resolve(stdout);
    });
  });
}

function endOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function previousMonth(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() - 1);
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1 };
}

function distinctGovernancePeriods(observations) {
  return [...new Map(observations.map((date) => {
    const period = previousMonth(date);
    return [`${period.year}-${String(period.month).padStart(2, "0")}`, period];
  })).values()];
}

async function collectMopsHoldingSnapshot(company, period, source, outputDir) {
  const file = path.join(outputDir, "raw", "governance", "holdings", `${company.ticker}-${period.year}-${String(period.month).padStart(2, "0")}.json`);
  const existing = await optionalJson(file);
  if (!process.argv.includes("--refresh") && existing?.status === "ok") return existing;
  const payload = {
    source_id: "mops_monthly_insider_holdings",
    source_url: source.monthly_holdings_api,
    ticker: company.ticker,
    market: company.market,
    as_of_date: endOfMonth(period.year, period.month),
    requested_period: { roc_year: String(period.year - 1911), month: String(period.month).padStart(2, "0") },
    fetched_at: new Date().toISOString(),
    status: "unavailable",
    major_shareholder_count: null,
    major_shareholders: [],
    data: []
  };
  try {
    const response = await postJson(source.monthly_holdings_api, {
      companyId: company.ticker,
      dataType: "2",
      year: payload.requested_period.roc_year,
      month: payload.requested_period.month,
      subsidiaryCompanyId: ""
    });
    const rows = response?.result?.data;
    if (response?.code !== 200 || !Array.isArray(rows)) throw new Error(response?.message || "Unexpected MOPS holding response.");
    const holders = rows
      .filter((row) => String(row?.[0] || "").trim() === "大股東本人" && String(row?.[1] || "").trim())
      .map((row) => String(row[1]).trim());
    payload.status = "ok";
    payload.data = rows;
    payload.major_shareholders = [...new Set(holders)];
    payload.major_shareholder_count = payload.major_shareholders.length;
  } catch (error) {
    payload.error = error.message;
  }
  await writeJson(file, payload);
  return payload;
}

function transferRecordsFromHtml(html) {
  const records = [];
  for (const row of String(html || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => decodeHtml(cell[1]));
    const dateIndex = cells.findIndex((cell) => /^\d{3}\/\d{2}\/\d{2}$/.test(cell));
    if (dateIndex < 0) continue;
    const ticker = String(cells[dateIndex + 1] || "").trim();
    if (!/^\d{4,6}$/.test(ticker)) continue;
    records.push({
      announced_date: rocDateToIso(cells[dateIndex]),
      ticker,
      identity: cells[dateIndex + 3] || "",
      holder_name: cells[dateIndex + 4] || "",
      transfer_method: cells[dateIndex + 5] || "",
      transfer_shares: toNumber(cells[dateIndex + 6]),
      effective_period: cells.at(-2) || ""
    });
  }
  return records.filter((record) => record.announced_date);
}

async function collectMopsTransferHistory(market, years, source, outputDir) {
  const file = path.join(outputDir, "raw", "governance", `transfers-${market}.json`);
  const existing = await optionalJson(file);
  if (!process.argv.includes("--refresh") && existing?.status === "ok") return existing;
  const records = [];
  const payload = {
    source_id: "mops_insider_transfer_daily_report",
    source_url: source.transfer_result_api,
    query_url: source.transfer_redirect_api,
    market,
    years,
    fetched_at: new Date().toISOString(),
    status: "unavailable",
    records
  };
  try {
    for (const year of years) {
      const html = await runPowerShellHtml(
        "$ProgressPreference='SilentlyContinue'; $s=New-Object Microsoft.PowerShell.Commands.WebRequestSession; $params=@{TYPEK=$env:RADAR_MARKET;year=$env:RADAR_YEAR;smonth='01';emonth='12';encodeURIComponent=1;step=0;firstin=1;off=1}; $body=@{apiName='ajax_t56sb21_q3';parameters=$params}|ConvertTo-Json -Compress -Depth 5; $r=Invoke-WebRequest -Uri $env:RADAR_REDIRECT_URL -Method POST -ContentType 'application/json' -Body $body -UseBasicParsing -WebSession $s -TimeoutSec 25; $signed=($r.Content|ConvertFrom-Json).result.url; $null=Invoke-WebRequest -Uri $signed -UseBasicParsing -WebSession $s -TimeoutSec 25; $form=@{run='';step='1';TYPEK=$env:RADAR_MARKET;year=$env:RADAR_YEAR;smonth='01';emonth='12';sstep='1';firstin='true'}; Invoke-WebRequest -Uri $env:RADAR_RESULT_URL -Method POST -Body $form -UseBasicParsing -WebSession $s -TimeoutSec 25 | Select-Object -ExpandProperty Content",
        {
          RADAR_MARKET: market === "TPEx" ? "otc" : "sii",
          RADAR_YEAR: String(year - 1911),
          RADAR_REDIRECT_URL: source.transfer_redirect_api,
          RADAR_RESULT_URL: source.transfer_result_api
        }
      );
      records.push(...transferRecordsFromHtml(html));
    }
    payload.status = "ok";
  } catch (error) {
    payload.error = error.message;
  }
  await writeJson(file, payload);
  return payload;
}

async function collectViolationHistory(market, source, outputDir) {
  const file = path.join(outputDir, "raw", "governance", `violations-${market}.json`);
  const existing = await optionalJson(file);
  if (!process.argv.includes("--refresh") && existing?.status === "ok") return existing;
  const payload = {
    source_id: market === "TPEx" ? "tpex_disclosure_violations" : "twse_disclosure_violations",
    source_url: source.violation_sources[market],
    market,
    fetched_at: new Date().toISOString(),
    status: "unavailable",
    records: []
  };
  try {
    const data = await getOfficialJson(payload.source_url);
    if (!Array.isArray(data)) throw new Error("Unexpected official violation response.");
    payload.records = data.map((row) => {
      const values = Object.values(row || {});
      return { issued_date: rocDateToIso(values[1]), ticker: String(values[2] || "").trim() };
    }).filter((record) => record.issued_date && /^\d{4,6}$/.test(record.ticker));
    payload.status = "ok";
  } catch (error) {
    payload.error = error.message;
  }
  await writeJson(file, payload);
  return payload;
}

function finmindUrl(baseUrl, dataset, ticker, startDate, endDate) {
  const url = new URL(baseUrl);
  url.searchParams.set("dataset", dataset);
  url.searchParams.set("data_id", ticker);
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  return url.toString();
}

async function collectFinmindDataset(company, source, datasetKey, startDate, endDate, outputDir, budget) {
  const dataset = source.datasets?.[datasetKey];
  const file = path.join(outputDir, "raw", "finmind", `${company.ticker}-${dataset}.json`);
  const existing = await optionalJson(file);
  if (!process.argv.includes("--refresh") && ["ok", "no_data"].includes(existing?.status)) return existing;
  if (budget.used >= budget.limit) {
    return { status: "deferred", dataset, reason: "FinMind request budget reached; run the collector again to resume from cache." };
  }
  budget.used += 1;
  const sourceUrl = finmindUrl(source.base_url, dataset, company.ticker, startDate, endDate);
  const payload = {
    source_id: `finmind_${dataset}`,
    provider: source.provider,
    source_type: source.source_type,
    source_url: sourceUrl,
    dataset,
    ticker: company.ticker,
    requested_range: { start_date: startDate, end_date: endDate },
    fetched_at: new Date().toISOString(),
    status: "unavailable",
    data: []
  };
  try {
    const response = await getOfficialJson(sourceUrl);
    if (response?.status !== 200 || !Array.isArray(response.data)) throw new Error(response?.msg || "Unexpected FinMind response.");
    payload.status = response.data.length ? "ok" : "no_data";
    payload.data = response.data;
  } catch (error) {
    payload.error = error.message;
  }
  await writeJson(file, payload);
  return payload;
}

function historicalStartDate(startDate) {
  const value = new Date(`${startDate}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() - 18);
  value.setUTCDate(1);
  return isoDate(value);
}

async function collectFinmindHistory(company, source, startDate, endDate, outputDir, budget) {
  if (!source?.enabled) return { status: "disabled" };
  const datasets = await Promise.all(["revenue", "income", "balance"].map((key) => collectFinmindDataset(company, source, key, startDate, endDate, outputDir, budget)));
  return {
    status: datasets.every((dataset) => ["ok", "no_data"].includes(dataset.status)) ? "ok" : "partial",
    datasets: Object.fromEntries(datasets.map((dataset) => [dataset.dataset, dataset.status]))
  };
}

function marketType(market) {
  return market === "TPEx" ? "otc" : "sii";
}

async function collectQuarterlyReport(kind, market, year, quarter, outputDir) {
  const endpoint = kind === "income" ? "ajax_t163sb04" : "ajax_t163sb05";
  const file = path.join(outputDir, "raw", "financial", `${kind}-${market}-${year}-Q${quarter}.json`);
  const payload = {
    source_id: `mops_${kind}_summary`,
    endpoint,
    source_url: `${mopsWebBase}/${endpoint}`,
    market,
    roc_year: String(year - 1911),
    quarter: String(quarter).padStart(2, "0"),
    fetched_at: new Date().toISOString(),
    status: "unavailable",
    rows: []
  };
  try {
    const html = await postMopsHtml(endpoint, {
      encodeURIComponent: "1",
      step: "1",
      firstin: "1",
      off: "1",
      isQuery: "Y",
      TYPEK: marketType(market),
      year: payload.roc_year,
      season: payload.quarter
    });
    payload.status = "ok";
    payload.html_length = html.length;
    payload.tables = parseTables(html);
  } catch (error) {
    payload.error = error.message;
  }
  await writeJson(file, payload);
  return payload;
}

async function collectMonthlyRevenue(market, year, month, outputDir) {
  const endpoint = "ajax_t05st10_ifrs";
  const file = path.join(outputDir, "raw", "revenue", `${market}-${year}-${String(month).padStart(2, "0")}.json`);
  const payload = {
    source_id: "mops_monthly_revenue_history",
    endpoint,
    source_url: `${mopsWebBase}/t05st10_ifrs`,
    market,
    roc_year: String(year - 1911),
    month: String(month).padStart(2, "0"),
    fetched_at: new Date().toISOString(),
    status: "unavailable",
    tables: []
  };
  try {
    const html = await postMopsHtml(endpoint, {
      encodeURIComponent: "1",
      step: "1",
      firstin: "1",
      off: "1",
      TYPEK: marketType(market),
      year: payload.roc_year,
      month: payload.month
    });
    payload.status = "ok";
    payload.html_length = html.length;
    payload.tables = parseTables(html);
  } catch (error) {
    payload.error = error.message;
  }
  await writeJson(file, payload);
  return payload;
}

async function fetchPriceHistory(company, startDate, endDate, outputDir) {
  const file = path.join(outputDir, "raw", "prices", `${company.ticker}.json`);
  const existing = await optionalJson(file);
  if (!process.argv.includes("--refresh") && existing?.status === "ok" && Array.isArray(existing.prices) && existing.prices.length >= 260) return existing;
  const start = new Date(`${startDate}T00:00:00Z`);
  start.setUTCMonth(start.getUTCMonth() - 13);
  start.setUTCDate(1);
  const end = new Date(`${endDate}T00:00:00Z`);
  end.setUTCDate(1);
  const months = [];
  for (let month = new Date(start); month <= end; month.setUTCMonth(month.getUTCMonth() + 1)) {
    months.push(new Date(month));
  }
  const sourceUrls = months.map((month) => company.market === "TPEx"
    ? `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${company.ticker}&date=${encodeURIComponent(tpexDateParam(month))}&id=&response=json`
    : `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${twDateParam(month)}&stockNo=${company.ticker}`);
  const priceMonthConcurrency = Math.max(1, Number(argValue("price-month-concurrency", "4")));
  const batches = await mapLimit(months, priceMonthConcurrency, async (month) => {
    const url = company.market === "TPEx"
      ? `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${company.ticker}&date=${encodeURIComponent(tpexDateParam(month))}&id=&response=json`
      : `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${twDateParam(month)}&stockNo=${company.ticker}`;
    try {
      const data = await getOfficialJson(url);
      const sourceRows = company.market === "TPEx" ? data?.tables?.[0]?.data : data?.data;
      if (!Array.isArray(sourceRows)) throw new Error(data?.stat || "No rows returned");
      return { rows: sourceRows.map((item) => ({ date: rocDateToIso(item[0]), close: toNumber(item[6]) })).filter((item) => item.date && Number.isFinite(item.close)) };
    } catch (error) {
      return { rows: [], error: `${month.toISOString().slice(0, 7)} ${error.message}` };
    }
  });
  const rows = batches.flatMap((batch) => batch.rows);
  const errors = batches.flatMap((batch) => batch.error ? [batch.error] : []);
  const prices = [...new Map(rows.map((item) => [item.date, item])).values()].sort((left, right) => left.date.localeCompare(right.date));
  const payload = {
    source_id: company.market === "TPEx" ? "tpex_trading_stock" : "twse_stock_day",
    source_urls: sourceUrls,
    fetched_at: new Date().toISOString(),
    status: prices.length ? "ok" : "unavailable",
    prices,
    errors
  };
  await writeJson(file, payload);
  return payload;
}

async function main() {
  const config = await readJson(path.join(dataDir, "backtest_config.json"));
  const universe = await readJson(path.join(dataDir, "listed_companies_universe.json"));
  const templates = (await readJson(path.join(dataDir, "industry_templates.json"))).industries || {};
  const endDate = argValue("end", new Date().toISOString().slice(0, 10));
  if (!isIsoDate(endDate)) throw new Error("--end must be YYYY-MM-DD");
  const presetName = argValue("preset");
  const preset = presetName ? config.presets?.[presetName] : null;
  if (presetName && !preset) throw new Error(`Unknown backtest preset: ${presetName}`);
  const timeline = { ...config.timeline, ...(preset || {}) };
  const months = Number(argValue("months", timeline.months));
  const perTemplate = Number(argValue("companies-per-template", config.cohort.companies_per_template));
  const backtestId = argValue("backtest-id", `point-in-time-15x${perTemplate}-${months}m-${endDate}`);
  const outputDir = path.join(root, "backtests", backtestId);
  const maxCompanies = Number(argValue("max-companies", "0"));
  const skipMopsReports = process.argv.includes("--skip-mops-reports");
  const retryPricesOnly = process.argv.includes("--retry-prices-only");
  if (retryPricesOnly) {
    const previousCohort = await readJson(path.join(outputDir, "cohort.json"));
    const previousTimeline = previousCohort.timeline || timeline;
    const priceEnd = new Date(`${previousCohort.end_date}T00:00:00Z`);
    priceEnd.setUTCDate(priceEnd.getUTCDate() + Math.max(...previousTimeline.forward_return_days) + 10);
    const retryCompanies = (previousCohort.templates || []).flatMap((group) => (group.companies || []));
    const concurrency = Math.max(1, Number(argValue("company-concurrency", "1")));
    const results = await mapLimit(retryCompanies, concurrency, async (company) => {
      const price = await fetchPriceHistory(company, previousCohort.start_date, isoDate(priceEnd), outputDir);
      return { ticker: company.ticker, status: price.status, price_rows: price.prices?.length || 0, errors: price.errors?.length || 0 };
    });
    await writeJson(path.join(outputDir, "price-retry.json"), { generated_at: new Date().toISOString(), results });
    console.log(JSON.stringify({ backtest_id: backtestId, retried: results.length, sufficient_price_history: results.filter((row) => row.price_rows >= 260).length }, null, 2));
    return;
  }
  const requestedDates = argValue("observation-dates", (timeline.observation_dates || []).join(","));
  const observations = requestedDates
    ? [...new Set(requestedDates.split(",").map((date) => date.trim()).filter(Boolean))].sort()
    : observationDates(endDate, months, timeline.observation_day);
  if (!observations.length || observations.some((date) => !isIsoDate(date))) throw new Error("Observation dates must be YYYY-MM-DD.");
  const startDate = observations[0];
  const priceEnd = new Date(`${endDate}T00:00:00Z`);
  priceEnd.setUTCDate(priceEnd.getUTCDate() + Math.max(...timeline.forward_return_days) + 10);
  const cohort = buildCohort(universe, templates, startDate, perTemplate);
  const companies = cohort.flatMap((group) => group.companies.map((company) => ({ ...company, industry_template: group.industry_template, template_label: group.template_label })));
  const selectedCompanies = maxCompanies > 0 ? companies.slice(0, maxCompanies) : companies;
  const selectedTickers = new Set(selectedCompanies.map((company) => company.ticker));
  const activeCohort = cohort.map((group) => ({
    ...group,
    companies: group.companies.filter((company) => selectedTickers.has(company.ticker)),
    selected_count: group.companies.filter((company) => selectedTickers.has(company.ticker)).length
  })).filter((group) => group.companies.length);
  await mkdir(outputDir, { recursive: true });
  await writeJson(path.join(outputDir, "cohort.json"), {
    version: "1.0.0",
    generated_at: new Date().toISOString(),
    selection: config.cohort.selection,
    start_date: startDate,
    end_date: endDate,
    observation_dates: observations,
    timeline: { forward_return_days: timeline.forward_return_days, event_lookback_days: timeline.event_lookback_days },
    requested_templates: cohort.map((group) => ({ industry_template: group.industry_template, eligible_count: group.eligible_count, requested_count: group.companies.length })),
    templates: activeCohort
  });

  const monthsToFetch = new Map();
  const quartersToFetch = new Map();
  for (const observation of observations) {
    const date = new Date(`${observation}T00:00:00Z`);
    monthsToFetch.set(monthKey(date), { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 });
    quartersToFetch.set(quarterKey(date), quarterFromKey(quarterKey(date)));
  }
  const reportStatus = [];
  if (!skipMopsReports) {
    for (const market of ["TWSE", "TPEx"]) {
      for (const period of monthsToFetch.values()) {
        reportStatus.push(await collectMonthlyRevenue(market, period.year, period.month, outputDir));
        await sleep(350);
      }
      for (const period of quartersToFetch.values()) {
        reportStatus.push(await collectQuarterlyReport("income", market, period.year, period.quarter, outputDir));
        await sleep(350);
        reportStatus.push(await collectQuarterlyReport("balance", market, period.year, period.quarter, outputDir));
        await sleep(350);
      }
    }
  }

  const companyConcurrency = Math.max(1, Number(argValue("company-concurrency", "3")));
  const finmindSource = config.sources.finmind_historical_fallback;
  const governanceSource = config.sources.historical_governance;
  const finmindBudget = { used: 0, limit: Number(argValue("finmind-request-budget", finmindSource?.no_token_request_budget || 0)) };
  const finmindStart = historicalStartDate(startDate);
  const governancePeriods = distinctGovernancePeriods(observations);
  const governanceYears = [...new Set(observations.map((date) => Number(date.slice(0, 4))))];
  const governanceStatus = governanceSource?.enabled
    ? await Promise.all([
      ...["TWSE", "TPEx"].map((market) => collectMopsTransferHistory(market, governanceYears, governanceSource, outputDir)),
      ...["TWSE", "TPEx"].map((market) => collectViolationHistory(market, governanceSource, outputDir))
    ])
    : [];
  const companyStatus = await mapLimit(selectedCompanies, companyConcurrency, async (company) => {
    const record = { ticker: company.ticker, market: company.market, price: "unavailable", mops_history: "unavailable", finmind_historical: "disabled" };
    const finmind = await collectFinmindHistory(company, finmindSource, finmindStart, endDate, outputDir, finmindBudget);
    record.finmind_historical = finmind.status;
    record.finmind_datasets = finmind.datasets || {};
    if (governanceSource?.enabled) {
      const holdings = [];
      for (const period of governancePeriods) holdings.push(await collectMopsHoldingSnapshot(company, period, governanceSource, outputDir));
      record.governance_holdings = holdings.every((item) => item.status === "ok") ? "ok" : "partial";
    }
    const price = await fetchPriceHistory(company, startDate, isoDate(priceEnd), outputDir);
    record.price = price.status;
    try {
      const history = await getMopsHistory(company.ticker, {
        force: process.argv.includes("--refresh"),
        yearCount: config.sources.mops_history.years,
        maxEvents: config.sources.mops_history.max_events,
        detailLimit: config.sources.mops_history.detail_limit,
        asOfDate: endDate,
        cacheDirectory: path.join(outputDir, "raw", "mops_history")
      });
      record.mops_history = history.cache_status;
      record.event_count = history.event_count;
    } catch (error) {
      record.mops_history_error = error.message;
    }
    return record;
  });

  const manifest = {
    version: "1.0.0",
    generated_at: new Date().toISOString(),
    status: "collected",
    config_path: "data/backtest_config.json",
    backtest_id: backtestId,
    date_range: { start: startDate, end: endDate, observation_dates: observations },
    company_count: selectedCompanies.length,
    requested_company_count: companies.length,
    source_status: reportStatus.map((item) => ({ source_id: item.source_id, market: item.market, period: `${item.roc_year}-${item.quarter || item.month}`, status: item.status, error: item.error || null })),
    skipped_mops_reports: skipMopsReports,
    preset: presetName || null,
    governance_sources: governanceStatus.map((item) => ({ source_id: item.source_id, market: item.market, status: item.status, record_count: item.records?.length || 0, error: item.error || null })),
    companies: companyStatus,
    finmind_request_budget: { used: finmindBudget.used, limit: finmindBudget.limit },
    note: "Raw source data is stored before scoring. A source security response or missing dated governance record is preserved as unavailable and must not be replaced with current data."
  };
  await writeJson(path.join(outputDir, "manifest.json"), manifest);
  console.log(JSON.stringify({ backtest_id: backtestId, companies: selectedCompanies.length, reports_ok: reportStatus.filter((item) => item.status === "ok").length, reports_unavailable: reportStatus.filter((item) => item.status !== "ok").length }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { buildCohort, extractRows, observationDates, parseTables };
