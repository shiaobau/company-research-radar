import { spawn } from "node:child_process";
import path from "node:path";
import { readJson, writeJson } from "./data-sources.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");
const requestedTickers = new Set(
  (process.argv.find((arg) => arg.startsWith("--tickers=")) || "")
    .slice("--tickers=".length)
    .split(",")
    .map((ticker) => ticker.trim())
    .filter((ticker) => /^\d{4}$/.test(ticker))
);
const retryMissing = process.argv.includes("--retry");

const DIMENSIONS = [
  ["catalyst", "催化事件"],
  ["market", "股價位置/趨勢"],
  ["revenue", "營收動能"],
  ["financial", "現金/獲利品質"],
  ["ownership", "籌碼/股權結構"],
  ["risk", "新聞/重大訊息風險"],
  ["industry", "產業基本面"]
];

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(output || `${script} exited with ${code}`)));
  });
}

function recordsFrom(statusData, industryEvidenceData, companies) {
  const selected = requestedTickers.size
    ? companies.filter((company) => requestedTickers.has(company.ticker))
    : companies;
  return selected.map((company) => {
    const source = statusData.companies?.[company.id] || {};
    const industryEvidence = industryEvidenceData.companies?.[company.id];
    const missingDimensions = DIMENSIONS
      .filter(([id]) => source[id] !== "ok" || (id === "industry" && industryEvidence?.status !== "ok"))
      .map(([id, label]) => ({ id, label }));
    return {
      id: company.id,
      ticker: company.ticker,
      name: company.name,
      status: missingDimensions.length ? "incomplete" : "complete",
      missing_dimensions: missingDimensions,
      completed_count: DIMENSIONS.length - missingDimensions.length,
      total_count: DIMENSIONS.length
    };
  });
}

async function loadInputs() {
  const [companiesData, dataStatus, industryEvidenceData] = await Promise.all([
    readJson(path.join(dataDir, "companies.json")),
    readJson(path.join(dataDir, "data_status.json")),
    readJson(path.join(dataDir, "industry_evidence_data.json"))
  ]);
  return { companies: companiesData.companies || [], dataStatus, industryEvidenceData };
}

async function main() {
  let { companies, dataStatus, industryEvidenceData } = await loadInputs();
  let records = recordsFrom(dataStatus, industryEvidenceData, companies);
  const missingTickers = records.filter((record) => record.status === "incomplete").map((record) => record.ticker);
  let retried = false;

  if (retryMissing && missingTickers.length) {
    await runNode("tools/source-cache.mjs", ["--refresh"]);
    await runNode("tools/update-data.mjs", [`--tickers=${missingTickers.join(",")}`]);
    ({ companies, dataStatus, industryEvidenceData } = await loadInputs());
    records = recordsFrom(dataStatus, industryEvidenceData, companies);
    retried = true;
  }

  let prior = { companies: {} };
  try { prior = await readJson(path.join(dataDir, "research_status.json")); } catch { /* First run. */ }
  const currentIds = new Set(companies.map((company) => company.id));
  const merged = Object.fromEntries(Object.entries(prior.companies || {}).filter(([id]) => currentIds.has(id)));
  const checkedAt = new Date().toISOString();
  for (const record of records) {
    merged[record.id] = { ...record, checked_at: checkedAt, retried };
  }

  const allRecords = Object.values(merged);
  const completeCount = allRecords.filter((record) => record.status === "complete").length;
  const incompleteCount = allRecords.length - completeCount;
  await writeJson(path.join(dataDir, "research_status.json"), {
    version: "1.0.0",
    generated_at: checkedAt,
    note: "七個必要評分維度皆須具備公開資料；產業基本面還必須通過來源支持的產業子檢核，否則不產生總分。",
    summary: { total: allRecords.length, complete_count: completeCount, incomplete_count: incompleteCount },
    companies: merged
  });
  console.log(JSON.stringify({ status: incompleteCount ? "incomplete" : "complete", retried, complete_count: completeCount, incomplete_count: incompleteCount, companies: records }, null, 2));
}

await main();
