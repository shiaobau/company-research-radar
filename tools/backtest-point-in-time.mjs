import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyMaterialEvents, loadEventTaxonomy, thresholdScore } from "./event-risk.mjs";
import { average, clamp, readJson, round, toNumber, writeJson } from "./data-sources.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function dayDiff(later, earlier) {
  return Math.floor((new Date(`${later}T00:00:00Z`) - new Date(`${earlier}T00:00:00Z`)) / 86400000);
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function quarterEnd(year, quarter) {
  const month = quarter * 3;
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function normalizeKey(value) {
  return String(value || "").replace(/\s+/g, "").replace(/[（()）]/g, "").trim();
}

function valueByTerms(record, terms, excludes = []) {
  const key = Object.keys(record || {}).find((candidate) => {
    const normalized = normalizeKey(candidate);
    return terms.every((term) => normalized.includes(term)) && excludes.every((term) => !normalized.includes(term));
  });
  return key ? toNumber(record[key]) : null;
}

function recordFromTables(tables, ticker) {
  for (const table of tables || []) {
    const headerIndex = table.findIndex((row) => row.some((cell) => String(cell).includes("公司代號")));
    if (headerIndex < 0) continue;
    const header = table[headerIndex].map((cell) => normalizeKey(cell));
    for (const row of table.slice(headerIndex + 1)) {
      const codeIndex = header.findIndex((cell) => cell.includes("公司代號"));
      if (codeIndex < 0 || String(row[codeIndex] || "").trim() !== ticker) continue;
      return Object.fromEntries(header.map((cell, index) => [cell || `column_${index}`, row[index] || ""]));
    }
  }
  return null;
}

async function optionalJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function monthPeriods(observationDate) {
  const cutoff = new Date(`${observationDate}T00:00:00Z`);
  const result = [];
  for (let offset = 0; offset < 24; offset += 1) {
    const end = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() - offset + 1, 0));
    result.push({
      year: end.getUTCFullYear(),
      month: end.getUTCMonth() + 1,
      end_date: end.toISOString().slice(0, 10)
    });
  }
  return result;
}

function quarterPeriods(observationDate) {
  const cutoff = new Date(`${observationDate}T00:00:00Z`);
  const result = [];
  for (let offset = 0; offset < 10; offset += 1) {
    const date = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() - offset * 3, 1));
    const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
    result.push({ year: date.getUTCFullYear(), quarter, end_date: quarterEnd(date.getUTCFullYear(), quarter) });
  }
  return result;
}

async function selectRevenue(rawDir, company, observationDate, publicationLag) {
  for (const period of monthPeriods(observationDate)) {
    if (addDays(period.end_date, publicationLag) > observationDate) continue;
    const file = path.join(rawDir, "revenue", `${company.market}-${period.year}-${String(period.month).padStart(2, "0")}.json`);
    const report = await optionalJson(file);
    if (report?.status !== "ok") continue;
    const row = recordFromTables(report.tables, company.ticker);
    if (!row) continue;
    const current = valueByTerms(row, ["當月營收"]) ?? valueByTerms(row, ["當月", "營業收入"], ["去年", "累計"]);
    const previous = valueByTerms(row, ["上月營收"]) ?? valueByTerms(row, ["上月", "營業收入"]);
    const lastYear = valueByTerms(row, ["去年當月營收"]) ?? valueByTerms(row, ["去年", "當月", "營業收入"]);
    const cumulative = valueByTerms(row, ["當月累計營收"]) ?? valueByTerms(row, ["累計", "營業收入"], ["去年"]);
    const priorCumulative = valueByTerms(row, ["去年當月累計營收"]) ?? valueByTerms(row, ["去年", "累計", "營業收入"]);
    const yoy = valueByTerms(row, ["去年同月增減", "%"]) ?? (current && lastYear ? (current - lastYear) / Math.abs(lastYear) * 100 : null);
    const mom = valueByTerms(row, ["上月比較增減", "%"]) ?? (current && previous ? (current - previous) / Math.abs(previous) * 100 : null);
    const cumulativeYoy = valueByTerms(row, ["累計", "增減", "%"]) ?? (cumulative && priorCumulative ? (cumulative - priorCumulative) / Math.abs(priorCumulative) * 100 : null);
    if (![yoy, mom, cumulativeYoy].every(Number.isFinite)) continue;
    return {
      status: "ok",
      data_month: `${period.year}-${String(period.month).padStart(2, "0")}`,
      yoy_pct: round(yoy),
      mom_pct: round(mom),
      cumulative_yoy_pct: round(cumulativeYoy),
      source_id: report.source_id,
      source_url: report.source_url,
      source_file: path.relative(root, file)
    };
  }
  return { status: "missing", reason: "No dated MOPS monthly-revenue row was available before this observation date." };
}

