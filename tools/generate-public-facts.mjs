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
  const marketFactors = datasets.marketFactors.companies?.[`${company.market}:${company.ticker}`];
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
    const metrics = company.industry_template === "financial"
      ? [
          isFiniteNumber(financial.annualized_roe_pct) ? `年化 ROE ${formatPercent(financial.annualized_roe_pct)}` : "",
          isFiniteNumber(financial.annualized_roa_pct) ? `年化 ROA ${formatPercent(financial.annualized_roa_pct)}` : "",
          isFiniteNumber(financial.equity_ratio_pct) ? `權益比率 ${formatPercent(financial.equity_ratio_pct)}` : "",
          isFiniteNumber(financial.eps) ? `EPS ${formatNumber(financial.eps)}` : ""
        ].filter(Boolean)
      : [
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
    const volume = isFiniteNumber(market.volume_ratio_20d)
      ? `；當日量為 20 日均量 ${formatNumber(market.volume_ratio_20d)} 倍`
      : "";
    facts.push(fact(
      "market_snapshot",
      "股價資料",
      `${market.latest_trade_date} 收盤 ${formatNumber(market.latest_close)}${returns ? `；區間報酬：${returns}` : ""}${volume}。`,
      market.source_ids
    ));
  }

  if (marketFactors?.valuation) {
    const valuation = marketFactors.valuation;
    const peer = marketFactors.peer_group || {};
    const metrics = [
      isFiniteNumber(valuation.pe_ratio) ? `本益比 ${formatNumber(valuation.pe_ratio)}` : "",
      isFiniteNumber(valuation.pb_ratio) ? `股價淨值比 ${formatNumber(valuation.pb_ratio)}` : "",
      isFiniteNumber(valuation.dividend_yield_pct) ? `殖利率 ${formatPercent(valuation.dividend_yield_pct)}` : ""
    ].filter(Boolean);
    const percentiles = [
      isFiniteNumber(valuation.favorable_percentiles?.pe_ratio) ? `本益比相對有利 ${formatNumber(valuation.favorable_percentiles.pe_ratio, 0)} 百分位` : "",
      isFiniteNumber(valuation.favorable_percentiles?.pb_ratio) ? `股淨比相對有利 ${formatNumber(valuation.favorable_percentiles.pb_ratio, 0)} 百分位` : "",
      isFiniteNumber(valuation.favorable_percentiles?.dividend_yield_pct) ? `殖利率相對有利 ${formatNumber(valuation.favorable_percentiles.dividend_yield_pct, 0)} 百分位` : ""
    ].filter(Boolean);
    const peerDescription = peer.sample_count >= 10 && peer.label
      ? `比較母體：${peer.label} ${formatNumber(peer.sample_count, 0)} 家。`
      : "同業樣本不足，僅列示原始估值。";
    facts.push(fact(
      "valuation_peer_snapshot",
      "同業估值",
      metrics.length ? `${metrics.join("；")}。${percentiles.length ? `${percentiles.join("；")}。` : ""}${peerDescription}` : "",
      marketFactors.source_ids?.filter((id) => id.includes("valuation"))
    ));
  }

  if (marketFactors?.institutional || marketFactors?.margin) {
    const institutional = marketFactors.institutional || {};
    const margin = marketFactors.margin || {};
    const items = [
      isFiniteNumber(institutional.foreign_net_shares) ? `外資淨買賣 ${formatNumber(institutional.foreign_net_shares, 0)} 股` : "",
      isFiniteNumber(institutional.trust_net_shares) ? `投信淨買賣 ${formatNumber(institutional.trust_net_shares, 0)} 股` : "",
      isFiniteNumber(institutional.total_net_shares) ? `三大法人合計 ${formatNumber(institutional.total_net_shares, 0)} 股` : "",
      isFiniteNumber(margin.financing_balance_lots) ? `融資餘額 ${formatNumber(margin.financing_balance_lots, 0)} 張` : "",
      isFiniteNumber(margin.short_balance_lots) ? `融券餘額 ${formatNumber(margin.short_balance_lots, 0)} 張` : ""
    ].filter(Boolean);
    const asOf = institutional.as_of || margin.as_of || "最新交易日";
    facts.push(fact(
      "market_positioning_snapshot",
      "法人與融資券",
      items.length ? `${asOf}：${items.join("；")}。` : "",
      marketFactors.source_ids?.filter((id) => id.includes("margin") || id.includes("institutional"))
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

  if (ownership?.status === "ok") {
    const governanceItems = [
      Number.isFinite(Number(ownership.major_shareholder_count)) ? `主要股東揭露 ${formatNumber(ownership.major_shareholder_count, 0)} 位` : "",
      Number.isFinite(Number(ownership.insider_transfer_count)) ? `內部人轉讓 ${formatNumber(ownership.insider_transfer_count, 0)} 筆` : ""
    ].filter(Boolean);
    facts.push(fact(
      "governance_snapshot",
      "股權與治理",
      governanceItems.length ? `${governanceItems.join("；")}。` : "",
      ownership.source_ids
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

  if (risk?.status === "ok") {
    const riskItems = [
      Number.isFinite(Number(risk.event_count)) ? `官方事件 ${formatNumber(risk.event_count, 0)} 則` : "",
      Number.isFinite(Number(risk.review_event_count)) && Number(risk.review_event_count) > 0 ? `待閱讀 ${formatNumber(risk.review_event_count, 0)} 則` : "",
      Number.isFinite(Number(risk.negative_event_count)) && Number(risk.negative_event_count) > 0 ? `重大負向 ${formatNumber(risk.negative_event_count, 0)} 則` : "",
      Number.isFinite(Number(risk.disclosure_violation_count)) ? `申報違規 ${formatNumber(risk.disclosure_violation_count, 0)} 筆` : ""
    ].filter(Boolean);
    facts.push(fact(
      "event_risk_snapshot",
      "事件與合規",
      riskItems.length ? `${riskItems.join("；")}。` : "",
      risk.source_ids
    ));
  }

  return facts.filter(Boolean);
}

export async function generatePublicFacts({ generatedAt = new Date().toISOString() } = {}) {
  const [companiesJson, templates, market, marketFactors, revenue, financial, catalyst, ownership, risk] = await Promise.all([
    readJson(path.join(dataDir, "companies.json")),
    readJson(path.join(dataDir, "industry_templates.json")),
    readData("market_data.json"),
    readData("market_factors.json"),
    readData("revenue_data.json"),
    readData("financial_data.json"),
    readData("catalyst_data.json"),
    readData("ownership_data.json"),
    readData("risk_data.json")
  ]);

  const datasets = { templates, market, marketFactors, revenue, financial, catalyst, ownership, risk };
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
