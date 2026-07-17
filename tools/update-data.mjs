import path from "node:path";
import {
  DATA_VERSION,
  SOURCE_CATALOG,
  average,
  clamp,
  evidenceFromCount,
  fetchJson,
  monthStarts,
  readJson,
  rocCompactDateToIso,
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
import { generatePublicFacts } from "./generate-public-facts.mjs";
import { classifyMaterialEvents, loadEventTaxonomy, scoreRiskDimension } from "./event-risk.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");
const companiesPath = path.join(dataDir, "companies.json");
const generatedAt = new Date().toISOString();
const runDate = new Date();
const priceMonths = monthStarts(runDate, 13).reverse();

const companiesJson = await readJson(companiesPath);
const companies = companiesJson.companies || [];
const templatesJson = await readJson(path.join(dataDir, "industry_templates.json"));
const industryTemplates = templatesJson.industries || {};
const scoringRules = await readJson(path.join(dataDir, "scoring_rules.json"));
const riskDimensionDefinition = (scoringRules.common_dimensions || []).find((dimension) => dimension.id === "riskNews");
const eventTaxonomy = await loadEventTaxonomy(path.join(dataDir, "event_taxonomy.json"));
const requestedTickers = new Set(
  (process.argv.find((arg) => arg.startsWith("--tickers=")) || "")
    .replace("--tickers=", "")
    .split(",")
    .map((ticker) => ticker.trim())
    .filter((ticker) => /^\d{4}$/.test(ticker))
);
const targetedRun = requestedTickers.size > 0;
const targetCompanies = targetedRun
  ? companies.filter((company) => requestedTickers.has(company.ticker))
  : companies;

if (targetedRun && !targetCompanies.length) {
  throw new Error("找不到指定股票代號的研究檔");
}

async function readGeneratedCompanies(fileName) {
  try {
    const payload = await readJson(path.join(dataDir, fileName));
    return payload.companies || {};
  } catch {
    return {};
  }
}

async function withGeneratedFallback(fileName, producer) {
  try {
    return await producer();
  } catch (error) {
    console.warn(`WARN: ${fileName} update failed, using cached data if available. ${error.message}`);
    return readGeneratedCompanies(fileName);
  }
}

function sourceIdsForMarket(company, kind) {
  if (kind === "price") return [company.market === "TWSE" ? "twse_stock_day" : "tpex_trading_stock"];
  if (kind === "revenue") return [company.market === "TWSE" ? "twse_monthly_revenue" : "tpex_monthly_revenue"];
  if (kind === "income") return [company.market === "TWSE" ? "twse_income_statement" : "tpex_income_statement"];
  if (kind === "balance") return [company.market === "TWSE" ? "twse_balance_sheet" : "tpex_balance_sheet"];
  if (kind === "events") return [company.market === "TWSE" ? "twse_material_events" : "tpex_material_events"];
  if (kind === "holders") return [company.market === "TWSE" ? "twse_major_shareholders" : "tpex_major_shareholders"];
  if (kind === "insider") return [company.market === "TWSE" ? "twse_insider_transfer" : "tpex_insider_transfer"];
  if (kind === "violations") return [company.market === "TWSE" ? "twse_disclosure_violations" : "tpex_disclosure_violations"];
  return [];
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
  const yoy = toNumber(row["營業收入-去年同月增減(%)"]);
  const mom = toNumber(row["營業收入-上月比較增減(%)"]);
  const cumulativeYoy = toNumber(row["累計營業收入-前期比較增減(%)"]);
  const yoyScore = scoreByThresholds(yoy, [[20, 85], [10, 75], [3, 65], [0, 58], [-10, 48], [-999, 35]], 45);
  const momScore = scoreByThresholds(mom, [[10, 70], [0, 58], [-10, 50], [-999, 42]], 50);
  const cumulativeScore = scoreByThresholds(cumulativeYoy, [[15, 82], [8, 72], [3, 64], [0, 58], [-10, 48], [-999, 35]], 45);
  return Math.round(yoyScore * 0.5 + momScore * 0.2 + cumulativeScore * 0.3);
}

function marginScore(value, thresholds) {
  return scoreByThresholds(value, thresholds, 45);
}

function financialScoreFrom(income, balance) {
  const revenue = toNumber(income?.["營業收入"]);
  const grossProfit = toNumber(income?.["營業毛利（毛損）淨額"]) ?? toNumber(income?.["營業毛利（毛損）"]);
  const operatingIncome = toNumber(income?.["營業利益（損失）"]);
  const netIncome = toNumber(income?.["本期淨利（淨損）"]);
  const eps = toNumber(income?.["基本每股盈餘（元）"]);
  const currentAssets = toNumber(balance?.["流動資產"]);
  const currentLiabilities = toNumber(balance?.["流動負債"]);
  const totalAssets = toNumber(balance?.["資產總額"]) ?? toNumber(balance?.["資產總計"]);
  const totalLiabilities = toNumber(balance?.["負債總額"]) ?? toNumber(balance?.["負債總計"]);

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

  const score = Math.round(
    grossScore * 0.2 +
    opScore * 0.25 +
    netScore * 0.15 +
    liquidityScore * 0.15 +
    debtScore * 0.15 +
    epsScore * 0.1
  );

  return {
    score,
    grossMargin: round(grossMargin),
    operatingMargin: round(operatingMargin),
    netMargin: round(netMargin),
    currentRatio: round(currentRatio),
    debtRatio: round(debtRatio),
    eps: round(eps, 2)
  };
}

