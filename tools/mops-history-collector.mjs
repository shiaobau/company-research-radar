import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rocDateToIso, readJson, writeJson } from "./data-sources.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");
const cacheDir = path.join(dataDir, "mops_history_cache");
const searchUrl = "https://mops.twse.com.tw/mops/web/t05st01";
const apiBase = "https://mops.twse.com.tw/mops/api";

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\uFEFF/g, "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceUrl(ticker, year = "") {
  const params = new URLSearchParams({
    co_id: String(ticker || "").trim(),
    firstin: "true",
    step: "1"
  });
  if (/^\d{3}$/.test(String(year))) params.set("year", String(year));
  return `${searchUrl}?${params.toString()}`;
}

function rocYear(date = new Date()) {
  return date.getUTCFullYear() - 1911;
}

function requestedYears(yearCount, referenceDate = new Date()) {
  const currentYear = rocYear(referenceDate);
  return Array.from({ length: Math.max(1, yearCount) }, (_, index) => String(currentYear - index));
}

function cacheIsFresh(record, ttlHours) {
  const timestamp = Date.parse(record?.fetched_at || "");
  return Number.isFinite(timestamp) && Date.now() - timestamp < ttlHours * 60 * 60 * 1000;
}

async function readCache(ticker, directory = cacheDir) {
  try {
    return JSON.parse(await readFile(path.join(directory, `${ticker}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function postMopsWithPowerShell(apiName, payload) {
  const command = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri $env:CODEX_MOPS_URL -Method POST -ContentType 'application/json' -Body $env:CODEX_MOPS_BODY -TimeoutSec 20 | Select-Object -ExpandProperty Content";
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
      cwd: root,
      env: {
        ...process.env,
        CODEX_MOPS_URL: `${apiBase}/${apiName}`,
        CODEX_MOPS_BODY: JSON.stringify(payload)
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`MOPS ${apiName} PowerShell request timed out.`));
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
        reject(new Error(stderr || `MOPS ${apiName} PowerShell exited with ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`MOPS ${apiName} PowerShell returned invalid JSON: ${error.message}`));
      }
    });
  });
}

