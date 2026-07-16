import path from "node:path";
import { readJson, writeJson } from "./data-sources.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");
const today = new Date().toISOString().slice(0, 10);

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseTickers() {
  const fromFlag = argValue("tickers");
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  return unique([...fromFlag.split(/[\s,，、;；]+/), ...positional].map((ticker) => ticker.trim()))
    .filter((ticker) => /^\d{4}$/.test(ticker))
    .sort((a, b) => a.localeCompare(b, "zh-Hant-TW"));
}

function normalizeUrl(url) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
}

function idFor(company) {
  const market = company.market === "TPEx" ? "tpex" : "twse";
  return `${market}-${company.ticker}`;
}

function fact(value, sourceIds, note = "") {
  return {
    value,
    source_ids: sourceIds,
    ...(note ? { note } : {})
  };
}

function selectTemplate(templateId, templates) {
  if (templates[templateId]) return templateId;
  if (templateId === "manufacturing" && templates.industrial_manufacturing) return "industrial_manufacturing";
  return templates.other ? "other" : Object.keys(templates)[0];
}

function templateFieldIds(template) {
  return unique((template.modules || []).flatMap((module) => module.fields || []));
}

function fieldLabel(fieldId, fields) {
  return fields[fieldId]?.label || fieldId;
}

function fieldValue(fieldId, company, selectedTemplateId, templates, fields) {
  const shortName = company.abbreviation || company.name;
  const market = company.market_label || company.market;
  const officialIndustry = company.official_industry_label || company.template_label || "待分類";
  const universeTemplate = company.template_label || company.industry_template;
  const selectedLabel = templates[selectedTemplateId]?.label || selectedTemplateId;
  const label = fieldLabel(fieldId, fields);

  const common = {
    business_model: `${shortName} 為${market}${officialIndustry}公司；此研究檔由選股宇宙自動建立，後續以公開財務、月營收、股價、重大訊息與產業證據補強。`,
    industry_focus: `${officialIndustry}；正式研究模板為 ${selectedLabel}${selectedTemplateId !== company.industry_template ? `，原始選股分類為 ${universeTemplate}` : ""}。`,
    revenue_driver: "待由月營收、財報、重大訊息與產業資料辨識主要成長驅動。",
    key_catalyst: "待由公開重大訊息、營收動能、財務變化、股價趨勢與產業專屬訊號自動整理。",
    key_risk: "待由公開重大訊息、資訊揭露違規、財務壓力、產業循環與法規事件自動整理。",
    industry_quality: `初步依官方產業 ${officialIndustry} 與 ${selectedLabel} 模板建立；產業證據分數會由可追蹤欄位與公開資料更新。`
  };

  if (common[fieldId]) return common[fieldId];

  const templatesByField = {
    regulatory_status: "待由主管機關許可、重大訊息、年報與公開資料補強法規或認證狀態。",
    evidence_level: "待由產品、臨床、文獻、技術或商業證據判斷證據強度。",
    quality_system: "待由年報、公司公開資料與主管機關資料補強品質系統與認證。",
    channel_quality: "待由營收來源、通路揭露、客戶結構與回購訊號判斷通路品質。",
    technology_position: "待由產品規格、技術節點、專利、研發與客戶導入資料判斷技術位置。",
    customer_structure: "待由年報、重大訊息與營收資料判斷客戶結構與集中風險。",
    inventory_cycle: "待由財報存貨、月營收與產業循環資料判斷庫存位置。",
    capex_intensity: "待由財報、資本支出、擴產與折舊資料判斷投資強度。",
    product_cycle: "待由新品、規格升級、替換週期與需求變化判斷產品週期。",
    supply_chain_role: "待由客戶、供應商、產品環節與重大訊息判斷供應鏈角色。",
    margin_resilience: "待由毛利率、營益率、價格與成本波動判斷獲利韌性。",
    recurring_revenue: "待由訂閱、維護、長約或雲端服務收入辨識經常性收入。",
    retention_signal: "待由續約、客戶擴張、會員或服務黏著度判斷留存訊號。",
    gross_margin_profile: "待由財報與產品組合判斷毛利結構。",
    implementation_depth: "待由客戶導入深度、系統整合與替換成本判斷導入深度。",
    data_advantage: "待由資料來源、資料權利、更新頻率與獨特性判斷資料優勢。",
    model_or_compute_edge: "待由模型能力、算力、部署成本與技術整合判斷 AI 優勢。",
    deployment_maturity: "待由正式上線、SLA、客戶案例與營收轉換判斷部署成熟度。",
    monetization_path: "待由收費模式、合約、授權、訂閱或效率收益判斷變現路徑。",
    pipeline_stage: "待由研發管線、臨床階段、產品進度或下一里程碑判斷成熟度。",
    clinical_evidence: "待由臨床數據、人體試驗、醫療採用或安全性資料判斷證據強度。",
    partnering_strength: "待由授權合作、策略聯盟、共同開發或客戶導入判斷合作品質。",
    clinical_adoption: "待由醫療院所、專科、通路或臨床場域採用資料判斷採用程度。",
    reimbursement_status: "待由健保、商保、醫療通路與海外市場資料判斷給付或保險狀態。",
    asset_quality: "待由逾放、備抵、投資部位與信用風險資料判斷資產品質。",
    capital_adequacy: "待由資本適足率、淨值比、槓桿與監理資料判斷資本強度。",
    interest_rate_sensitivity: "待由利差、投資評價、保險負債或融資成本判斷利率敏感度。",
    fee_income_mix: "待由財報與業務結構判斷手續費與非利息收入品質。",
    capacity_utilization: "待由產能、稼動率、擴產與營收資料判斷產能利用率。",
    raw_material_exposure: "待由原料、能源、匯率、運費與成本轉嫁資料判斷曝險。",
    order_visibility: "待由在手訂單、長約、交期、forecast 與重大訊息判斷訂單能見度。",
    automation_level: "待由製程、良率、自動化投資與單位成本資料判斷自動化程度。",
    commodity_cycle: "待由報價、供需、庫存、月營收與產業資料判斷商品循環位置。",
    spread_margin: "待由原料與成品價差、加工利差與毛利資料判斷利差品質。",
    capacity_discipline: "待由擴產、停產、產業供給與資本支出判斷產能紀律。",
    auto_customer_qualification: "待由車廠、Tier 1、車用平台與量產紀錄判斷導入品質。",
    ev_content_growth: "待由電動化、ADAS、車用電子與單車價值資料判斷含量提升。",
    safety_certification: "待由車規、安全、功能安全或品質認證判斷可靠度。",
    platform_lifecycle: "待由車型平台、專案量產與改款週期判斷平台生命週期。",
    order_backlog: "待由在手案量、工程、建案、標案或長約資料判斷能見度。",
    asset_utilization: "待由船舶、車隊、倉儲、土地、設備或營運資產資料判斷利用率。",
    freight_rate_exposure: "待由運價、租金、房價、工程價格或資產價格資料判斷曝險。",
    interest_rate_exposure: "待由負債、融資、利率與現金流資料判斷利率曝險。",
    brand_strength: "待由品牌、會員、定價力、通路與消費者信任資料判斷品牌力。",
    same_store_sales: "待由同店銷售、展店、加盟、電商與月營收資料判斷通路成長。",
    channel_mix: "待由直營、加盟、量販、電商、海外與 B2B 結構判斷通路組合。",
    input_cost_sensitivity: "待由原料、租金、人力、匯率與價格轉嫁資料判斷成本敏感度。",
    contracted_revenue: "待由售電、處理、維護、公用費率或長約資料判斷收入穩定度。",
    energy_price_exposure: "待由燃料、電價、碳權、原油或天然氣資料判斷能源曝險。",
    project_pipeline: "待由案場、工程進度、容量、環評、併網或投產資料判斷專案管線。",
    regulatory_tariff: "待由費率、補助、主管機關政策與法規資料判斷制度風險。",
    business_clarity: "待由公開說明、年報、產品、客戶與營收資料判斷商業模式清楚度。",
    revenue_visibility: "待由月營收、訂單、合約、需求或專案資料判斷營收能見度。",
    balance_sheet_resilience: "待由現金、負債、流動性與財務成本判斷資產負債韌性。",
    governance_signal: "待由重大訊息、內部人、資訊揭露與治理事件判斷治理訊號。"
  };

  return templatesByField[fieldId] || `待由公開資料補強「${label}」。`;
}

