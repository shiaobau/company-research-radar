import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dimensionIds = ["catalyst", "revenueMomentum", "cashProfitQuality", "priceTrend", "ownership", "riskNews"];
const dimensionLabels = {
  catalyst: "催化事件",
  revenueMomentum: "營收動能",
  cashProfitQuality: "獲利與財務韌性",
  priceTrend: "股價位置與趨勢",
  ownership: "股權與治理訊號",
  riskNews: "事件與合規風險"
};
const defaultWeights = {
  catalyst: 0.2,
  revenueMomentum: 0.2,
  cashProfitQuality: 0.2,
  priceTrend: 0.15,
  ownership: 0.1,
  riskNews: 0.15
};
const weightRanges = {
  catalyst: [0.1, 0.25],
  revenueMomentum: [0.1, 0.25],
  cashProfitQuality: [0.1, 0.3],
  priceTrend: [0.1, 0.3],
  ownership: [0.05, 0.15],
  riskNews: [0.1, 0.25]
};
const defaultThresholds = { priority: 75, monitor: 60 };

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function median(values) {
  const clean = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function standardDeviation(values) {
  const mean = average(values);
  return Number.isFinite(mean) ? Math.sqrt(average(values.map((value) => (value - mean) ** 2))) : null;
}

function pearsonPairs(left, right) {
  if (left.length < 3 || left.length !== right.length) return null;
  const leftMean = average(left);
  const rightMean = average(right);
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const leftSpread = Math.sqrt(left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0));
  const rightSpread = Math.sqrt(right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0));
  return leftSpread && rightSpread ? numerator / (leftSpread * rightSpread) : null;
}

function ranks(values) {
  const indexed = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
  const result = Array(values.length);
  for (let start = 0; start < indexed.length;) {
    let end = start;
    while (end + 1 < indexed.length && indexed[end + 1].value === indexed[start].value) end += 1;
    const rank = (start + end + 2) / 2;
    for (let position = start; position <= end; position += 1) result[indexed[position].index] = rank;
    start = end + 1;
  }
  return result;
}

function spearman(rows) {
  if (rows.length < 3) return null;
  return pearsonPairs(ranks(rows.map((row) => row.score)), ranks(rows.map((row) => row.relative_return_pct)));
}

function scoreFor(row, weights) {
  return Math.round(dimensionIds.reduce((sum, id) => sum + row.dimensions[id] * weights[id], 0));
}

function tierSummary(rows) {
  return {
    count: rows.length,
    average_return_pct: round(average(rows.map((row) => row.return_pct))),
    median_return_pct: round(median(rows.map((row) => row.return_pct))),
    positive_return_rate_pct: rows.length ? round(rows.filter((row) => row.return_pct > 0).length / rows.length * 100, 1) : null,
    average_relative_return_pct: round(average(rows.map((row) => row.relative_return_pct))),
    median_relative_return_pct: round(median(rows.map((row) => row.relative_return_pct))),
    positive_relative_rate_pct: rows.length ? round(rows.filter((row) => row.relative_return_pct > 0).length / rows.length * 100, 1) : null
  };
}

function evaluation(rows, weights, thresholds) {
  const scored = rows.map((row) => ({ ...row, score: scoreFor(row, weights) }));
  const priority = scored.filter((row) => row.score >= thresholds.priority);
  const monitor = scored.filter((row) => row.score >= thresholds.monitor && row.score < thresholds.priority);
  const defer = scored.filter((row) => row.score < thresholds.monitor);
  const dates = [...new Set(scored.map((row) => row.observation_date))].sort();
  const perDate = Object.fromEntries(dates.map((date) => {
    const dateRows = scored.filter((row) => row.observation_date === date);
    const datePriority = dateRows.filter((row) => row.score >= thresholds.priority);
    const dateDefer = dateRows.filter((row) => row.score < thresholds.monitor);
    const priorityAverage = average(datePriority.map((row) => row.relative_return_pct));
    const deferAverage = average(dateDefer.map((row) => row.relative_return_pct));
    return [date, {
      count: dateRows.length,
      spearman: round(spearman(dateRows), 3),
      priority_count: datePriority.length,
      defer_count: dateDefer.length,
      priority_minus_defer_relative_return_pct: Number.isFinite(priorityAverage) && Number.isFinite(deferAverage) ? round(priorityAverage - deferAverage) : null
    }];
  }));
  const prioritySummary = tierSummary(priority);
  const deferSummary = tierSummary(defer);
  const spread = Number.isFinite(prioritySummary.average_relative_return_pct) && Number.isFinite(deferSummary.average_relative_return_pct)
    ? round(prioritySummary.average_relative_return_pct - deferSummary.average_relative_return_pct)
    : null;
  const dateSpreads = Object.values(perDate).map((item) => item.priority_minus_defer_relative_return_pct).filter(Number.isFinite);
  return {
    observation_count: scored.length,
    company_count: new Set(scored.map((row) => row.ticker)).size,
    observation_dates: dates,
    score_return_spearman: round(spearman(scored), 3),
    average_monthly_spearman: round(average(Object.values(perDate).map((item) => item.spearman)), 3),
    tiers: {
      priority: prioritySummary,
      monitor: tierSummary(monitor),
      defer: deferSummary
    },
    priority_minus_defer_relative_return_pct: spread,
    average_monthly_priority_minus_defer_pct: round(average(dateSpreads)),
    positive_spread_month_rate_pct: dateSpreads.length ? round(dateSpreads.filter((value) => value > 0).length / dateSpreads.length * 100, 1) : null,
    covered_spread_months: dateSpreads.length,
    per_date: perDate
  };
}

