import path from "node:path";
import { pathToFileURL } from "node:url";
import { DATA_VERSION, SOURCE_CATALOG, readJson, writeJson } from "./data-sources.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function formatNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: digits }).format(number);
}

function formatPercent(value) {
  const formatted = formatNumber(value);
  return formatted === null ? null : `${formatted}%`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function shorten(value, maxLength = 96) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function fact(id, label, value, sourceIds) {
  if (!value || !sourceIds?.length) return null;
  return { id, label, value, source_ids: unique(sourceIds) };
}

async function readData(fileName) {
  try {
    return await readJson(path.join(dataDir, fileName));
  } catch {
    return { companies: {}, sources: [] };
  }
}

function sourceIdsForClassification(company) {
  const matched = (company.primary_source_ids || []).filter((id) => (
    id === "twse_company_basic" || id === "tpex_company_basic"
  ));
  if (matched.length) return matched;
  return [company.market === "TPEx" ? "tpex_company_basic" : "twse_company_basic"];
}

function buildFacts(company, datasets) {
  const market = datasets.market.companies?.[company.id];
  const revenue = datasets.revenue.companies?.[company.id];
  const financial = datasets.financial.companies?.[company.id];
  const catalyst = datasets.catalyst.companies?.[company.id];
  const ownership = datasets.ownership.companies?.[company.id];
  const risk = datasets.risk.companies?.[company.id];
  const templateLabel = datasets.templates.industries?.[company.industry_template]?.label || company.industry_template;
  const facts = [];

  facts.push(fact(
    "official_classification",
    "公司分類",
    company.official_industry_label
      ? `官方產業：${company.official_industry_label}；追蹤模板：${templateLabel}。`
      : "",
    sourceIdsForClassification(company)
  ));

  if (revenue?.status === "ok" && revenue.data_month && (isFiniteNumber(revenue.yoy_pct) || isFiniteNumber(revenue.mom_pct))) {
    const changes = [
      isFiniteNumber(revenue.yoy_pct) ? `年增 ${formatPercent(revenue.yoy_pct)}` : "",
      isFiniteNumber(revenue.mom_pct) ? `月增 ${formatPercent(revenue.mom_pct)}` : ""
    ].filter(Boolean).join("；");
    facts.push(fact("monthly_revenue", "月營收", `${revenue.data_month} 月營收${changes}。`, revenue.source_ids));
  }

  if (financial?.status === "ok" && financial.year && financial.quarter) {
    const metrics = [
      isFiniteNumber(financial.gross_margin_pct) ? `毛利率 ${formatPercent(financial.gross_margin_pct)}` : "",
      isFiniteNumber(financial.operating_margin_pct) ? `營益率 ${formatPercent(financial.operating_margin_pct)}` : "",
      isFiniteNumber(financial.eps) ? `EPS ${formatNumber(financial.eps)}` : ""
    ].filter(Boolean);
    facts.push(fact("financial_snapshot", "最新財報", metrics.length ? `${financial.year} Q${financial.quarter}：${metrics.join("；")}。` : "", financial.source_ids));
  }

  if (market?.status === "ok" && market.latest_trade_date && isFiniteNumber(market.latest_close)) {
    const returns = [
      isFiniteNumber(market.return_20d_pct) ? `20日 ${formatPercent(market.return_20d_pct)}` : "",
      isFiniteNumber(market.return_60d_pct) ? `60日 ${formatPercent(market.return_60d_pct)}` : ""
    ].filter(Boolean).join("；");
    facts.push(fact(
      "market_snapshot",
      "股價資料",
      `${market.latest_trade_date} 收盤 ${formatNumber(market.latest_close)}${returns ? `；區間報酬：${returns}` : ""}。`,
      market.source_ids
    ));
  }

  const latestEvent = catalyst?.status === "ok"
    ? (catalyst.events || []).find((event) => String(event.title || "").trim())
    : null;
  if (latestEvent) {
    facts.push(fact(
      "latest_disclosure",
      "近期重大訊息",
      `${latestEvent.announce_date || latestEvent.date || "近期"}：${shorten(latestEvent.title)}。`,
      [latestEvent.source_id, ...(catalyst.source_ids || [])]
    ));
  }

  if (ownership?.status === "ok" && Number(ownership.major_shareholder_count) > 0) {
    const names = unique((ownership.major_shareholders || []).map((holder) => holder?.name));
    facts.push(fact(
      "major_shareholders",
      "大股東資料",
      names.length
        ? `持股逾 10% 大股東：${names.join("、")}。`
        : `公開資料列示持股逾 10% 股東 ${formatNumber(ownership.major_shareholder_count, 0)} 名。`,
      ownership.source_ids?.filter((id) => id.includes("major_shareholders"))
    ));
  }

  if (risk?.status === "ok" && Number(risk.disclosure_violation_count) > 0) {
    facts.push(fact(
      "disclosure_violations",
      "申報違規",
      `公開資料列示申報違規 ${formatNumber(risk.disclosure_violation_count, 0)} 筆。`,
      risk.source_ids
    ));
  }

  return facts.filter(Boolean);
}

export async function generatePublicFacts({ generatedAt = new Date().toISOString() } = {}) {
  const [companiesJson, templates, market, revenue, financial, catalyst, ownership, risk] = await Promise.all([
    readJson(path.join(dataDir, "companies.json")),
    readJson(path.join(dataDir, "industry_templates.json")),
    readData("market_data.json"),
    readData("revenue_data.json"),
    readData("financial_data.json"),
    readData("catalyst_data.json"),
    readData("ownership_data.json"),
    readData("risk_data.json")
  ]);

  const datasets = { templates, market, revenue, financial, catalyst, ownership, risk };
  const companies = Object.fromEntries((companiesJson.companies || []).map((company) => [company.id, {
    ticker: company.ticker,
    market: company.market,
    generated_at: generatedAt,
    facts: buildFacts(company, datasets)
  }]));

  const sourceIds = unique(Object.values(companies).flatMap((company) => company.facts.flatMap((item) => item.source_ids)));
  const sourceIndex = new Map([...SOURCE_CATALOG, ...(companiesJson.reference_sources || [])].map((source) => [source.id, source]));

  await writeJson(path.join(dataDir, "public_facts.json"), {
    version: DATA_VERSION,
    generated_at: generatedAt,
    note: "Display-only public facts generated from structured public datasets. Items without available source-backed data are omitted.",
    sources: sourceIds.map((id) => sourceIndex.get(id)).filter(Boolean),
    companies
  });

  return companies;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const companies = await generatePublicFacts();
  console.log(`Generated public facts for ${Object.keys(companies).length} companies.`);
}