async function postMops(apiName, payload) {
  try {
    const result = await postMopsWithPowerShell(apiName, payload);
    if (Number(result?.code) !== 200) throw new Error(result?.message || `MOPS ${apiName} did not return data.`);
    return result.result || {};
  } catch (powerShellError) {
    let lastError = powerShellError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        const response = await fetch(`${apiBase}/${apiName}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json"
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timeout);
        if (!response.ok) throw new Error(`MOPS ${apiName} returned ${response.status}.`);
        const result = await response.json();
        if (Number(result?.code) !== 200) throw new Error(result?.message || `MOPS ${apiName} did not return data.`);
        return result.result || {};
      } catch (error) {
        lastError = error;
        if (attempt < 2) await sleep(900 * (attempt + 1));
      }
    }
    throw new Error(`PowerShell failed: ${powerShellError.message}; Node fetch failed: ${lastError.message}`);
  }
}

function listEvent(row) {
  const detail = row?.[5] || {};
  const parameters = detail?.parameters || {};
  const date = rocDateToIso(normalizeText(row?.[2]));
  const title = normalizeText(row?.[4]);
  if (!date || !title || !parameters.serialNumber) return null;
  return {
    id: `mops-history-${parameters.companyId}-${parameters.enterDate}-${parameters.serialNumber}`,
    date,
    announced_date: date,
    fact_date: null,
    announced_time: normalizeText(row?.[3]) || null,
    title,
    description: "",
    clause: null,
    source_id: "mops_history_api",
    source_type: "official_history_api",
    source_url: sourceUrl(parameters.companyId, String(parameters.enterDate || "").slice(0, 3)),
    claim_type: "official_disclosure",
    review_status: "unreviewed",
    detail_parameters: parameters
  };
}

async function hydrateDetail(event) {
  const detail = await postMops("t05st01_detail", event.detail_parameters);
  const row = detail?.data?.[0] || [];
  return {
    ...event,
    title: normalizeText(row?.[6]) || event.title,
    clause: normalizeText(row?.[7]) || null,
    fact_date: rocDateToIso(normalizeText(row?.[8])) || null,
    description: normalizeText(row?.[9]) || ""
  };
}

function dedupeEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = [event.date, event.announced_time, event.title].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function getMopsHistory(ticker, options = {}) {
  const normalizedTicker = String(ticker || "").trim();
  if (!/^\d{4}$/.test(normalizedTicker)) throw new Error("A four-digit ticker is required for MOPS history.");

  const ttlHours = Number(options.ttlHours || 24);
  const yearCount = Math.max(1, Number(options.yearCount || 2));
  const maxEvents = Math.max(1, Number(options.maxEvents || 60));
  const detailLimit = Math.max(0, Number(options.detailLimit || 6));
  const asOfDate = /^\d{4}-\d{2}-\d{2}$/.test(String(options.asOfDate || "")) ? String(options.asOfDate) : null;
  const targetCacheDir = options.cacheDirectory || cacheDir;
  const cached = await readCache(normalizedTicker, targetCacheDir);
  if (cached && !options.force && cached.as_of_date === asOfDate && cacheIsFresh(cached, ttlHours)) {
    return { ...cached, cache_status: "fresh" };
  }

  const events = [];
  const queriedYears = [];
  try {
    const referenceDate = asOfDate ? new Date(`${asOfDate}T00:00:00Z`) : new Date();
    for (const year of requestedYears(yearCount, referenceDate)) {
      const result = await postMops("t05st01", {
        companyId: normalizedTicker,
        year,
        month: "all",
        firstDay: "",
        lastDay: ""
      });
      queriedYears.push(year);
      for (const row of result.data || []) {
        const event = listEvent(row);
        if (event) events.push(event);
      }
      await sleep(180);
    }
  } catch (error) {
    if (cached) return { ...cached, cache_status: "stale", last_error: error.message };
    throw error;
  }

  const selected = dedupeEvents(events)
    .filter((event) => !asOfDate || String(event.announced_date || event.date || "") <= asOfDate)
    .sort((left, right) => `${right.date} ${right.announced_time || ""}`.localeCompare(`${left.date} ${left.announced_time || ""}`))
    .slice(0, maxEvents);

  for (let index = 0; index < Math.min(detailLimit, selected.length); index += 1) {
    try {
      selected[index] = await hydrateDetail(selected[index]);
    } catch (error) {
      selected[index].detail_error = error.message;
    }
    await sleep(180);
  }

  const payload = {
    version: "1.0.0",
    source_id: "mops_history_api",
    source_url: sourceUrl(normalizedTicker),
    ticker: normalizedTicker,
    fetched_at: new Date().toISOString(),
    cache_status: "updated",
    as_of_date: asOfDate,
    queried_roc_years: queriedYears,
    event_count: selected.length,
    detail_count: selected.filter((event) => event.description).length,
    events: selected
  };
  await mkdir(targetCacheDir, { recursive: true });
  await writeJson(path.join(targetCacheDir, `${normalizedTicker}.json`), payload);
  return payload;
}

async function main() {
  const companiesJson = await readJson(path.join(dataDir, "companies.json"));
  const requested = argValue("tickers", "")
    .split(",")
    .map((ticker) => ticker.trim())
    .filter((ticker) => /^\d{4}$/.test(ticker));
  const tickers = [...new Set(requested.length ? requested : (companiesJson.companies || []).map((company) => company.ticker))];
  const asOfDate = argValue("as-of", "");
  const targetCacheDir = path.resolve(root, argValue("cache-dir", cacheDir));
  const results = [];
  for (const ticker of tickers) {
    try {
      const result = await getMopsHistory(ticker, {
        force: process.argv.includes("--refresh"),
        yearCount: Number(argValue("years", "2")),
        maxEvents: Number(argValue("max-events", "60")),
        detailLimit: Number(argValue("detail-limit", "6")),
        asOfDate,
        cacheDirectory: targetCacheDir
      });
      results.push({ ticker, cache_status: result.cache_status, event_count: result.event_count, detail_count: result.detail_count });
    } catch (error) {
      results.push({ ticker, cache_status: "failed", event_count: 0, detail_count: 0, error: error.message });
    }
  }
  console.log(JSON.stringify({ status: "done", companies: results.length, results }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