function weightCandidates() {
  const values = Object.fromEntries(dimensionIds.map((id) => {
    const [minimum, maximum] = weightRanges[id];
    const entries = [];
    for (let value = minimum; value <= maximum + 0.0001; value += 0.05) entries.push(round(value, 2));
    return [id, entries];
  }));
  const candidates = [];
  function visit(index, remaining, current) {
    if (index === dimensionIds.length) {
      if (Math.abs(remaining) < 0.0001) candidates.push({ ...current });
      return;
    }
    const id = dimensionIds[index];
    for (const value of values[id]) {
      if (value <= remaining + 0.0001) visit(index + 1, round(remaining - value, 2), { ...current, [id]: value });
    }
  }
  visit(0, 1, {});
  return candidates;
}

function thresholdCandidates() {
  const priorityValues = [70, 72, 74, 75, 76, 78, 80];
  const monitorValues = [56, 58, 60, 62, 64];
  return priorityValues.flatMap((priority) => monitorValues
    .filter((monitor) => priority - monitor >= 8)
    .map((monitor) => ({ priority, monitor })));
}

function weightDistance(weights) {
  return dimensionIds.reduce((sum, id) => sum + Math.abs(weights[id] - defaultWeights[id]), 0);
}

function objective(metrics, weights, minimumTierCount) {
  const { priority, defer } = metrics.tiers;
  if (priority.count < minimumTierCount || defer.count < minimumTierCount) return -Infinity;
  if (metrics.covered_spread_months < Math.ceil(metrics.observation_dates.length * 0.6)) return -Infinity;
  if (![metrics.score_return_spearman, metrics.priority_minus_defer_relative_return_pct, priority.positive_relative_rate_pct].every(Number.isFinite)) return -Infinity;
  return metrics.score_return_spearman * 15
    + metrics.priority_minus_defer_relative_return_pct
    + (priority.positive_relative_rate_pct - 50) * 0.08
    + (metrics.positive_spread_month_rate_pct - 50) * 0.03
    - weightDistance(weights) * 4;
}

function dimensionDiagnostics(rows) {
  return Object.fromEntries(dimensionIds.map((id) => {
    const dimensionRows = rows.map((row) => ({ score: row.dimensions[id], relative_return_pct: row.relative_return_pct }));
    return [id, {
      label: dimensionLabels[id],
      average_score: round(average(dimensionRows.map((row) => row.score))),
      score_standard_deviation: round(standardDeviation(dimensionRows.map((row) => row.score))),
      spearman_to_relative_return: round(spearman(dimensionRows), 3)
    }];
  }));
}

function industryDiagnostics(rows, baseline, candidate) {
  const templates = [...new Set(rows.map((row) => row.template))].sort();
  return Object.fromEntries(templates.map((template) => {
    const subset = rows.filter((row) => row.template === template);
    return [template, {
      observations: subset.length,
      companies: new Set(subset.map((row) => row.ticker)).size,
      baseline: evaluation(subset, baseline.weights, baseline.thresholds),
      candidate: evaluation(subset, candidate.weights, candidate.thresholds)
    }];
  }));
}

