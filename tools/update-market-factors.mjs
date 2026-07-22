import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_VERSION,
  fetchJson,
  readJson,
  rocCompactDateToIso,
  rocDateToIso,
  round,
  toNumber,
  writeJson
} from "./data-sources.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");
const outputPath = path.join(dataDir, "market_factors.json");
const generatedAt = new Date().toISOString();

const MARKET_FACTOR_SOURCE_IDS = [
  "twse_valuation",
  "tpex_valuation",
  "twse_margin_balance",
  "tpex_margin_balance",
  "twse_institutional_trading",
  "tpex_institutional_trading"
];

function marketKey(market, ticker) {
  return `${market}:${ticker}`;
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (/^\d{7}$/.test(text)) return rocCompactDateToIso(text);
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{2,3}\/\d{1,2}\/\d{1,2}$/.test(text)) return rocDateToIso(text);
  return text || null;
}

function tableRows(payload, tableIndex = 0) {
  const table = payload?.tables?.[tableIndex];
  const fields = table?.fields || [];
  if (!Array.isArray(fields) || !Array.isArray(table?.data)) return [];
  return table.data.map((values) => Object.fromEntries(fields.map((field, index) => [field, values[index]])));
}

function validTicker(value) {
  return /^\d{4}$/.test(String(value || "").trim());
}

function codeFrom(row, names) {
  for (const name of names) {
    const value = String(row?.[name] || "").trim();
    if (validTicker(value)) return value;
  }
  return null;
}

