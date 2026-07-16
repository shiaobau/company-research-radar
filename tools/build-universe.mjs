import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fetchJson, readJson, writeJson } from "./data-sources.mjs";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const dataDir = path.join(root, "data");
const mapPath = path.join(dataDir, "industry_template_map.json");
const universePath = path.join(dataDir, "listed_companies_universe.json");
const reportPath = path.join(dataDir, "universe_coverage_report.json");
const companiesPath = path.join(dataDir, "companies.json");

const TWSE_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L";
const TPEX_URL = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O";
const VERSION = "0.1.0";

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeIndustryCode(value) {
  const code = clean(value).replace(/\D/g, "");
  if (!code) return "";
  return code.padStart(2, "0");
}

function parseListingDate(value) {
  const text = clean(value);
  if (!text) return null;
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(text)) return text.replace(/\//g, "-");
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{7}$/.test(text)) {
    const year = Number(text.slice(0, 3)) + 1911;
    return `${year}-${text.slice(3, 5)}-${text.slice(5, 7)}`;
  }
  if (/^\d{3}\/\d{2}\/\d{2}$/.test(text)) {
    const [year, month, day] = text.split("/");
    return `${Number(year) + 1911}-${month}-${day}`;
  }
  return text;
}

async function fetchJsonWithPowerShellFallback(url) {
  try {
    return await fetchJson(url, 4, 30000);
  } catch (error) {
    const script = [
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
      `$r=Invoke-WebRequest -Uri '${url}' -UseBasicParsing -TimeoutSec 60`,
      "$ms=New-Object System.IO.MemoryStream",
      "$r.RawContentStream.CopyTo($ms)",
      "[System.Text.Encoding]::UTF8.GetString($ms.ToArray())"
    ].join("; ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      maxBuffer: 32 * 1024 * 1024
    });
    try {
      return JSON.parse(stdout);
    } catch (parseError) {
      parseError.message = `${parseError.message}; original fetch error: ${error.message}`;
      throw parseError;
    }
  }
}

function normalizeTwseRow(row, mapConfig) {
  const code = clean(row["公司代號"]);
  const industryCode = normalizeIndustryCode(row["產業別"]);
  return {
    ticker: code,
    name: clean(row["公司名稱"]),
    abbreviation: clean(row["公司簡稱"]),
    market: "TWSE",
    market_label: "上市",
    official_industry_code: industryCode,
    official_industry_label: mapConfig.official_industry_labels[industryCode] || "未提供",
    listing_date: parseListingDate(row["上市日期"]),
    website: clean(row["網址"]),
    source_id: "twse_company_basic"
  };
}

function normalizeTpexRow(row, mapConfig) {
  const code = clean(row.SecuritiesCompanyCode);
  const industryCode = normalizeIndustryCode(row.SecuritiesIndustryCode);
  return {
    ticker: code,
    name: clean(row.CompanyName),
    abbreviation: clean(row.CompanyAbbreviation),
    market: "TPEx",
    market_label: "上櫃",
    official_industry_code: industryCode,
    official_industry_label: mapConfig.official_industry_labels[industryCode] || "未提供",
    listing_date: parseListingDate(row.DateOfListing || row.ListingDate || row.Date),
    website: clean(row.WebAddress || row.Website || row.URL),
    source_id: "tpex_company_basic"
  };
}

function keywordMatches(company, override) {
  if (
    override.applies_to_industry_codes?.length &&
    !override.applies_to_industry_codes.includes(company.official_industry_code)
  ) {
    return null;
  }
  const haystack = `${company.name} ${company.abbreviation} ${company.website}`.toLowerCase();
  const keyword = override.keywords.find((item) => haystack.includes(String(item).toLowerCase()));
  return keyword || null;
}

async function readSeedTemplateMap() {
  try {
    const payload = await readJson(companiesPath);
    return Object.fromEntries(
      (payload.companies || [])
        .filter((company) => company.ticker && company.industry_template)
        .map((company) => [company.ticker, company.industry_template])
    );
  } catch {
    return {};
  }
}