function buildCompany(universeCompany, templates, fields) {
  const selectedTemplateId = selectTemplate(universeCompany.industry_template, templates);
  const sourceIds = unique([
    universeCompany.source_id,
    universeCompany.market === "TPEx" ? "tpex_company_basic" : "twse_company_basic",
    "mops",
    universeCompany.market === "TPEx" ? "tpex" : "twse"
  ]);
  return {
    id: idFor(universeCompany),
    ticker: universeCompany.ticker,
    market: universeCompany.market,
    market_label: universeCompany.market_label,
    name: universeCompany.abbreviation || universeCompany.name,
    legal_name: universeCompany.name,
    category: universeCompany.template_label || universeCompany.official_industry_label || selectedTemplateId,
    industry_template: selectedTemplateId,
    original_industry_template: universeCompany.industry_template,
    official_industry_code: universeCompany.official_industry_code,
    official_industry_label: universeCompany.official_industry_label,
    listing_date: universeCompany.listing_date,
    website: normalizeUrl(universeCompany.website),
    data_quality: "Public structured datasets are refreshed by the research update workflow.",
    last_reviewed: today,
    tags: unique([
      universeCompany.market_label,
      universeCompany.template_label,
      universeCompany.official_industry_label
    ]),
    primary_source_ids: sourceIds,
    sources: universeCompany.website ? [
      {
        id: `${idFor(universeCompany)}_official`,
        title: `${universeCompany.abbreviation || universeCompany.name} 官方網站`,
        short_title: "官方網站",
        url: normalizeUrl(universeCompany.website),
        note: "由選股宇宙公司基本資料帶入；後續可作為人工查核來源。"
      }
    ] : [],
    facts: {},
    risks: [],
    events: []
  };
}