function rowCode(row) {
  return row?.["公司代號"] || row?.SecuritiesCompanyCode;
}

function rowName(row) {
  return row?.["公司名稱"] || row?.CompanyName;
}

function eventTitle(row) {
  return normalizeDisclosureText(row?.["主旨 "] || row?.["主旨"] || "");
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

function compactOrSlashDate(value) {
  if (!value) return null;
  return String(value).includes("/") ? rocDateToIso(value) : rocCompactDateToIso(value);
}

const positiveEventKeywords = [
  "新產品", "新品", "合作", "策略聯盟", "核准", "許可", "通過", "訂單", "合約",
  "增資子公司", "營收創新高", "獲利", "股利"
];

const negativeEventKeywords = [
  "澄清", "更正", "違反", "裁罰", "訴訟", "退票", "喪失債信", "背書保證",
  "資金貸與", "停止買賣", "下市", "下櫃", "虧損", "減損", "內控",
  "重大缺失", "召回"
];

const neutralEventKeywords = [
  "承諾事項", "後續執行情形", "例行公告", "股東常會", "除息", "除權"
];

function classifyEventsLegacy(events) {
  let positive = 0;
  let negative = 0;
  const tagged = events.map((event) => {
    const title = String(event.title || "");
    const neutralHit = neutralEventKeywords.some((keyword) => title.includes(keyword));
    const positiveHit = positiveEventKeywords.some((keyword) => title.includes(keyword));
    const negativeHit = negativeEventKeywords.some((keyword) => title.includes(keyword));
    if (!neutralHit && positiveHit) positive += 1;
    if (!neutralHit && negativeHit) negative += 1;
    return {
      ...event,
      sentiment: neutralHit ? "neutral" : negativeHit ? "negative" : positiveHit ? "positive" : "neutral"
    };
  });
  return { events: tagged, positive, negative };
}

function classifyEvents(events) {
  const classifiedRisk = classifyMaterialEvents(events, eventTaxonomy);
  let positive = 0;
  const tagged = classifiedRisk.events.map((event) => {
    const title = String(event.title || "");
    const positiveHit = event.risk_class === "neutral" && positiveEventKeywords.some((keyword) => title.includes(keyword));
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

function catalystScoreFrom({ events, revenue, financial }) {
  const { positive, negative } = classifyEvents(events);
  const revenueScore = revenue?.score ?? 45;
  const financialScore = financial?.score ?? 45;
  let score = 45;
  if (revenueScore >= 80) score += 20;
  else if (revenueScore >= 70) score += 14;
  else if (revenueScore >= 60) score += 8;
  if (financialScore >= 75) score += 12;
  else if (financialScore >= 65) score += 8;
  score += Math.min(positive * 8, 20);
  score += events.length ? 3 : 0;
  score -= Math.min(negative * 6, 18);
  return clamp(Math.round(score), 30, 90);
}

function riskScoreFrom({ events, violations }) {
  const classified = classifyEvents(events);
  return scoreRiskDimension({
    negative_event_points: classified.negative_event_points,
    review_event_count: classified.review_event_count,
    disclosure_violation_count: violations?.length || 0
  }, riskDimensionDefinition) ?? 50;
}

function ownershipScoreFrom({ holders, insiderTransfers, violations }) {
  let score = 55;
  if (holders.length) score += 10;
  if (!insiderTransfers.length) score += 8;
  if (insiderTransfers.length) score -= Math.min(insiderTransfers.length * 10, 25);
  if (violations.length) score -= Math.min(violations.length * 15, 30);
  return clamp(Math.round(score), 30, 80);
}

function traceabilityScoreFrom(company) {
  const sourceIds = new Set([
    ...(company.primary_source_ids || []),
    ...Object.values(company.facts || {}).flatMap((fact) => fact.source_ids || [])
  ]);
  let score = 45;
  if ([...sourceIds].some((id) => id.includes("official"))) score += 10;
  if (sourceIds.has("mops")) score += 8;
  if (sourceIds.has("tfda")) score += 8;
  if (sourceIds.has("twse_company_basic") || sourceIds.has("tpex_company_basic")) score += 6;
  return clamp(score, 35, 80);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function companySourceIds(company) {
  return unique([
    ...(company.primary_source_ids || []),
    ...Object.values(company.facts || {}).flatMap((fact) => fact.source_ids || [])
  ]);
}

function factEvidence(company, fieldIds) {
  const facts = fieldIds
    .map((fieldId) => ({ fieldId, ...(company.facts?.[fieldId] || {}) }))
    .filter((fact) => String(fact.value || "").trim());
  return {
    text: facts.map((fact) => String(fact.value).trim()).join(" "),
    sourceIds: unique(facts.flatMap((fact) => fact.source_ids || [])),
    factCount: facts.length
  };
}

function evidenceIsUsable(evidence, requirements, policy) {
  const minimumTextLength = Number(requirements?.minimum_text_length ?? policy?.minimum_text_length ?? 12);
  const minimumSourceCount = Number(requirements?.minimum_fact_source_count ?? policy?.minimum_fact_source_count ?? 1);
  const text = String(evidence.text || "").trim();
  const placeholderPatterns = policy?.placeholder_patterns || [];
  const isPlaceholder = placeholderPatterns.some((pattern) => text.includes(pattern));
  return Boolean(
    evidence.factCount
    && text.length >= minimumTextLength
    && evidence.sourceIds.length >= minimumSourceCount
    && !isPlaceholder
  );
}

function scoreFromTraceableText(text, sourceIds, base = 48) {
  const hasText = text.trim().length > 12;
  const officialCount = sourceIds.filter((id) => id.includes("official")).length;
  let score = base;
  if (hasText) score += 8;
  if (sourceIds.includes("tfda")) score += 6;
  if (sourceIds.includes("mops")) score += 6;
  if (officialCount) score += Math.min(officialCount * 4, 8);
  if (/待補|尚未|需補|待接|未做/.test(text)) score -= 8;
  return clamp(Math.round(score), 35, 78);
}

function evidenceLevelFromScore(score) {
  if (score >= 70) return "high";
  if (score >= 56) return "medium";
  if (score >= 45) return "low";
  return "none";
}

function matchedPatterns(text, patterns = []) {
  return [...new Set(patterns.filter((pattern) => text.includes(pattern)))];
}

function evidenceDirection(text, policy) {
  const signals = policy?.directional_signals || {};
  const positive = matchedPatterns(text, signals.positive_patterns);
  const negative = matchedPatterns(text, signals.negative_patterns);
  const severeNegative = matchedPatterns(text, signals.severe_negative_patterns);
  const strongPositiveMinimum = Number(signals.strong_positive_minimum_matches || 2);
  const strongNegativeMinimum = Number(signals.strong_negative_minimum_matches || 2);

  if (severeNegative.length || (negative.length >= strongNegativeMinimum && negative.length > positive.length)) {
    return { id: "strong_negative", matches: { positive, negative, severe_negative: severeNegative } };
  }
  if (positive.length >= strongPositiveMinimum && !negative.length) {
    return { id: "strong_positive", matches: { positive, negative, severe_negative: severeNegative } };
  }
  if (positive.length > negative.length) return { id: "positive", matches: { positive, negative, severe_negative: severeNegative } };
  if (negative.length > positive.length) return { id: "negative", matches: { positive, negative, severe_negative: severeNegative } };
  return { id: "neutral", matches: { positive, negative, severe_negative: severeNegative } };
}

function fieldIdsForEvidenceDimension(dimension, template) {
  return dimension.fact_fields || template.default_fact_fields || [];
}

function buildIndustryEvidenceData() {
  const companiesById = {};
  const policy = templatesJson.industry_evidence_policy || {};

  for (const company of companies) {
    const template = industryTemplates[company.industry_template] || {};
    const dimensions = template.industry_evidence_dimensions || [];
    const traceabilityScore = traceabilityScoreFrom(company);

    let weighted = 0;
    let weightSum = 0;
    const dimensionRows = dimensions.map((dimension) => {
      const fieldIds = fieldIdsForEvidenceDimension(dimension, template);
      const evidence = factEvidence(company, fieldIds);
      const usable = evidenceIsUsable(evidence, dimension.minimum_evidence, policy);
      const score = usable ? scoreFromTraceableText(evidence.text, evidence.sourceIds) : null;
      const status = usable ? "ok" : "missing";
      const rationale = usable
        ? `依來源支持的研究欄位「${fieldIds.join("、")}」計算。`
        : `尚未取得可追溯的公司事實；需要欄位「${fieldIds.join("、")}」及至少 ${dimension.minimum_evidence?.minimum_fact_source_count ?? policy.minimum_fact_source_count ?? 1} 個來源。`;

      if (status === "ok") {
        weighted += score * (dimension.weight || 0);
        weightSum += dimension.weight || 0;
      }
      return {
        id: dimension.id,
        label: dimension.label,
        weight: dimension.weight,
        status,
        score,
        evidence_level: Number.isFinite(score) ? evidenceLevelFromScore(score) : "none",
        source_ids: evidence.sourceIds,
        evidence_text: evidence.text,
        description: dimension.description,
        rationale
      };
    });

    const completedCount = dimensionRows.filter((dimension) => dimension.status === "ok").length;
    const complete = dimensions.length > 0 && completedCount === dimensions.length && weightSum > 0;
    const score = complete ? Math.round(weighted / weightSum) : null;
    const evidenceText = [...new Set(dimensionRows
      .filter((dimension) => dimension.status === "ok")
      .map((dimension) => dimension.evidence_text)
      .filter(Boolean))]
      .join(" ");
    const direction = complete ? evidenceDirection(evidenceText, policy) : { id: "pending", matches: { positive: [], negative: [], severe_negative: [] } };
    companiesById[company.id] = {
      ticker: company.ticker,
      market: company.market,
      industry_template: company.industry_template,
      status: complete ? "ok" : "missing",
      source_ids: unique(dimensionRows.flatMap((dimension) => dimension.source_ids || [])),
      evidence_level: Number.isFinite(score) ? evidenceLevelFromScore(score) : "none",
      completed_count: completedCount,
      total_count: dimensions.length,
      traceability_score: traceabilityScore,
      score,
      direction: direction.id,
      direction_matches: direction.matches,
      dimensions: dimensionRows,
      rationale: dimensions.length
        ? complete
          ? `${template.label || company.industry_template} 產業證據 ${completedCount}/${dimensions.length} 項皆有來源支持；分數由各子項權重合成。`
          : `${template.label || company.industry_template} 產業證據僅 ${completedCount}/${dimensions.length} 項具來源支持；未完成前不產生產業分數。`
        : "此產業尚未定義產業證據模板。"
    };
  }

  return companiesById;
}

function buildIndustryData({ revenueCompanies, financialCompanies, catalystCompanies, riskCompanies, industryEvidenceCompanies }) {
  const companiesById = {};
  for (const company of companies) {
    const revenue = revenueCompanies[company.id];
    const financial = financialCompanies[company.id];
    const catalyst = catalystCompanies[company.id];
    const risk = riskCompanies[company.id];
    const industryEvidence = industryEvidenceCompanies[company.id];
    const traceabilityScore = traceabilityScoreFrom(company);
    const complete = industryEvidence?.status === "ok";
    const score = complete ? Math.round(
      industryEvidence.score * 0.35 +
      (revenue?.score ?? 50) * 0.2 +
      (financial?.score ?? 50) * 0.2 +
      (risk?.score ?? 50) * 0.15 +
      (catalyst?.score ?? 50) * 0.05 +
      traceabilityScore * 0.05
    ) : null;

    companiesById[company.id] = {
      ticker: company.ticker,
      market: company.market,
      industry_template: company.industry_template,
      status: complete ? "ok" : "missing",
      source_ids: unique([
        ...(company.primary_source_ids || []),
        ...(revenue?.source_ids || []),
        ...(financial?.source_ids || []),
        ...(catalyst?.source_ids || []),
        ...(risk?.source_ids || []),
        ...(industryEvidence?.source_ids || [])
      ]),
      evidence_level: complete ? "medium" : "none",
      traceability_score: traceabilityScore,
      industry_evidence_score: industryEvidence?.score ?? null,
      industry_evidence_completed_count: industryEvidence?.completed_count ?? null,
      industry_evidence_total_count: industryEvidence?.total_count ?? null,
      revenue_score: revenue?.score ?? null,
      financial_score: financial?.score ?? null,
      catalyst_score: catalyst?.score ?? null,
      risk_score: risk?.score ?? null,
      score: Number.isFinite(score) ? clamp(score) : null,
      rationale: complete
        ? `產業基本面由產業證據 ${industryEvidence.score}、營收 ${revenue?.score ?? "NA"}、財務 ${financial?.score ?? "NA"}、風險 ${risk?.score ?? "NA"}、催化 ${catalyst?.score ?? "NA"}、來源可追溯度 ${traceabilityScore} 加權合成。`
        : "產業證據尚未完成所有來源支持的子檢核，因此不產生產業基本面分數。"
    };
  }
  return companiesById;
}

async function fetchSecondaryPriceHistory(company) {
  const suffix = company.market === "TWSE" ? ".TW" : ".TWO";
  const start = Math.floor(new Date(runDate.getFullYear() - 1, runDate.getMonth(), runDate.getDate()).getTime() / 1000);
  const end = Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${company.ticker}${suffix}?period1=${start}&period2=${end}&interval=1d&events=history`;
  const payload = await fetchJson(url, 2, 8000);
  const result = payload.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!Array.isArray(result?.timestamp) || !Array.isArray(quote?.close)) {
    throw new Error("次要股價來源未回傳日線資料");
  }
  return result.timestamp.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    close: Number(quote.close[index]),
    volume: Number(quote.volume?.[index]),
    source_id: "yahoo_finance_chart"
  })).filter((row) => Number.isFinite(row.close));
}

async function fetchPriceHistory(company) {
  const rows = [];
  const errors = [];
  let failedMonthsInRow = 0;
  for (const month of priceMonths) {
    try {
      if (company.market === "TWSE") {
        const date = twDateParam(month);
        const urls = [
          `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${date}&stockNo=${company.ticker}&response=json`,
          `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${date}&stockNo=${company.ticker}`
        ];
        let payload = null;
        let lastError = "官方端點未回傳可用資料";
        for (const url of urls) {
          try {
            const candidate = await fetchJson(url, 2, 8000);
            if (candidate.stat === "OK" && Array.isArray(candidate.data)) {
              payload = candidate;
              break;
            }
            lastError = `官方端點回覆 ${candidate.stat || "未知狀態"}`;
          } catch (error) {
            lastError = error.message;
          }
        }
        if (!payload) throw new Error(lastError);
        for (const item of payload.data) {
          rows.push({
            date: rocDateToIso(item[0]),
            close: toNumber(item[6]),
            volume: toNumber(item[1]),
            source_id: "twse_stock_day"
          });
        }
      } else {
        const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${company.ticker}&date=${encodeURIComponent(tpexDateParam(month))}&id=&response=json`;
        const payload = await fetchJson(url);
        const table = payload.tables?.[0];
        if (payload.stat !== "ok" || !Array.isArray(table?.data)) {
          throw new Error(`官方端點回覆 ${payload.stat || "未知狀態"}`);
        }
        for (const item of table.data) {
          rows.push({
            date: rocDateToIso(item[0]),
            close: toNumber(item[6]),
            volume: toNumber(item[1]) ? toNumber(item[1]) * 1000 : null,
            source_id: "tpex_trading_stock"
          });
        }
      }
      failedMonthsInRow = 0;
    } catch (error) {
      errors.push(`${month.toISOString().slice(0, 7)}: ${error.message}`);
      failedMonthsInRow += 1;
      if (failedMonthsInRow >= 2) break;
    }
  }

  const byDate = new Map();
  for (const row of rows) {
    if (row.date && Number.isFinite(row.close)) byDate.set(row.date, row);
  }
  if (!byDate.size) {
    try {
      for (const row of await fetchSecondaryPriceHistory(company)) byDate.set(row.date, row);
    } catch (error) {
      errors.push(`secondary market data: ${error.message}`);
    }
  }
  const history = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const closes = history.map((row) => row.close);
  const latest = history.at(-1);
  const yearHigh = closes.length ? Math.max(...closes) : null;
  const yearLow = closes.length ? Math.min(...closes) : null;
  const extremeRange = yearHigh && yearLow ? yearHigh / yearLow > 4 : false;
  const rangeHistory = extremeRange ? history.slice(-60) : history;
  const rangeCloses = rangeHistory.map((row) => row.close);
  const scoringHigh = rangeCloses.length ? Math.max(...rangeCloses) : null;
  const scoringLow = rangeCloses.length ? Math.min(...rangeCloses) : null;
  const positionPct = latest && scoringHigh !== scoringLow ? ((latest.close - scoringLow) / (scoringHigh - scoringLow)) * 100 : null;
  const ma20 = average(closes.slice(-20));
  const ma60 = average(closes.slice(-60));
  const close20 = closes.length > 20 ? closes.at(-21) : null;
  const close60 = closes.length > 60 ? closes.at(-61) : null;
  const return20d = close20 ? ((latest.close / close20) - 1) * 100 : null;
  const return60d = close60 ? ((latest.close / close60) - 1) * 100 : null;
  const score = Math.round(
    pricePositionScore(positionPct) * 0.4 +
    return20Score(return20d) * 0.3 +
    return60Score(return60d) * 0.3
  );

  return {
    ticker: company.ticker,
    market: company.market,
    status: history.length ? "ok" : "missing",
    source_ids: history.length ? unique(history.map((row) => row.source_id)) : sourceIdsForMarket(company, "price"),
    evidence_level: evidenceFromCount(history.length),
    trading_days: history.length,
    latest_trade_date: latest?.date || null,
    latest_close: latest?.close ?? null,
    year_high: yearHigh,
    year_low: yearLow,
    price_range_basis: extremeRange ? "近 60 個交易日區間；一年高低價比例過大，可能受面額、除權息或未調整價格影響。" : "近一年交易區間",
    scoring_high: scoringHigh,
    scoring_low: scoringLow,
    position_pct: round(positionPct),
    ma20: round(ma20),
    ma60: round(ma60),
    return_20d_pct: round(return20d),
    return_60d_pct: round(return60d),
    score: clamp(score),
    rationale: latest
      ? `近 ${history.length} 個交易日，收盤 ${latest.close}，位於${extremeRange ? "近 60 日" : "一年"}區間 ${round(positionPct)}%，20 日報酬 ${round(return20d)}%，60 日報酬 ${round(return60d)}%。`
      : "未取得足夠股價資料。",
    errors
  };
}

async function fetchRevenueData(companiesToUpdate = companies) {
  const twseRows = await getCachedRows("twse_monthly_revenue");
  const tpexRows = await getCachedRows("tpex_monthly_revenue");
  const rows = [...twseRows, ...tpexRows];
  const companiesById = {};

  for (const company of companiesToUpdate) {
    const row = rows.find((item) => item["公司代號"] === company.ticker);
    if (!row) {
      companiesById[company.id] = {
        ticker: company.ticker,
        market: company.market,
        status: "missing",
        source_ids: sourceIdsForMarket(company, "revenue"),
        evidence_level: "none",
        score: 45,
        rationale: "未取得月營收資料。"
      };
      continue;
    }

    const score = revenueScoreFrom(row);
    const yoy = toNumber(row["營業收入-去年同月增減(%)"]);
    const mom = toNumber(row["營業收入-上月比較增減(%)"]);
    const cumulativeYoy = toNumber(row["累計營業收入-前期比較增減(%)"]);
    companiesById[company.id] = {
      ticker: company.ticker,
      market: company.market,
      status: "ok",
      source_ids: sourceIdsForMarket(company, "revenue"),
      evidence_level: "high",
      data_month: rocMonthToIso(row["資料年月"]),
      current_revenue_thousand_twd: toNumber(row["營業收入-當月營收"]),
      previous_month_revenue_thousand_twd: toNumber(row["營業收入-上月營收"]),
      last_year_month_revenue_thousand_twd: toNumber(row["營業收入-去年當月營收"]),
      mom_pct: round(mom),
      yoy_pct: round(yoy),
      cumulative_revenue_thousand_twd: toNumber(row["累計營業收入-當月累計營收"]),
      cumulative_yoy_pct: round(cumulativeYoy),
      score,
      rationale: `${rocMonthToIso(row["資料年月"])} 月營收 YoY ${round(yoy)}%，MoM ${round(mom)}%，累計 YoY ${round(cumulativeYoy)}%。`
    };
  }
  return companiesById;
}

async function fetchFinancialData(companiesToUpdate = companies) {
  const [twseIncome, tpexIncome, twseBalance, tpexBalance] = await Promise.all([
    getCachedRows("twse_income_statement"),
    getCachedRows("tpex_income_statement"),
    getCachedRows("twse_balance_sheet"),
    getCachedRows("tpex_balance_sheet")
  ]);

  const incomeRows = [...twseIncome, ...tpexIncome];
  const balanceRows = [...twseBalance, ...tpexBalance];
  const companiesById = {};

  for (const company of companiesToUpdate) {
    const income = incomeRows.find((item) => (item["公司代號"] || item.SecuritiesCompanyCode) === company.ticker);
    const balance = balanceRows.find((item) => (item["公司代號"] || item.SecuritiesCompanyCode) === company.ticker);
    if (!income || !balance) {
      companiesById[company.id] = {
        ticker: company.ticker,
        market: company.market,
        status: "missing",
        source_ids: [...sourceIdsForMarket(company, "income"), ...sourceIdsForMarket(company, "balance")],
        evidence_level: "none",
        score: 45,
        rationale: "未取得完整損益表或資產負債表資料。"
      };
      continue;
    }

    const scoreData = financialScoreFrom(income, balance);
    const fiscalYear = String(Number(income["年度"] || income.Year) + 1911);
    const fiscalQuarter = income["季別"] || income.Season;
    companiesById[company.id] = {
      ticker: company.ticker,
      market: company.market,
      status: "ok",
      source_ids: [...sourceIdsForMarket(company, "income"), ...sourceIdsForMarket(company, "balance")],
      evidence_level: "high",
      year: fiscalYear,
      quarter: fiscalQuarter,
      revenue_thousand_twd: toNumber(income["營業收入"]),
      gross_margin_pct: scoreData.grossMargin,
      operating_margin_pct: scoreData.operatingMargin,
      net_margin_pct: scoreData.netMargin,
      current_ratio: scoreData.currentRatio,
      debt_ratio_pct: scoreData.debtRatio,
      eps: scoreData.eps,
      book_value_per_share: round(toNumber(balance["每股參考淨值"]), 2),
      score: scoreData.score,
      rationale: `${fiscalYear}Q${fiscalQuarter} 毛利率 ${scoreData.grossMargin}%，營益率 ${scoreData.operatingMargin}%，流動比率 ${scoreData.currentRatio}，負債比率 ${scoreData.debtRatio}%。`
    };
  }
  return companiesById;
}

async function fetchEventRows() {
  const [twseEvents, tpexEvents] = await Promise.all([
    getCachedRows("twse_material_events"),
    getCachedRows("tpex_material_events")
  ]);
  return [...twseEvents, ...tpexEvents];
}

async function fetchGovernanceRows() {
  const [twseHolders, tpexHolders, twseTransfers, tpexTransfers, twseViolations, tpexViolations] = await Promise.all([
    getCachedRows("twse_major_shareholders"),
    getCachedRows("tpex_major_shareholders"),
    getCachedRows("twse_insider_transfer"),
    getCachedRows("tpex_insider_transfer"),
    getCachedRows("twse_disclosure_violations"),
    getCachedRows("tpex_disclosure_violations")
  ]);
  return {
    holders: [...twseHolders, ...tpexHolders],
    transfers: [...twseTransfers, ...tpexTransfers],
    violations: [...twseViolations, ...tpexViolations]
  };
}

function normalizeEvent(row) {
  const title = eventTitle(row);
  return {
    date: compactOrSlashDate(row["事實發生日"]) || compactOrSlashDate(row["發言日期"]),
    announce_date: compactOrSlashDate(row["發言日期"]),
    time: row["發言時間"] || null,
    title,
    clause: row["符合條款"] || null,
    description: normalizeDisclosureText(row["說明"] || ""),
    source_id: row["公司代號"] ? "twse_material_events" : "tpex_material_events"
  };
}

function buildCatalystAndRiskData(eventRows, revenueCompanies, financialCompanies, violationsByCompany, companiesToUpdate = companies) {
  const catalystCompanies = {};
  const riskCompanies = {};

  for (const company of companiesToUpdate) {
    const rows = eventRows.filter((row) => rowCode(row) === company.ticker);
    const normalized = rows.map(normalizeEvent);
    const classified = classifyEvents(normalized);
    const recentEvents = classified.events
      .sort((a, b) => (b.announce_date || "").localeCompare(a.announce_date || ""))
      .slice(0, 8);
    const revenue = revenueCompanies[company.id];
    const financial = financialCompanies[company.id];
    const violations = violationsByCompany[company.id] || [];
    const catalystScore = catalystScoreFrom({ events: classified.events, revenue, financial });
    const riskScore = riskScoreFrom({ events: classified.events, violations });
    const catalystBits = [
      revenue?.score >= 70 ? `月營收分數 ${revenue.score}` : null,
      financial?.score >= 65 ? `財務品質分數 ${financial.score}` : null,
      classified.positive ? `正向重大訊息 ${classified.positive} 則` : null,
      classified.negative ? `負向/待釐清重大訊息 ${classified.negative} 則` : null
    ].filter(Boolean);
    const riskBits = [
      classified.negative ? `負向/待釐清重大訊息 ${classified.negative} 則` : "未偵測到負向重大訊息關鍵字",
      violations.length ? `資訊申報/重大訊息違規 ${violations.length} 筆` : "未偵測到資訊申報違規"
    ];

    catalystCompanies[company.id] = {
      ticker: company.ticker,
      market: company.market,
      status: "ok",
      source_ids: sourceIdsForMarket(company, "events"),
      evidence_level: rows.length ? "high" : "medium",
      event_count: rows.length,
      positive_event_count: classified.positive,
      negative_event_count: classified.negative,
      score: catalystScore,
      rationale: catalystBits.length ? catalystBits.join("；") + "。" : "近期重大訊息較少，主要依月營收與財務品質判斷催化。",
      events: recentEvents
    };

    riskCompanies[company.id] = {
      ticker: company.ticker,
      market: company.market,
      status: "ok",
      source_ids: [...sourceIdsForMarket(company, "events"), ...sourceIdsForMarket(company, "violations")],
      evidence_level: "high",
      event_count: rows.length,
      negative_event_count: classified.negative,
      positive_event_count: classified.positive,
      review_event_count: classified.review,
      negative_event_points: classified.negative_event_points,
      negative_event_categories: classified.negative_event_categories,
      disclosure_violation_count: violations.length,
      score: riskScore,
      rationale: riskBits.join("；") + "。",
      events: recentEvents.filter((event) => event.risk_class === "negative" || event.risk_class === "review").slice(0, 5),
      violations
    };
  }

  return { catalystCompanies, riskCompanies };
}

function buildOwnershipData(governanceRows, companiesToUpdate = companies) {
  const companiesById = {};
  for (const company of companiesToUpdate) {
    const holders = governanceRows.holders
      .filter((row) => rowCode(row) === company.ticker)
      .map((row) => ({
        name: row["大股東名稱"] || row["NameOfMajorShareholder"] || "",
        source_id: row["公司代號"] ? "twse_major_shareholders" : "tpex_major_shareholders"
      }))
      .filter((holder) => holder.name);
    const insiderTransfers = governanceRows.transfers
      .filter((row) => rowCode(row) === company.ticker)
      .map((row) => ({
        date: compactOrSlashDate(row["申報日期"] || row.Date),
        holder: row["申報人姓名"] || row["姓名"] || row.Name || "",
        shares: toNumber(row["預定轉讓股數"] || row["轉讓股數"] || row.TransferShares),
        source_id: row["公司代號"] ? "twse_insider_transfer" : "tpex_insider_transfer"
      }));
    const violations = governanceRows.violations
      .filter((row) => rowCode(row) === company.ticker)
      .map((row) => ({
        date: compactOrSlashDate(row["處分日期"] || row.Date),
        title: row["違規情形"] || row["違反事項"] || row["主旨"] || rowName(row) || "資訊申報違規",
        source_id: row["公司代號"] ? "twse_disclosure_violations" : "tpex_disclosure_violations"
      }));
    const score = ownershipScoreFrom({ holders, insiderTransfers, violations });
    const rationale = [
      holders.length ? `持股逾 10% 大股東 ${holders.length} 名` : "未列示持股逾 10% 大股東",
      insiderTransfers.length ? `近期內部人轉讓申報 ${insiderTransfers.length} 筆` : "未偵測到近期內部人轉讓申報",
      violations.length ? `資訊申報違規 ${violations.length} 筆` : "未偵測到資訊申報違規"
    ].join("；") + "。";

    companiesById[company.id] = {
      ticker: company.ticker,
      market: company.market,
      status: "ok",
      source_ids: [
        ...sourceIdsForMarket(company, "holders"),
        ...sourceIdsForMarket(company, "insider"),
        ...sourceIdsForMarket(company, "violations")
      ],
      evidence_level: "high",
      major_shareholder_count: holders.length,
      insider_transfer_count: insiderTransfers.length,
      disclosure_violation_count: violations.length,
      score,
      rationale,
      major_shareholders: holders.slice(0, 5),
      insider_transfers: insiderTransfers.slice(0, 5),
      violations: violations.slice(0, 5)
    };
  }
  return companiesById;
}

function mergeUpdatedRecords(previousRecords, updatedRecords) {
  const recovered = Object.fromEntries(Object.entries(updatedRecords).map(([id, record]) => {
    const previous = previousRecords[id];
    if (record?.status === "missing" && previous?.status === "ok") {
      return [id, {
        ...previous,
        cache_status: "stale",
        rationale: `${previous.rationale || "已使用先前公開資料。"} 本次端點未回傳資料，暫時保留上一版快取。`
      }];
    }
    return [id, record];
  }));
  return targetedRun ? { ...previousRecords, ...recovered } : recovered;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(workers);
}

async function build() {
  const [previousMarket, previousRevenue, previousFinancial, previousCatalyst, previousOwnership, previousRisk] = await Promise.all([
    readGeneratedCompanies("market_data.json"),
    readGeneratedCompanies("revenue_data.json"),
    readGeneratedCompanies("financial_data.json"),
    readGeneratedCompanies("catalyst_data.json"),
    readGeneratedCompanies("ownership_data.json"),
    readGeneratedCompanies("risk_data.json")
  ]);
  const marketUpdates = await withGeneratedFallback("market_data.json", async () => {
    const records = {};
    await mapWithConcurrency(targetCompanies, 3, async (company) => {
      records[company.id] = await fetchPriceHistory(company);
    });
    return records;
  });
  const marketCompanies = mergeUpdatedRecords(previousMarket, marketUpdates);
  const revenueUpdates = await withGeneratedFallback("revenue_data.json", () => fetchRevenueData(targetCompanies));
  const revenueCompanies = mergeUpdatedRecords(previousRevenue, revenueUpdates);
  const financialUpdates = await withGeneratedFallback("financial_data.json", () => fetchFinancialData(targetCompanies));
  const financialCompanies = mergeUpdatedRecords(previousFinancial, financialUpdates);

  let ownershipCompanies;
  let catalystCompanies;
  let riskCompanies;
  try {
    const eventRows = await fetchEventRows();
    const governanceRows = await fetchGovernanceRows();
    const ownershipUpdates = buildOwnershipData(governanceRows, targetCompanies);
    ownershipCompanies = mergeUpdatedRecords(previousOwnership, ownershipUpdates);
    const violationsByCompany = Object.fromEntries(
      Object.entries(ownershipCompanies).map(([id, record]) => [id, record.violations || []])
    );
    const updates = buildCatalystAndRiskData(
      eventRows,
      revenueCompanies,
      financialCompanies,
      violationsByCompany,
      targetCompanies
    );
    catalystCompanies = mergeUpdatedRecords(previousCatalyst, updates.catalystCompanies);
    riskCompanies = mergeUpdatedRecords(previousRisk, updates.riskCompanies);
  } catch (error) {
    console.warn(`WARN: event/governance update failed, using cached data if available. ${error.message}`);
    ownershipCompanies = previousOwnership;
    catalystCompanies = previousCatalyst;
    riskCompanies = previousRisk;
  }
  const industryEvidenceCompanies = buildIndustryEvidenceData({
    revenueCompanies,
    financialCompanies,
    riskCompanies
  });
  const industryCompanies = buildIndustryData({
    revenueCompanies,
    financialCompanies,
    catalystCompanies,
    riskCompanies,
    industryEvidenceCompanies
  });

  const dataStatus = {
    version: DATA_VERSION,
    generated_at: generatedAt,
    note: "由 tools/update-data.mjs 產生。資料來源為公開市場 API；缺少來源支持的產業子檢核會標示待補，不以預設分數代替。",
    companies: {}
  };

  for (const company of companies) {
    const items = {
      catalyst: catalystCompanies[company.id]?.status || "missing",
      market: marketCompanies[company.id]?.status || "missing",
      revenue: revenueCompanies[company.id]?.status || "missing",
      financial: financialCompanies[company.id]?.status || "missing",
      ownership: ownershipCompanies[company.id]?.status || "missing",
      risk: riskCompanies[company.id]?.status || "missing",
      industry: industryCompanies[company.id]?.status || "missing"
    };
    dataStatus.companies[company.id] = {
      ticker: company.ticker,
      name: company.name,
      ...items,
      completed_count: Object.values(items).filter((value) => value === "ok").length,
      total_count: Object.keys(items).length
    };
  }

  await writeJson(path.join(dataDir, "market_data.json"), {
    version: DATA_VERSION,
    generated_at: generatedAt,
    sources: SOURCE_CATALOG.filter((source) => source.id.includes("stock")),
    companies: marketCompanies
  });
  await writeJson(path.join(dataDir, "revenue_data.json"), {
    version: DATA_VERSION,
    generated_at: generatedAt,
    sources: SOURCE_CATALOG.filter((source) => source.id.includes("revenue")),
    companies: revenueCompanies
  });
  await writeJson(path.join(dataDir, "financial_data.json"), {
    version: DATA_VERSION,
    generated_at: generatedAt,
    sources: SOURCE_CATALOG.filter((source) => source.id.includes("income") || source.id.includes("balance")),
    companies: financialCompanies
  });
  await writeJson(path.join(dataDir, "catalyst_data.json"), {
    version: DATA_VERSION,
    generated_at: generatedAt,
    sources: SOURCE_CATALOG.filter((source) => source.id.includes("material_events")),
    companies: catalystCompanies
  });
  await writeJson(path.join(dataDir, "ownership_data.json"), {
    version: DATA_VERSION,
    generated_at: generatedAt,
    sources: SOURCE_CATALOG.filter((source) => source.id.includes("shareholders") || source.id.includes("insider") || source.id.includes("violations")),
    companies: ownershipCompanies
  });
  await writeJson(path.join(dataDir, "risk_data.json"), {
    version: DATA_VERSION,
    generated_at: generatedAt,
    sources: SOURCE_CATALOG.filter((source) => source.id.includes("material_events") || source.id.includes("violations")),
    companies: riskCompanies
  });
  await writeJson(path.join(dataDir, "industry_evidence_data.json"), {
    version: DATA_VERSION,
    generated_at: generatedAt,
    note: "產業證據層。各產業子檢核僅在取得公司事實與來源支持時評分；模板本身與未填入欄位不會產生分數。",
    sources: SOURCE_CATALOG.filter((source) => source.id.startsWith("tfda") || source.id === "mops"),
    companies: industryEvidenceCompanies
  });
  await writeJson(path.join(dataDir, "industry_data.json"), {
    version: DATA_VERSION,
    generated_at: generatedAt,
    note: "產業基本面公式化資料。未完成來源支持的產業子檢核時，不產生產業基本面分數。",
    sources: SOURCE_CATALOG,
    companies: industryCompanies
  });
  await writeJson(path.join(dataDir, "data_status.json"), dataStatus);
  await generatePublicFacts({ generatedAt });

  console.log(`Generated objective data for ${targetCompanies.length} ${targetedRun ? "targeted" : "research"} companies.`);
}

await build();