async function selectFinancial(rawDir, company, observationDate, publicationLag) {
  for (const period of quarterPeriods(observationDate)) {
    if (addDays(period.end_date, publicationLag) > observationDate) continue;
    const incomeFile = path.join(rawDir, "financial", `income-${company.market}-${period.year}-Q${period.quarter}.json`);
    const balanceFile = path.join(rawDir, "financial", `balance-${company.market}-${period.year}-Q${period.quarter}.json`);
    const income = await optionalJson(incomeFile);
    const balance = await optionalJson(balanceFile);
    if (income?.status !== "ok" || balance?.status !== "ok") continue;
    const incomeRow = recordFromTables(income.tables, company.ticker);
    const balanceRow = recordFromTables(balance.tables, company.ticker);
    if (!incomeRow || !balanceRow) continue;
    const revenue = valueByTerms(incomeRow, ["營業收入"], ["累計"]);
    const grossProfit = valueByTerms(incomeRow, ["營業毛利"]) ?? valueByTerms(incomeRow, ["毛利"]);
    const operatingIncome = valueByTerms(incomeRow, ["營業利益"]);
    const currentAssets = valueByTerms(balanceRow, ["流動資產"]);
    const currentLiabilities = valueByTerms(balanceRow, ["流動負債"]);
    const totalAssets = valueByTerms(balanceRow, ["資產總額"]) ?? valueByTerms(balanceRow, ["資產總計"]);
    const totalLiabilities = valueByTerms(balanceRow, ["負債總額"]) ?? valueByTerms(balanceRow, ["負債總計"]);
    const grossMargin = revenue ? grossProfit / revenue * 100 : null;
    const operatingMargin = revenue ? operatingIncome / revenue * 100 : null;
    const currentRatio = currentLiabilities ? currentAssets / currentLiabilities : null;
    const debtRatio = totalAssets ? totalLiabilities / totalAssets * 100 : null;
    if (![grossMargin, operatingMargin, currentRatio, debtRatio].every(Number.isFinite)) continue;
    return {
      status: "ok",
      fiscal_period: `${period.year} Q${period.quarter}`,
      gross_margin_pct: round(grossMargin),
      operating_margin_pct: round(operatingMargin),
      current_ratio: round(currentRatio),
      debt_ratio_pct: round(debtRatio),
      source_id: income.source_id,
      source_url: income.source_url,
      source_files: [path.relative(root, incomeFile), path.relative(root, balanceFile)]
    };
  }
  return { status: "missing", reason: "No dated MOPS income-statement and balance-sheet rows were available before this observation date." };
}

function selectMarket(priceHistory, observationDate) {
  const prices = (priceHistory?.prices || []).filter((item) => item.date <= observationDate && Number.isFinite(item.close));
  if (prices.length < 61) return { status: "missing", reason: "Insufficient dated price observations." };
  const current = prices.at(-1);
  const close20 = prices.at(-21)?.close;
  const close60 = prices.at(-61)?.close;
  const year = prices.slice(-261);
  if (![current?.close, close20, close60].every(Number.isFinite) || year.length < 180) return { status: "missing", reason: "Insufficient 20/60/one-year price history." };
  const low = Math.min(...year.map((item) => item.close));
  const high = Math.max(...year.map((item) => item.close));
  return {
    status: "ok",
    as_of_close: current.close,
    as_of_date: current.date,
    position_pct: high > low ? round((current.close - low) / (high - low) * 100) : 50,
    return_20d_pct: round((current.close - close20) / close20 * 100),
    return_60d_pct: round((current.close - close60) / close60 * 100),
    source_id: priceHistory.source_id,
    source_url: priceHistory.source_url,
    source_file: priceHistory.source_file
  };
}

function forwardReturns(priceHistory, observationDate, horizons) {
  const prices = (priceHistory?.prices || []).filter((item) => item.date <= observationDate && Number.isFinite(item.close));
  const allPrices = (priceHistory?.prices || []).filter((item) => Number.isFinite(item.close));
  const current = prices.at(-1);
  if (!current) return {};
  const index = allPrices.findIndex((item) => item.date === current.date);
  return Object.fromEntries(horizons.map((days) => {
    const future = allPrices[index + days];
    return [`return_${days}d_pct`, future ? round((future.close - current.close) / current.close * 100) : null];
  }));
}