function markdown(report) {
  const line = (label, result) => {
    const metric = result.metrics;
    return `| ${label} | ${metric.observation_count} | ${metric.score_return_spearman ?? "NA"} | ${metric.tiers.priority.positive_return_rate_pct ?? "NA"}% | ${metric.tiers.priority.positive_relative_rate_pct ?? "NA"}% | ${metric.priority_minus_defer_relative_return_pct ?? "NA"}% | ${metric.positive_spread_month_rate_pct ?? "NA"}% |`;
  };
  return [
    "# 一年期歷史校準報告",
    "",
    `- 樣本公司：${report.panel.company_count} 家；完整且具 20 日結果的公司月份：${report.panel.usable_observations} 筆。`,
    `- 訓練：${report.splits.training_dates.join("、")}；驗證：${report.splits.validation_dates.join("、")}；保留測試：${report.splits.test_dates.join("、")}。`,
    "- 所有績效都以觀察日當時可見資料計算；測試集不參與候選公式選擇。",
    "",
    "| 方案與資料段 | 樣本 | Spearman | 優先觀察上漲率 | 優先觀察相對勝率 | 優先減待確認報酬差 | 正向月份比率 |",
    "|---|---:|---:|---:|---:|---:|---:|",
    line("現行公式／訓練", report.baseline.training),
    line("候選公式／訓練", report.candidate.training),
    line("現行公式／驗證", report.baseline.validation),
    line("候選公式／驗證", report.candidate.validation),
    line("現行公式／保留測試", report.baseline.test),
    line("候選公式／保留測試", report.candidate.test),
    "",
    `最終判定：${report.holdout_gate.passed ? "候選公式通過保留測試，可進入人工審查；尚未自動套用正式網站。" : "候選公式未通過保留測試，不得套用正式網站。"}`,
    "",
    `候選權重：${dimensionIds.map((id) => `${dimensionLabels[id]} ${Math.round(report.candidate.weights[id] * 100)}%`).join("、")}。`,
    `候選級距：優先觀察 ${report.candidate.thresholds.priority} 分以上、持續追蹤 ${report.candidate.thresholds.monitor}–${report.candidate.thresholds.priority - 1} 分。`
  ].join("\n");
}