async function main() {
  const tickers = parseTickers();
  if (!tickers.length) {
    throw new Error("請提供四碼股票代號，例如 --tickers=1595,2301,3044");
  }

  const [universe, companiesJson, templatesJson, fieldsJson] = await Promise.all([
    readJson(path.join(dataDir, "listed_companies_universe.json")),
    readJson(path.join(dataDir, "companies.json")),
    readJson(path.join(dataDir, "industry_templates.json")),
    readJson(path.join(dataDir, "field_definitions.json"))
  ]);

  const templates = templatesJson.industries || {};
  const fields = fieldsJson.fields || {};
  const universeByTicker = new Map((universe.companies || []).map((company) => [company.ticker, company]));
  const existingByTicker = new Map((companiesJson.companies || []).map((company) => [company.ticker, company]));
  const promoted = [];
  const missing = [];

  for (const ticker of tickers) {
    const universeCompany = universeByTicker.get(ticker);
    if (!universeCompany) {
      missing.push(ticker);
      continue;
    }

    const nextCompany = buildCompany(universeCompany, templates, fields);
    if (existingByTicker.has(ticker)) {
      const existing = existingByTicker.get(ticker);
      const mergedFacts = { ...nextCompany.facts, ...(existing.facts || {}) };
      existingByTicker.set(ticker, {
        ...existing,
        industry_template: nextCompany.industry_template,
        original_industry_template: existing.original_industry_template || universeCompany.industry_template,
        official_industry_code: existing.official_industry_code || universeCompany.official_industry_code,
        official_industry_label: existing.official_industry_label || universeCompany.official_industry_label,
        category: existing.category || nextCompany.category,
        website: existing.website || nextCompany.website,
        data_quality: existing.data_quality || nextCompany.data_quality,
        last_reviewed: today,
        primary_source_ids: unique([...(existing.primary_source_ids || []), ...nextCompany.primary_source_ids]),
        tags: unique([...(existing.tags || []), ...nextCompany.tags]),
        facts: mergedFacts
      });
      promoted.push({ ticker, action: "updated", id: existing.id, industry_template: nextCompany.industry_template });
    } else {
      existingByTicker.set(ticker, nextCompany);
      promoted.push({ ticker, action: "added", id: nextCompany.id, industry_template: nextCompany.industry_template });
    }
  }

  companiesJson.version = "0.9.0";
  companiesJson.note = "v0.9 起，選股宇宙的 15 類產業分類會直接升級為對應正式研究模板。";
  companiesJson.companies = [...existingByTicker.values()]
    .sort((a, b) => a.ticker.localeCompare(b.ticker, "zh-Hant-TW"));

  await writeJson(path.join(dataDir, "companies.json"), companiesJson);

  console.log(JSON.stringify({
    promoted,
    missing,
    total_companies: companiesJson.companies.length
  }, null, 2));
}

await main();