function eventRecord(history, observationDate, lookbackDays, taxonomy, positivePatterns) {
  if (!history?.events) return { status: "missing", reason: "No dated MOPS history response." };
  const events = history.events.filter((event) => {
    const date = event.announced_date || event.date;
    return date && date <= observationDate && dayDiff(observationDate, date) <= lookbackDays;
  });
  const classified = classifyMaterialEvents(events, taxonomy);
  const positive = classified.events.filter((event) => event.risk_class === "neutral" && positivePatterns.some((pattern) => String(event.title || "").includes(pattern))).length;
  return {
    status: "ok",
    event_count: events.length,
    positive_event_count: positive,
    negative_event_count: classified.negative_event_count,
    negative_event_points: classified.negative_event_points,
    review_event_count: classified.review_event_count,
    source_id: history.source_id,
    source_url: history.source_url,
    source_file: history.source_file
  };
}

async function governanceRecord(rawDir, company, observationDate) {
  const file = path.join(rawDir, "governance", `${company.ticker}.json`);
  const source = await optionalJson(file);
  if (!source?.as_of_date || source.as_of_date > observationDate) {
    return { status: "missing", reason: "No dated shareholder, insider-transfer and violation snapshot was collected." };
  }
  const required = ["major_shareholder_count", "insider_transfer_count", "disclosure_violation_count"];
  if (required.some((field) => !Number.isFinite(Number(source[field])))) {
    return { status: "missing", reason: "The dated governance snapshot did not include every required field." };
  }
  return { status: "ok", ...source, source_file: path.relative(root, file) };
}

function evaluateDefinition(definition, sources) {
  if (definition.formula === "weighted_average") {
    const inputs = (definition.inputs || []).map((input) => {
      const record = sources[input.source];
      const value = Number(record?.[input.field]);
      return { value, weight: Number(input.weight) };
    });
    if (inputs.some((input) => !Number.isFinite(input.value) || !Number.isFinite(input.weight))) return null;
    const weight = inputs.reduce((sum, input) => sum + input.weight, 0);
    return weight ? inputs.reduce((sum, input) => sum + input.value * input.weight, 0) / weight : null;
  }
  const record = sources[definition.source];
  if (record?.status !== "ok") return null;
  if (definition.formula === "event_balance") {
    const positive = Number(record[definition.positive_field]);
    const negative = Number(record[definition.negative_field]);
    if (!Number.isFinite(positive) || !Number.isFinite(negative)) return null;
    return clamp(Number(definition.base) + positive * Number(definition.positive_weight) - negative * Number(definition.negative_weight), Number(definition.min_score), Number(definition.max_score));
  }
  const value = Number(record[definition.field]);
  if (!Number.isFinite(value)) return null;
  return definition.formula === "threshold" ? thresholdScore(value, definition) : value;
}

function scoreDimensions(rules, sources) {
  const dimensions = rules.common_dimensions.filter((dimension) => dimension.id !== "industryFundamental");
  const ordered = [...dimensions.filter((dimension) => !["catalyst"].includes(dimension.id)), ...dimensions.filter((dimension) => dimension.id === "catalyst")];
  const results = new Map();
  for (const dimension of ordered) {
    const submetrics = (dimension.submetrics || []).map((definition) => ({ id: definition.id, weight: Number(definition.weight), score: evaluateDefinition(definition, sources) }));
    const valid = submetrics.every((item) => Number.isFinite(item.score));
    const weight = submetrics.reduce((sum, item) => sum + item.weight, 0);
    const score = valid && weight ? Math.round(submetrics.reduce((sum, item) => sum + item.score * item.weight, 0) / weight) : null;
    results.set(dimension.id, { id: dimension.id, label: dimension.label, weight: Number(dimension.weight), status: Number.isFinite(score) ? "ok" : "missing", score, submetrics });
    if (dimension.id === "revenueMomentum") sources.revenue.score = score;
    if (dimension.id === "cashProfitQuality") sources.financial.score = score;
  }
  const rows = dimensions.map((dimension) => results.get(dimension.id));
  if (rows.some((row) => row.status !== "ok")) return { complete: false, score: null, rows, missing_dimensions: rows.filter((row) => row.status !== "ok").map((row) => row.label) };
  const weight = rows.reduce((sum, row) => sum + row.weight, 0);
  return { complete: true, score: Math.round(rows.reduce((sum, row) => sum + row.score * row.weight, 0) / weight), rows, missing_dimensions: [] };
}