async function main() {
  const source = argValue("source", "backtests/historical-calibration-15x10-12m/snapshots.json");
  const output = argValue("out", "backtests/historical-calibration-15x10-12m/calibration");
  const payload = JSON.parse(await readFile(path.resolve(root, source), "utf8"));
  const complete = (payload.snapshots || []).filter((snapshot) => snapshot.complete && Number.isFinite(snapshot.outcomes?.return_20d_pct));
  const calibrationSnapshots = complete.filter((snapshot) => snapshot.company.industry_template !== "financial");
  const peerKeys = [...new Set(calibrationSnapshots.map((snapshot) => `${snapshot.observation_date}:${snapshot.company.industry_template}`))];
  const peerAverages = Object.fromEntries(peerKeys.map((key) => {
    const [date, template] = key.split(":");
    return [key, average(calibrationSnapshots
      .filter((snapshot) => snapshot.observation_date === date && snapshot.company.industry_template === template)
      .map((snapshot) => snapshot.outcomes.return_20d_pct))];
  }));
  const rows = calibrationSnapshots.map((snapshot) => ({
    ticker: snapshot.company.ticker,
    name: snapshot.company.name,
    template: snapshot.company.industry_template,
    observation_date: snapshot.observation_date,
    return_pct: snapshot.outcomes.return_20d_pct,
    relative_return_pct: snapshot.outcomes.return_20d_pct - peerAverages[`${snapshot.observation_date}:${snapshot.company.industry_template}`],
    dimensions: Object.fromEntries(snapshot.dimensions.map((dimension) => [dimension.id, Number(dimension.score)]))
  })).filter((row) => dimensionIds.every((id) => Number.isFinite(row.dimensions[id])));
  const dates = [...new Set(rows.map((row) => row.observation_date))].sort();
  if (dates.length < 12) throw new Error(`Expected 12 usable observation dates, found ${dates.length}.`);
  const trainingDates = dates.slice(0, 8);
  const validationDates = dates.slice(8, 10);
  const testDates = dates.slice(10, 12);
  const selectDates = (selected) => rows.filter((row) => selected.includes(row.observation_date));
  const trainingRows = selectDates(trainingDates);
  const validationRows = selectDates(validationDates);
  const testRows = selectDates(testDates);
  const baselineRule = { weights: defaultWeights, thresholds: defaultThresholds };
  const baseline = {
    training: { ...baselineRule, metrics: evaluation(trainingRows, defaultWeights, defaultThresholds) },
    validation: { ...baselineRule, metrics: evaluation(validationRows, defaultWeights, defaultThresholds) },
    test: { ...baselineRule, metrics: evaluation(testRows, defaultWeights, defaultThresholds) }
  };

  const weights = weightCandidates();
  const thresholds = thresholdCandidates();
  const trainingMinimum = Math.max(30, Math.ceil(trainingRows.length * 0.05));
  const searched = [];
  for (const candidateWeights of weights) {
    for (const candidateThresholds of thresholds) {
      const metrics = evaluation(trainingRows, candidateWeights, candidateThresholds);
      const value = objective(metrics, candidateWeights, trainingMinimum);
      if (Number.isFinite(value)) searched.push({ weights: candidateWeights, thresholds: candidateThresholds, training: metrics, training_objective: round(value, 4) });
    }
  }
  searched.sort((left, right) => right.training_objective - left.training_objective);
  const finalists = searched.slice(0, 100).map((candidate) => {
    const validation = evaluation(validationRows, candidate.weights, candidate.thresholds);
    const validationMinimum = Math.max(15, Math.ceil(validationRows.length * 0.05));
    return { ...candidate, validation, validation_objective: round(objective(validation, candidate.weights, validationMinimum), 4) };
  }).filter((candidate) => Number.isFinite(candidate.validation_objective));
  finalists.sort((left, right) => right.validation_objective - left.validation_objective);
  const selected = finalists[0];
  if (!selected) throw new Error("No candidate passed the training and validation sample-coverage rules.");
  const candidate = {
    weights: selected.weights,
    thresholds: selected.thresholds,
    training: { weights: selected.weights, thresholds: selected.thresholds, metrics: selected.training },
    validation: { weights: selected.weights, thresholds: selected.thresholds, metrics: selected.validation },
    test: { weights: selected.weights, thresholds: selected.thresholds, metrics: evaluation(testRows, selected.weights, selected.thresholds) }
  };
  const baselineTest = baseline.test.metrics;
  const candidateTest = candidate.test.metrics;
  const holdoutGate = {
    minimum_test_tier_count: 15,
    minimum_spearman: Math.max(0.05, (baselineTest.score_return_spearman ?? 0) + 0.03),
    minimum_priority_relative_hit_pct: Math.max(50, baselineTest.tiers.priority.positive_relative_rate_pct ?? 0),
    minimum_priority_minus_defer_pct: Math.max(1, baselineTest.priority_minus_defer_relative_return_pct ?? 0),
    minimum_positive_spread_month_rate_pct: 50,
    passed: false
  };
  holdoutGate.passed = candidateTest.tiers.priority.count >= holdoutGate.minimum_test_tier_count
    && candidateTest.tiers.defer.count >= holdoutGate.minimum_test_tier_count
    && (candidateTest.score_return_spearman ?? -Infinity) >= holdoutGate.minimum_spearman
    && (candidateTest.tiers.priority.positive_relative_rate_pct ?? -Infinity) >= holdoutGate.minimum_priority_relative_hit_pct
    && (candidateTest.priority_minus_defer_relative_return_pct ?? -Infinity) >= holdoutGate.minimum_priority_minus_defer_pct
    && (candidateTest.positive_spread_month_rate_pct ?? -Infinity) >= holdoutGate.minimum_positive_spread_month_rate_pct;

  const report = {
    version: "1.0.0",
    generated_at: new Date().toISOString(),
    source,
    methodology: {
      outcome: "20-trading-day company return minus the same-observation-date, same-industry peer average return.",
      selection: "Search on the first eight months, choose among the top 100 training candidates using the next two months, and open the final two-month holdout only once.",
      guardrail: "This report never edits production scoring rules. A candidate must pass every holdout gate before it can enter manual review.",
      exclusions: "Financial companies are excluded from shared-weight calibration because the point-in-time common statement parser yielded only one complete financial company; financial calibration remains a separate track."
    },
    panel: {
      company_count: new Set(rows.map((row) => row.ticker)).size,
      usable_observations: rows.length,
      complete_snapshot_count: complete.length,
      source_snapshot_count: (payload.snapshots || []).length
    },
    splits: {
      training_dates: trainingDates,
      validation_dates: validationDates,
      test_dates: testDates,
      training_count: trainingRows.length,
      validation_count: validationRows.length,
      test_count: testRows.length
    },
    search: {
      weight_candidates: weights.length,
      threshold_candidates: thresholds.length,
      eligible_training_candidates: searched.length,
      validation_finalists: finalists.length,
      training_minimum_extreme_tier_count: trainingMinimum
    },
    baseline,
    candidate,
    holdout_gate: holdoutGate,
    dimension_diagnostics: {
      training: dimensionDiagnostics(trainingRows),
      validation: dimensionDiagnostics(validationRows),
      test: dimensionDiagnostics(testRows)
    },
    test_industry_diagnostics: industryDiagnostics(testRows, baselineRule, { weights: selected.weights, thresholds: selected.thresholds }),
    top_validation_candidates: finalists.slice(0, 10).map((item) => ({
      weights: item.weights,
      thresholds: item.thresholds,
      training_objective: item.training_objective,
      validation_objective: item.validation_objective,
      validation_spearman: item.validation.score_return_spearman,
      validation_priority_relative_hit_pct: item.validation.tiers.priority.positive_relative_rate_pct,
      validation_priority_minus_defer_pct: item.validation.priority_minus_defer_relative_return_pct
    }))
  };
  const outputDir = path.resolve(root, output);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "calibration.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputDir, "calibration.md"), `${markdown(report)}\n`, "utf8");
  console.log(JSON.stringify({
    output,
    panel: report.panel,
    splits: report.splits,
    candidate: { weights: candidate.weights, thresholds: candidate.thresholds },
    holdout_gate: holdoutGate
  }, null, 2));
}

await main();