function classifyCompany(company, mapConfig, templateLabels, seedTemplates) {
  const seedTemplate = seedTemplates[company.ticker];
  if (seedTemplate && templateLabels[seedTemplate]) {
    return {
      industry_template: seedTemplate,
      template_label: templateLabels[seedTemplate],
      match_reason: "沿用既有研究檔人工確認的產業模板"
    };
  }

  for (const override of mapConfig.keyword_overrides || []) {
    const keyword = keywordMatches(company, override);
    if (keyword) {
      return {
        industry_template: override.template_id,
        template_label: templateLabels[override.template_id] || override.template_id,
        match_reason: `關鍵字「${keyword}」覆寫官方產業 ${company.official_industry_label}`
      };
    }
  }

  const templateId = mapConfig.official_industry_code_map[company.official_industry_code] || "other";
  return {
    industry_template: templateId,
    template_label: templateLabels[templateId] || templateId,
    match_reason: `依官方產業代碼 ${company.official_industry_code || "NA"} ${company.official_industry_label}`
  };
}

function countBy(rows, key) {
  return rows.reduce((counts, row) => {
    const value = row[key] || "unknown";
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function countIndustryCodes(rows) {
  return rows.reduce((counts, row) => {
    const code = row.official_industry_code || "unknown";
    const label = row.official_industry_label || "未提供";
    if (!counts[code]) counts[code] = { code, label, count: 0 };
    counts[code].count += 1;
    return counts;
  }, {});
}

async function buildUniverse() {
  const generatedAt = new Date().toISOString();
  const mapConfig = await readJson(mapPath);
  const seedTemplates = await readSeedTemplateMap();
  const templateLabels = Object.fromEntries((mapConfig.templates || []).map((template) => [template.id, template.label]));

  const [twseRows, tpexRows] = await Promise.all([
    fetchJsonWithPowerShellFallback(TWSE_URL),
    fetchJsonWithPowerShellFallback(TPEX_URL)
  ]);

  const companies = [
    ...twseRows.map((row) => normalizeTwseRow(row, mapConfig)),
    ...tpexRows.map((row) => normalizeTpexRow(row, mapConfig))
  ]
    .filter((company) => /^\d{4}$/.test(company.ticker) && company.name)
    .map((company) => ({ ...company, ...classifyCompany(company, mapConfig, templateLabels, seedTemplates) }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker, "zh-Hant-TW"));

  const universe = {
    version: VERSION,
    generated_at: generatedAt,
    total_count: companies.length,
    note: "這是上市/上櫃全市場前置篩選清單。分類來自官方產業代碼與少量關鍵字覆寫，尚未代表已完成個股研究或投資評分。",
    sources: mapConfig.sources,
    templates: mapConfig.templates,
    companies
  };

  const byTemplate = countBy(companies, "industry_template");
  const templateCoverage = (mapConfig.templates || []).map((template) => ({
    id: template.id,
    label: template.label,
    count: byTemplate[template.id] || 0
  }));

  const report = {
    version: VERSION,
    generated_at: generatedAt,
    total_count: companies.length,
    market_counts: countBy(companies, "market"),
    template_counts: Object.fromEntries(templateCoverage.map((item) => [item.id, item.count])),
    template_coverage: templateCoverage,
    official_industry_counts: Object.values(countIndustryCodes(companies)).sort((a, b) => a.code.localeCompare(b.code)),
    unmatched_count: byTemplate.other || 0,
    source_counts: countBy(companies, "source_id"),
    caveats: [
      "官方產業代碼是穩定的第一層分類，但不足以分辨所有商業模式。",
      "AI、保健食品、醫療器材、車用與能源環境使用公司名稱/網站關鍵字覆寫，仍需要人工抽查。",
      "已存在於 data/companies.json 的公司會沿用既有研究檔的人工確認模板。",
      "此清單只建立研究宇宙，不會自動把 1980 檔都加入原評分儀表板。"
    ]
  };

  await writeJson(universePath, universe);
  await writeJson(reportPath, report);

  console.log(`Generated ${companies.length} listed/TPEx companies.`);
  console.log(templateCoverage.map((item) => `${item.id}:${item.count}`).join(" "));
}

await buildUniverse();