function correlation(points) {
  if (points.length < 3) return null;
  const xMean = average(points.map((point) => point.score));
  const yMean = average(points.map((point) => point.return_60d_pct));
  const numerator = points.reduce((sum, point) => sum + (point.score - xMean) * (point.return_60d_pct - yMean), 0);
  const x = Math.sqrt(points.reduce((sum, point) => sum + (point.score - xMean) ** 2, 0));
  const y = Math.sqrt(points.reduce((sum, point) => sum + (point.return_60d_pct - yMean) ** 2, 0));
  return x && y ? round(numerator / (x * y), 3) : null;
}

async function main() {
  const backtestId = argValue("backtest-id");
  if (!backtestId) throw new Error("--backtest-id is required.");
  const outputDir = path.join(root, "backtests", backtestId);
  const rawDir = path.join(outputDir, "raw");
  const [config, rules, taxonomy, cohort] = await Promise.all([
    readJson(path.join(dataDir, "backtest_config.json")),
    readJson(path.join(dataDir, "scoring_rules.json")),
    loadEventTaxonomy(path.join(dataDir, "event_taxonomy.json")),
    readJson(path.join(outputDir, "cohort.json"))
  ]);
  const snapshots = [];
  for (const template of cohort.templates || []) {
    for (const company of template.companies || []) {
      const enriched = { ...company, industry_template: template.industry_template, template_label: template.template_label };
      const priceFile = path.join(rawDir, "prices", `${company.ticker}.json`);
      const historyFile = path.join(rawDir, "mops_history", `${company.ticker}.json`);
      const priceHistory = await optionalJson(priceFile);
      const history = await optionalJson(historyFile);
      for (const observationDate of cohort.observation_dates || []) {
        const [revenue, financial, ownership] = await Promise.all([
          selectRevenue(rawDir, enriched, observationDate, config.sources.mops_monthly_revenue.publication_lag_days),
          selectFinancial(rawDir, enriched, observationDate, config.sources.mops_financial_statements.publication_lag_days),
          governanceRecord(rawDir, enriched, observationDate)
        ]);
        const market = selectMarket(priceHistory, observationDate);
        const catalyst = eventRecord(history, observationDate, config.timeline.event_lookback_days, taxonomy, config.event_classification.positive_patterns || []);
        const risk = catalyst.status === "ok" && ownership.status === "ok"
          ? { status: "ok", negative_event_points: catalyst.negative_event_points, review_event_count: catalyst.review_event_count, disclosure_violation_count: ownership.disclosure_violation_count, source_id: catalyst.source_id }
          : { status: "missing", reason: "Risk requires both dated MOPS events and dated violation data." };
        const sources = { catalyst, revenue, financial, market, ownership, risk };
        const scoring = scoreDimensions(rules, sources);
        snapshots.push({
          company: enriched,
          observation_date: observationDate,
          score: scoring.score,
          complete: scoring.complete,
          missing_dimensions: scoring.missing_dimensions,
          dimensions: scoring.rows,
          sources,
          outcomes: forwardReturns(priceHistory, observationDate, config.timeline.forward_return_days)
        });
      }
    }
  }
  const complete = snapshots.filter((snapshot) => snapshot.complete);
  const missing = Object.fromEntries(["催化事件", "營收動能", "獲利與財務韌性", "股價位置與趨勢", "股權與治理訊號", "事件與合規風險"].map((label) => [label, snapshots.filter((snapshot) => snapshot.missing_dimensions.includes(label)).length]));
  const report = {
    version: "1.0.0",
    generated_at: new Date().toISOString(),
    backtest_id: backtestId,
    methodology: "Point-in-time: every source record must be dated on or before observation_date. No current source-cache value is used as a historical substitute. Total score exists only when all six core dimensions are present.",
    observations: snapshots.length,
    complete_observations: complete.length,
    incomplete_observations: snapshots.length - complete.length,
    missing_by_dimension: missing,
    complete_score_average: round(average(complete.map((snapshot) => snapshot.score))),
    forward_20d_average_pct: round(average(complete.map((snapshot) => snapshot.outcomes.return_20d_pct))),
    forward_60d_average_pct: round(average(complete.map((snapshot) => snapshot.outcomes.return_60d_pct))),
    forward_120d_average_pct: round(average(complete.map((snapshot) => snapshot.outcomes.return_120d_pct))),
    score_return_60d_correlation: correlation(complete.filter((snapshot) => Number.isFinite(snapshot.outcomes.return_60d_pct))),
    note: "Incomplete observations are retained to expose source coverage gaps; they are excluded from any score-performance statistic."
  };
  await writeJson(path.join(outputDir, "snapshots.json"), { version: "1.0.0", generated_at: new Date().toISOString(), snapshots });
  await writeJson(path.join(outputDir, "report.json"), report);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
