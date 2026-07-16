import { createHash } from "node:crypto";
import path from "node:path";
import { rocCompactDateToIso, rocDateToIso, readJson, writeJson } from "./data-sources.mjs";
import { getCachedSource } from "./source-cache.mjs";
import { getMopsHistory } from "./mops-history-collector.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");
const cacheDir = path.join(dataDir, "research_cache");

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function targetTickers(companies) {
  const requested = argValue("tickers", "")
    .split(",")
    .map((ticker) => ticker.trim())
    .filter((ticker) => /^\d{4}$/.test(ticker));
  return [...new Set(requested.length ? requested : companies.map((company) => company.ticker))];
}

function eventDate(value) {
  const text = String(value || "").trim();
  if (/^\d{7}$/.test(text)) return rocCompactDateToIso(text);
  if (/^\d{3}\/\d{1,2}\/\d{1,2}$/.test(text)) return rocDateToIso(text);
  return null;
}

function normalizeDisclosureText(value) {
  let text = String(value || "").replace(/\uFEFF/g, "");
  const looksMojibake = /[\u0080-\u009F\u00C2\u00C3\u00E5-\u00E9]/.test(text);
  const canReDecode = [...text].every((character) => character.charCodeAt(0) <= 255);
  if (looksMojibake && canReDecode) {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(text, (character) => character.charCodeAt(0)));
      if (/[^\x00-\x7F]/.test(decoded)) text = decoded;
    } catch {
      // Keep the source text when it is not recoverable mojibake.
    }
  }
  return text
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function field(row, ...names) {
  for (const name of names) {
    const key = Object.keys(row).find((candidate) => candidate.trim() === name);
    if (key && row[key] !== undefined && row[key] !== null) return normalizeDisclosureText(row[key]);
  }
  return "";
}

function eventId(ticker, sourceId, date, title, description) {
  return createHash("sha256")
    .update([ticker, sourceId, date || "", title, description].join("\u0000"))
    .digest("hex")
    .slice(0, 20);
}

function normalizeEvent(row, source, ticker) {
  const title = field(row, "主旨");
  const description = field(row, "說明");
  const announcedDate = eventDate(field(row, "發言日期", "出表日期", "Date"));
  const factDate = eventDate(field(row, "事實發生日"));
  const date = announcedDate || factDate;
  if (!title || !date) return null;
  return {
    id: eventId(ticker, source.id, date, title, description),
    date,
    announced_date: announcedDate,
    fact_date: factDate,
    announced_time: field(row, "發言時間") || null,
    title,
    description,
    clause: field(row, "符合條款") || null,
    source_id: source.id,
    source_type: source.kind,
    source_url: source.url,
    claim_type: source.claim_type,
    review_status: "unreviewed"
  };
}

function companyWebsiteSource(company, sourceDefinition) {
  const website = company.sources?.find((source) => source.id.endsWith("_official"))?.url || company.website;
  if (!website) return null;
  return {
    id: `company-website-${company.ticker}`,
    title: `${company.name} 官方網站`,
    url: website,
    source_id: sourceDefinition.id,
    source_type: sourceDefinition.kind,
    claim_type: sourceDefinition.claim_type,
    review_status: "reference_only",
    note: sourceDefinition.note
  };
}

function historySearchSource(company, sourceDefinition) {
  return {
    id: `mops-history-${company.ticker}`,
    title: `${company.name} MOPS 歷史重大訊息`,
    url: sourceDefinition.url_template.replace("{ticker}", encodeURIComponent(company.ticker)),
    source_id: sourceDefinition.id,
    source_type: sourceDefinition.kind,
    claim_type: sourceDefinition.claim_type,
    review_status: "reference_only",
    note: sourceDefinition.note
  };
}

