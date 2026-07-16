import path from "node:path";
import { unlink } from "node:fs/promises";
import { readJson, writeJson } from "./data-sources.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");

function parseTickers() {
  const flag = process.argv.find((arg) => arg.startsWith("--tickers="))?.slice("--tickers=".length) || "";
  return [...new Set(flag.split(/[\s,，、;；]+/).map((ticker) => ticker.trim()).filter(Boolean))];
}

async function removeFromGenerated(fileName, ids) {
  const filePath = path.join(dataDir, fileName);
  try {
    const payload = await readJson(filePath);
    if (payload.companies) {
      for (const id of ids) delete payload.companies[id];
      await writeJson(filePath, payload);
    }
  } catch {
    // Optional generated file.
  }
}

async function removeTickerCache(directory, ticker) {
  await unlink(path.join(dataDir, directory, `${ticker}.json`)).catch(() => {});
}

async function main() {
  const tickers = parseTickers();
  if (!tickers.length) throw new Error("請提供股票代號，例如 --tickers=2301");

  const companiesPath = path.join(dataDir, "companies.json");
  const companiesJson = await readJson(companiesPath);
  const removed = [];
  const remaining = [];

  for (const company of companiesJson.companies || []) {
    if (tickers.includes(company.ticker)) removed.push(company);
    else remaining.push(company);
  }

  companiesJson.companies = remaining;
  await writeJson(companiesPath, companiesJson);

  const removedIds = removed.map((company) => company.id);
  for (const fileName of [
    "market_data.json",
    "revenue_data.json",
    "financial_data.json",
    "catalyst_data.json",
    "ownership_data.json",
    "risk_data.json",
    "industry_evidence_data.json",
    "industry_data.json",
    "data_status.json",
    "public_facts.json"
  ]) {
    await removeFromGenerated(fileName, removedIds);
  }

  try {
    const signalsPath = path.join(dataDir, "signals.json");
    const signals = await readJson(signalsPath);
    signals.signals = (signals.signals || []).filter((signal) => !removedIds.includes(signal.company_id));
    await writeJson(signalsPath, signals);
  } catch {
    // Optional file.
  }

  try {
    const cacheIndexPath = path.join(dataDir, "research_cache", "index.json");
    const cacheIndex = await readJson(cacheIndexPath);
    cacheIndex.companies = (cacheIndex.companies || []).filter((company) => !tickers.includes(company.ticker));
    await writeJson(cacheIndexPath, cacheIndex);
  } catch {
    // Optional targeted-research cache index.
  }

  try {
    const researchStatusPath = path.join(dataDir, "research_status.json");
    const researchStatus = await readJson(researchStatusPath);
    for (const id of removedIds) delete researchStatus.companies?.[id];
    const records = Object.values(researchStatus.companies || {});
    researchStatus.summary = {
      total: records.length,
      complete_count: records.filter((record) => record.status === "complete").length,
      incomplete_count: records.filter((record) => record.status === "incomplete").length
    };
    await writeJson(researchStatusPath, researchStatus);
  } catch {
    // Optional research completeness status.
  }

  await Promise.all(tickers.flatMap((ticker) => [
    removeTickerCache("research_cache", ticker),
    removeTickerCache("mops_history_cache", ticker)
  ]));

  console.log(JSON.stringify({
    removed: removed.map((company) => ({ ticker: company.ticker, id: company.id, name: company.name })),
    total_companies: remaining.length
  }, null, 2));
}

await main();