function pickNumber(row, names) {
  for (const name of names) {
    const value = toNumber(row?.[name]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function normalizeTwseValuation(rows) {
  return rows.map((row) => ({
    ticker: String(row.Code || "").trim(),
    pe_ratio: toNumber(row.PEratio),
    dividend_yield_pct: toNumber(row.DividendYield),
    pb_ratio: toNumber(row.PBratio),
    as_of: String(row.Date || "").trim() || null
  })).filter((row) => validTicker(row.ticker));
}

function normalizeTpexValuation(payload) {
  return tableRows(payload).map((row) => ({
    ticker: codeFrom(row, ["股票代號", "代號"]),
    pe_ratio: pickNumber(row, ["本益比"]),
    dividend_yield_pct: pickNumber(row, ["殖利率(%)"]),
    pb_ratio: pickNumber(row, ["股價淨值比"]),
    as_of: payload?.tables?.[0]?.date || null
  })).filter((row) => row.ticker);
}

function normalizeTwseMargin(rows) {
  return rows.map((row) => ({
    ticker: codeFrom(row, ["股票代號"]),
    financing_balance_lots: pickNumber(row, ["融資今日餘額", "融資餘額"]),
    short_balance_lots: pickNumber(row, ["融券今日餘額", "融券餘額"]),
    financing_change_lots: pickNumber(row, ["融資增減", "融資買賣超"]),
    short_change_lots: pickNumber(row, ["融券增減", "融券買賣超"])
  })).filter((row) => row.ticker);
}

function normalizeTpexMargin(payload) {
  return tableRows(payload).map((row) => ({
    ticker: codeFrom(row, ["代號", "股票代號"]),
    financing_balance_lots: pickNumber(row, ["資餘額"]),
    short_balance_lots: pickNumber(row, ["券餘額"]),
    financing_change_lots: (() => {
      const previous = pickNumber(row, ["前資餘額(張)"]);
      const current = pickNumber(row, ["資餘額"]);
      return Number.isFinite(previous) && Number.isFinite(current) ? current - previous : null;
    })(),
    short_change_lots: (() => {
      const previous = pickNumber(row, ["前券餘額(張)"]);
      const current = pickNumber(row, ["券餘額"]);
      return Number.isFinite(previous) && Number.isFinite(current) ? current - previous : null;
    })()
  })).filter((row) => row.ticker);
}

function normalizeTwseInstitutional(payload) {
  return (payload?.data || []).map((values) => Object.fromEntries((payload.fields || []).map((field, index) => [field, values[index]])))
    .map((row) => ({
      ticker: codeFrom(row, ["證券代號", "股票代號"]),
      foreign_net_shares: pickNumber(row, ["外陸資買賣超股數(不含外資自營商)", "外資及陸資買賣超股數"]),
      trust_net_shares: pickNumber(row, ["投信買賣超股數"]),
      dealer_net_shares: pickNumber(row, ["自營商買賣超股數"]),
      total_net_shares: pickNumber(row, ["三大法人買賣超股數"])
    })).filter((row) => row.ticker);
}

function normalizeTpexInstitutional(payload) {
  return (payload?.tables?.[0]?.data || []).map((values) => ({
    ticker: validTicker(values?.[0]) ? String(values[0]).trim() : null,
    // The official table has repeated labels, so use its documented column positions.
    foreign_net_shares: toNumber(values?.[4]),
    trust_net_shares: toNumber(values?.[10]),
    dealer_net_shares: toNumber(values?.[22]),
    total_net_shares: toNumber(values?.[23])
  })).filter((row) => row.ticker);
}

function indexByTicker(rows) {
  return new Map(rows.map((row) => [row.ticker, row]));
}

function percentile(value, values, higherIsBetter) {
  if (!Number.isFinite(value) || values.length < 10) return null;
  const comparable = values.filter(Number.isFinite);
  if (comparable.length < 10) return null;
  const favorableCount = comparable.filter((item) => higherIsBetter ? item <= value : item >= value).length;
  return round(favorableCount / comparable.length * 100, 0);
}

function buildPeerGroups(records) {
  const byOfficialIndustry = new Map();
  const byTemplate = new Map();
  for (const record of records) {
    const officialKey = record.official_industry_label || record.official_industry_code || "";
    const templateKey = record.industry_template || "other";
    if (officialKey) byOfficialIndustry.set(officialKey, [...(byOfficialIndustry.get(officialKey) || []), record]);
    byTemplate.set(templateKey, [...(byTemplate.get(templateKey) || []), record]);
  }
  return { byOfficialIndustry, byTemplate };
}

function peerReference(record, groups) {
  const officialKey = record.official_industry_label || record.official_industry_code || "";
  const official = groups.byOfficialIndustry.get(officialKey) || [];
  if (official.length >= 10) return { label: record.official_industry_label || officialKey, basis: "official_industry", rows: official };
  const template = groups.byTemplate.get(record.industry_template) || [];
  if (template.length >= 10) return { label: record.industry_template_label || record.industry_template, basis: "template_fallback", rows: template };
  return { label: record.official_industry_label || record.industry_template || "未分類", basis: "insufficient", rows: [] };
}

function dateParam(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

async function latestTwseInstitutional() {
  for (let offset = 0; offset < 8; offset += 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - offset);
    try {
      const payload = await fetchJson(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${dateParam(date)}&selectType=ALLBUT0999&response=json`, 2, 18000);
      if (payload?.stat === "OK" && Array.isArray(payload.data) && payload.data.length) return payload;
    } catch (error) {
      console.warn(`TWSE 三大法人 ${dateParam(date)} unavailable: ${error.message}`);
    }
  }
  throw new Error("TWSE 三大法人端點未回傳最近交易日資料。");
}

function previousPayload(payload) {
  return payload?.data ? payload : { companies: {} };
}

export async function updateMarketFactors({ generatedAt: requestedGeneratedAt = generatedAt } = {}) {
  const [universeJson, researchCompaniesJson] = await Promise.all([
    readJson(path.join(dataDir, "listed_companies_universe.json")),
    readJson(path.join(dataDir, "companies.json"))
  ]);
  const universe = (universeJson.companies || []).filter((company) => validTicker(company.ticker));
  const researchKeys = new Set((researchCompaniesJson.companies || []).map((company) => marketKey(company.market, company.ticker)));
  const [twseValuationPayload, tpexValuationPayload, twseMarginPayload, tpexMarginPayload, twseInstitutionalPayload, tpexInstitutionalPayload] = await Promise.all([
    fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL", 2, 18000),
    fetchJson("https://www.tpex.org.tw/web/stock/aftertrading/peratio_analysis/pera_result.php?l=zh-tw&o=json&s=0", 2, 18000),
    fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN", 2, 18000),
    fetchJson("https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json", 2, 18000),
    latestTwseInstitutional(),
    fetchJson("https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&se=AL", 2, 18000)
  ]);

  const valuationByMarket = {
    TWSE: indexByTicker(normalizeTwseValuation(twseValuationPayload)),
    TPEx: indexByTicker(normalizeTpexValuation(tpexValuationPayload))
  };
  const marginByMarket = {
    TWSE: indexByTicker(normalizeTwseMargin(twseMarginPayload)),
    TPEx: indexByTicker(normalizeTpexMargin(tpexMarginPayload))
  };
  const institutionalByMarket = {
    TWSE: indexByTicker(normalizeTwseInstitutional(twseInstitutionalPayload)),
    TPEx: indexByTicker(normalizeTpexInstitutional(tpexInstitutionalPayload))
  };

  const records = universe.map((company) => ({
    ...company,
    valuation: valuationByMarket[company.market]?.get(company.ticker) || null
  }));
  const groups = buildPeerGroups(records);
  const factors = {};

  for (const record of records) {
    const peer = peerReference(record, groups);
    const peerValuations = peer.rows.map((item) => item.valuation).filter(Boolean);
    const valuation = record.valuation;
    const margin = marginByMarket[record.market]?.get(record.ticker) || null;
    const institutional = institutionalByMarket[record.market]?.get(record.ticker) || null;
    const sourceIds = [
      record.market === "TWSE" ? "twse_valuation" : "tpex_valuation",
      record.market === "TWSE" ? "twse_margin_balance" : "tpex_margin_balance",
      record.market === "TWSE" ? "twse_institutional_trading" : "tpex_institutional_trading"
    ];
    factors[marketKey(record.market, record.ticker)] = {
      ticker: record.ticker,
      market: record.market,
      official_industry_label: record.official_industry_label || null,
      peer_group: {
        basis: peer.basis,
        label: peer.label,
        sample_count: peerValuations.length
      },
      valuation: valuation ? {
        as_of: normalizeDate(valuation.as_of),
        pe_ratio: round(valuation.pe_ratio),
        pb_ratio: round(valuation.pb_ratio),
        dividend_yield_pct: round(valuation.dividend_yield_pct),
        favorable_percentiles: {
          pe_ratio: percentile(valuation.pe_ratio, peerValuations.map((item) => item.pe_ratio), false),
          pb_ratio: percentile(valuation.pb_ratio, peerValuations.map((item) => item.pb_ratio), false),
          dividend_yield_pct: percentile(valuation.dividend_yield_pct, peerValuations.map((item) => item.dividend_yield_pct), true)
        }
      } : null,
      margin: margin ? {
        as_of: record.market === "TWSE" ? null : normalizeDate(tpexMarginPayload?.tables?.[0]?.date),
        ...Object.fromEntries(Object.entries(margin).filter(([key]) => key !== "ticker").map(([key, value]) => [key, round(value, 0)]))
      } : null,
      institutional: institutional ? {
        as_of: record.market === "TWSE" ? normalizeDate(twseInstitutionalPayload.date) : normalizeDate(tpexInstitutionalPayload?.tables?.[0]?.date),
        ...Object.fromEntries(Object.entries(institutional).filter(([key]) => key !== "ticker").map(([key, value]) => [key, round(value, 0)]))
      } : null,
      source_ids: sourceIds,
      status: valuation || margin || institutional ? "ok" : "missing"
    };
  }

  const researchFactors = Object.fromEntries(Object.entries(factors).filter(([key]) => researchKeys.has(key)));
  const output = {
    version: DATA_VERSION,
    generated_at: requestedGeneratedAt,
    note: "全市場背景因子。估值百分位依上市櫃官方產業全樣本計算；官方產業樣本不足 10 家時才回退為全市場模板樣本，兩者皆不使用觀察清單。資料僅供研究快照與回測，尚未納入核心分數。",
    sources: MARKET_FACTOR_SOURCE_IDS,
    coverage: {
      universe_count: universe.length,
      research_company_count: researchKeys.size,
      valuation_count: Object.values(factors).filter((item) => item.valuation).length,
      margin_count: Object.values(factors).filter((item) => item.margin).length,
      institutional_count: Object.values(factors).filter((item) => item.institutional).length
    },
    // The whole universe is calculated in memory for the peer ranks. Persist only
    // research companies so daily data commits do not grow with a full-market snapshot.
    companies: researchFactors
  };
  await writeJson(outputPath, output);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await updateMarketFactors();
  console.log(JSON.stringify(output.coverage));
}