function mergeEvents(historyEvents, recentEvents, maxEvents) {
  const seen = new Set();
  return [...historyEvents, ...recentEvents]
    .sort((left, right) => `${right.date} ${right.announced_time || ""}`.localeCompare(`${left.date} ${left.announced_time || ""}`))
    .filter((event) => {
      const key = [event.date, event.announced_time, event.title].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxEvents);
}

async function main() {
  const generatedAt = new Date().toISOString();
  const maxEvents = Math.max(1, Number(argValue("max-events", "24")) || 24);
  const companiesJson = await readJson(path.join(dataDir, "companies.json"));
  const sourceConfig = await readJson(path.join(dataDir, "collector_sources.json"));
  const companies = companiesJson.companies || [];
  const byTicker = new Map(companies.map((company) => [company.ticker, company]));
  const tickers = targetTickers(companies);
  const sources = sourceConfig.sources || [];
  const exchangeSources = sources.filter((source) => source.kind === "official_api_cache");
  const rowsBySource = new Map();
  const sourceStatus = [];

  for (const source of exchangeSources) {
    try {
      const cached = await getCachedSource(source.cache_source_id);
      rowsBySource.set(source.id, cached.data || []);
      sourceStatus.push({
        source_id: source.id,
        cache_status: cached.cache_status,
        fetched_at: cached.fetched_at,
        row_count: cached.row_count,
        available: true
      });
    } catch (error) {
      rowsBySource.set(source.id, []);
      sourceStatus.push({ source_id: source.id, available: false, error: error.message });
    }
  }

  const indexCompanies = [];
  for (const ticker of tickers) {
    const company = byTicker.get(ticker);
    if (!company) {
      indexCompanies.push({ ticker, status: "not_in_research", event_count: 0, collected_at: generatedAt });
      continue;
    }

    const source = exchangeSources.find((item) => item.market === company.market);
    const rawRows = rowsBySource.get(source?.id) || [];
    const recentEvents = rawRows
      .filter((row) => field(row, "公司代號", "SecuritiesCompanyCode") === ticker)
      .map((row) => normalizeEvent(row, source, ticker))
      .filter(Boolean)
      .sort((left, right) => right.date.localeCompare(left.date));

    let history = { events: [], cache_status: "unavailable", fetched_at: null, event_count: 0, detail_count: 0 };
    let historyError = null;
    try {
      history = await getMopsHistory(ticker, { maxEvents, detailLimit: 4 });
    } catch (error) {
      historyError = error.message;
    }
    const events = mergeEvents(history.events || [], recentEvents, maxEvents);

    const historySource = sources.find((item) => item.id === "mops_history_search");
    const websiteSource = sources.find((item) => item.id === "company_website");
    const references = [
      historySource ? historySearchSource(company, historySource) : null,
      websiteSource ? companyWebsiteSource(company, websiteSource) : null
    ].filter(Boolean);
    const record = {
      version: "1.0.0",
      collected_at: generatedAt,
      company: {
        id: company.id,
        ticker: company.ticker,
        name: company.name,
        market: company.market,
        industry_template: company.industry_template
      },
      collection_scope: "targeted_research_company",
      events,
      references,
      source_status: [
        ...sourceStatus.filter((status) => status.source_id === source?.id),
        {
          source_id: "mops_history_api",
          cache_status: history.cache_status,
          fetched_at: history.fetched_at,
          row_count: history.event_count || 0,
          detail_count: history.detail_count || 0,
          available: !historyError,
          error: historyError || undefined
        }
      ],
      limitations: [
        "官方交易所重大訊息快取為近期資料；歷史範圍應透過 MOPS 歷史查詢頁覆核。",
        "公司網站連結僅為研究參考，未經欄位驗證的內容不直接納入評分。",
        "事件保留原始公告文字摘要，不代表投資建議或系統判定。"
      ]
    };
    await writeJson(path.join(cacheDir, `${ticker}.json`), record);
    indexCompanies.push({
      ticker,
      company_id: company.id,
      name: company.name,
      market: company.market,
      status: sourceStatus.some((status) => status.available === false) ? "partial" : "ok",
      event_count: events.length,
      collected_at: generatedAt,
      cache_path: `data/research_cache/${ticker}.json`
    });
  }

  const index = {
    version: "1.0.0",
    generated_at: generatedAt,
    collection_scope: "targeted_research_company",
    source_status: sourceStatus,
    companies: indexCompanies,
    total_events: indexCompanies.reduce((total, company) => total + company.event_count, 0)
  };
  await writeJson(path.join(cacheDir, "index.json"), index);
  console.log(JSON.stringify({
    status: "done",
    companies: indexCompanies.length,
    researched_companies: indexCompanies.filter((company) => company.status !== "not_in_research").length,
    total_events: index.total_events,
    cache: path.relative(root, cacheDir)
  }, null, 2));
}

await main();
