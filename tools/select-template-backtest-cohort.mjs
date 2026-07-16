import path from "node:path";
import { readJson, writeJson } from "./data-sources.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function templateOrder(templatesJson) {
  return Object.keys(templatesJson.industries || {});
}

function sortCompanies(companies) {
  return [...companies].sort((a, b) => {
    const marketRank = (a.market === "TWSE" ? 0 : 1) - (b.market === "TWSE" ? 0 : 1);
    if (marketRank) return marketRank;
    const dateRank = String(a.listing_date || "9999").localeCompare(String(b.listing_date || "9999"));
    if (dateRank) return dateRank;
    return a.ticker.localeCompare(b.ticker, "zh-Hant-TW");
  });
}

function pickDiverse(candidates, count) {
  const groups = new Map();
  for (const company of sortCompanies(candidates)) {
    const key = company.official_industry_code || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(company);
  }

  const orderedGroups = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh-Hant-TW"));
  const picked = [];
  const used = new Set();

  while (picked.length < count && orderedGroups.some(([, rows]) => rows.length)) {
    for (const [, rows] of orderedGroups) {
      const company = rows.shift();
      if (!company || used.has(company.ticker)) continue;
      picked.push(company);
      used.add(company.ticker);
      if (picked.length >= count) break;
    }
  }

  return picked;
}

async function main() {
  const count = Number(argValue("count", "5"));
  const backtestId = argValue("backtest-id", "template_backtest_cohort");
  const outFile = argValue("out", path.join("backtests", backtestId, "cohort.json"));

  const [universeJson, templatesJson] = await Promise.all([
    readJson(path.join(dataDir, "listed_companies_universe.json")),
    readJson(path.join(dataDir, "industry_templates.json"))
  ]);

  const companies = (universeJson.companies || [])
    .filter((company) => /^\d{4}$/.test(company.ticker || ""))
    .filter((company) => company.market === "TWSE" || company.market === "TPEx");

  const cohort = [];
  const byTemplate = {};

  for (const templateId of templateOrder(templatesJson)) {
    const candidates = companies.filter((company) => company.industry_template === templateId);
    const selected = pickDiverse(candidates, count).map((company) => ({
      ticker: company.ticker,
      name: company.abbreviation || company.name,
      legal_name: company.name,
      market: company.market,
      market_label: company.market_label,
      official_industry_code: company.official_industry_code,
      official_industry_label: company.official_industry_label,
      listing_date: company.listing_date,
      website: company.website,
      industry_template: company.industry_template,
      template_label: company.template_label,
      match_reason: company.match_reason
    }));
    byTemplate[templateId] = {
      template_id: templateId,
      template_label: templatesJson.industries?.[templateId]?.label || templateId,
      available_count: candidates.length,
      selected
    };
    cohort.push(...selected);
  }

  const result = {
    version: "0.1.0",
    generated_at: new Date().toISOString(),
    method: "每個正式產業模板挑 5 家；優先分散官方產業代碼，並以上市公司、上市日期較早、股票代號排序作為穩定抽樣規則。",
    requested_per_template: count,
    template_count: templateOrder(templatesJson).length,
    company_count: cohort.length,
    by_template: byTemplate,
    companies: cohort
  };

  await writeJson(path.resolve(root, outFile), result);
  console.log(JSON.stringify({
    out: outFile,
    template_count: result.template_count,
    company_count: result.company_count
  }, null, 2));
}

await main();
