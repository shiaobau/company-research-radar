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
const ranges = {
  catalyst: [0.1, 0.25],
  revenueMomentum: [0.1, 0.25],
  cashProfitQuality: [0.1, 0.3],
  priceTrend: [0.1, 0.3],
  ownership: [0.05, 0.15],
  riskNews: [0.1, 0.25]
};

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function standardDeviation(values) {
  const mean = average(values);
  return Number.isFinite(mean) ? Math.sqrt(average(values.map((value) => (value - mean) ** 2))) : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pearson(rows, leftKey = "score", rightKey = "relative_return_pct") {
  if (rows.length < 3) return null;
  const leftMean = average(rows.map((row) => row[leftKey]));
  const rightMean = average(rows.map((row) => row[rightKey]));
  const numerator = rows.reduce((sum, row) => sum + (row[leftKey] - leftMean) * (row[rightKey] - rightMean), 0);
  const leftSpread = Math.sqrt(rows.reduce((sum, row) => sum + (row[leftKey] - leftMean) ** 2, 0));
  const rightSpread = Math.sqrt(rows.reduce((sum, row) => sum + (row[rightKey] - rightMean) ** 2, 0));
  return leftSpread && rightSpread ? numerator / (leftSpread * rightSpread) : null;
}

function rank(values) {
  const indexed = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
  const result = Array(values.length);
  let position = 0;
  while (position < indexed.length) {
    let end = position;
    while (end + 1 < indexed.length && indexed[end + 1].value === indexed[position].value) end += 1;
    const rankValue = (position + end + 2) / 2;
    for (let cursor = position; cursor <= end; cursor += 1) result[indexed[cursor].index] = rankValue;
    position = end + 1;
  }
  return result;
}

function spearman(rows) {
  if (rows.length < 3) return null;
  const scoreRanks = rank(rows.map((row) => row.score));
  const returnRanks = rank(rows.map((row) => row.relative_return_pct));
  return pearson(scoreRanks.map((score, index) => ({ score, relative_return_pct: returnRanks[index] })));
}

function scoreFor(row, weights) {
  return dimensionIds.reduce((sum, id) => sum + row.dimensions[id] * weights[id], 0);
}

function rowsForWeights(rows, weights) {
  return rows.map((row) => ({ ...row, score: scoreFor(row, weights) }));
}

function thresholdMetrics(rows, thresholds) {
  const groups = {
    priority: rows.filter((row) => row.score >= thresholds.priority),
    monitor: rows.filter((row) => row.score >= thresholds.monitor && row.score < thresholds.priority),
    defer: rows.filter((row) => row.score < thresholds.monitor)
  };
  const summarize = (items) => {
    const relativeReturns = items.map((row) => row.relative_return_pct);
    const returns = items.map((row) => row.return_pct);
    return {
      count: items.length,
      average_relative_return_pct: round(average(relativeReturns)),
      median_relative_return_pct: round(median(relativeReturns)),
      positive_relative_rate_pct: items.length ? round(items.filter((row) => row.relative_return_pct > 0).length / items.length * 100, 1) : null,
      average_return_pct: round(average(returns)),
      median_return_pct: round(median(returns))
    };
  };
  const result = Object.fromEntries(Object.entries(groups).map(([id, items]) => [id, summarize(items)]));
  const spread = Number.isFinite(result.priority.average_relative_return_pct) && Number.isFinite(result.defer.average_relative_return_pct)
    ? round(result.priority.average_relative_return_pct - result.defer.average_relative_return_pct)
    : null;
  return { thresholds, tiers: result, priority_minus_defer_relative_return_pct: spread };
}

function evaluation(rows, weights, thresholds) {
  const scored = rowsForWeights(rows, weights);
  const threshold = thresholdMetrics(scored, thresholds);
  return {
    observation_count: scored.length,
    score_average: round(average(scored.map((row) => row.score))),
    score_return_pearson: round(pearson(scored)),
    score_return_spearman: round(spearman(scored)),
    thresholds: threshold
  };
}

function dimensionDiagnostics(rows) {
  return Object.fromEntries(dimensionIds.map((id) => {
    const values = rows.map((row) => row.dimensions[id]);
    const returns = rows.map((row) => row.relative_return_pct);
    return [id, {
      label: dimensionLabels[id],
      average_score: round(average(values)),
      score_standard_deviation: round(standardDeviation(values)),
      correlation_to_relative_return: round(pearson(values.map((score, index) => ({ score, relative_return_pct: returns[index] }))))
    }];
  }));
}

function weightCandidates() {
  const values = Object.fromEntries(dimensionIds.map((id) => {
    const [minimum, maximum] = ranges[id];
    const items = [];
    for (let value = minimum; value <= maximum + 0.0001; value += 0.05) items.push(round(value, 2));
    return [id, items];
  }));
  const candidates = [];
  function visit(index, remaining, current) {
    if (index === dimensionIds.length) {
      if (Math.abs(remaining) < 0.0001) candidates.push({ ...current });
      return;
    }
    const id = dimensionIds[index];
    for (const value of values[id]) {
      if (value > remaining + 0.0001) continue;
      visit(index + 1, round(remaining - value, 2), { ...current, [id]: value });
    }
  }
  visit(0, 1, {});
  return candidates;
}

function thresholdCandidates() {
  const candidates = [];
  for (let priority = 68; priority <= 78; priority += 2) {
    for (let monitor = 54; monitor <= 64; monitor += 2) {
      if (priority - monitor >= 8) candidates.push({ priority, monitor });
    }
  }
  return candidates;
}

function selectionObjective(metrics) {
  const { priority, defer } = metrics.thresholds.tiers;
  const spread = metrics.thresholds.priority_minus_defer_relative_return_pct;
  if (priority.count < 15 || defer.count < 15 || !Number.isFinite(spread)) return -Infinity;
  const correlation = metrics.score_return_spearman ?? -1;
  return spread + correlation * 8 + (priority.positive_relative_rate_pct - 50) * 0.05;
}

function formatWeights(weights) {
  return dimensionIds.map((id) => `${dimensionLabels[id]} ${Math.round(weights[id] * 100)}%`).join("、");
}

function markdown(result) {
  const section = (title, item) => {
    const metric = item.metrics;
    const tiers = metric.thresholds.tiers;
    return [
      `## ${title}`,
      "",
      `- 權重：${formatWeights(item.weights)}`,
      `- 分級：優先追蹤 ${item.thresholds.priority}+；持續追蹤 ${item.thresholds.monitor}-${item.thresholds.priority - 1}；暫緩研究 < ${item.thresholds.monitor}`,
      `- 樣本：${metric.observation_count}；Spearman：${metric.score_return_spearman ?? "NA"}；Pearson：${metric.score_return_pearson ?? "NA"}`,
      `- 優先組相對暫緩組：${metric.thresholds.priority_minus_defer_relative_return_pct ?? "NA"}%`,
      "",
      "| 分級 | 樣本 | 平均相對報酬 | 中位相對報酬 | 相對勝率 | 平均絕對報酬 |",
      "|---|---:|---:|---:|---:|---:|",
      ...["priority", "monitor", "defer"].map((id) => {
        const tier = tiers[id];
        const label = { priority: "優先追蹤", monitor: "持續追蹤", defer: "暫緩研究" }[id];
        return `| ${label} | ${tier.count} | ${tier.average_relative_return_pct ?? "NA"}% | ${tier.median_relative_return_pct ?? "NA"}% | ${tier.positive_relative_rate_pct ?? "NA"}% | ${tier.average_return_pct ?? "NA"}% |`;
      })
    ].join("\n");
  };
  const decision = result.validation_gate.passed
    ? "候選規則通過本次留出期間的最低驗證條件，可進入人工審核，但仍不應直接視為投資建議。"
    : "候選規則未通過留出期間的最低驗證條件；維持現行規則，不把訓練期的最佳結果直接套用到主站。";
  return [
    "# 目前六項核心模型校正報告",
    "",
    "本報告只使用觀察日已公開的六項核心快照，並以每個觀察日橫斷面平均報酬扣除後的『相對報酬』作校正，避免把整體大盤上漲誤判為模型有效。",
    "",
    `- 訓練期：${result.splits.training_dates.join("、")}，${result.splits.training_count} 筆。`,
    `- 留出驗證期：${result.splits.validation_dates.join("、")}，${result.splits.validation_count} 筆。`,
    `- 診斷期：${result.splits.diagnostic_dates.join("、")}，${result.splits.diagnostic_count} 筆；樣本不足，不用於採納決策。`,
    "",
    section("現行規則：訓練期", result.baseline.training),
    "",
    section("現行規則：留出驗證期", result.baseline.validation),
    "",
    section("訓練期最佳候選", result.candidate.training),
    "",
    section("候選規則：留出驗證期", result.candidate.validation),
    "",
    "## 單一維度診斷",
    "",
    "| 維度 | 訓練期相關性 | 留出期相關性 | 訓練期分數標準差 | 留出期分數標準差 |",
    "|---|---:|---:|---:|---:|",
    ...dimensionIds.map((id) => {
      const training = result.dimension_diagnostics.training[id];
      const validation = result.dimension_diagnostics.validation[id];
      return `| ${training.label} | ${training.correlation_to_relative_return ?? "NA"} | ${validation.correlation_to_relative_return ?? "NA"} | ${training.score_standard_deviation ?? "NA"} | ${validation.score_standard_deviation ?? "NA"} |`;
    }),
    "",
    "解讀：只有在訓練期與留出期都維持相近方向、且分數本身有足夠差異的維度，才適合提高核心排序權重。變異很小的治理與風險資料較適合作為風險閘門或扣分依據，而不是用來拉開公司排序。",
    "",
    "## 採納判定",
    "",
    `- 結果：${decision}`,
    `- 最低條件：留出期 Spearman >= 0.10、優先組相對暫緩組 >= 3%、優先組相對勝率 >= 55%、優先與暫緩組各至少 15 筆。`,
    "",
    "## 解讀限制",
    "",
    "- 目前只有兩個完整的 20 日歷史區間可作訓練與留出驗證，尚不足以證明跨景氣循環的穩定預測力。",
    "- 分數應用於研究排序與追蹤優先度；不代表買進、賣出或保證績效。",
    "- 產業證據調整是加減分項，這批六項核心快照沒有將其納入權重搜尋。"
  ].join("\n");
}

async function main() {
  const source = argValue("source", "backtests/full-six-140-2026-h1/snapshots.json");
  const out = argValue("out", "backtests/2026-Q2_Q3_current_model_calibration");
  const payload = JSON.parse(await readFile(path.resolve(root, source), "utf8"));
  const complete = (payload.snapshots || []).filter((snapshot) => snapshot.complete && Number.isFinite(snapshot.outcomes?.return_20d_pct));
  const dateAverages = Object.fromEntries([...new Set(complete.map((row) => row.observation_date))].map((date) => {
    const returns = complete.filter((row) => row.observation_date === date).map((row) => row.outcomes.return_20d_pct);
    return [date, average(returns)];
  }));
  const rows = complete.map((snapshot) => ({
    ticker: snapshot.company.ticker,
    name: snapshot.company.name,
    template: snapshot.company.template_label,
    observation_date: snapshot.observation_date,
    return_pct: snapshot.outcomes.return_20d_pct,
    relative_return_pct: snapshot.outcomes.return_20d_pct - dateAverages[snapshot.observation_date],
    dimensions: Object.fromEntries(snapshot.dimensions.map((dimension) => [dimension.id, Number(dimension.score)]))
  })).filter((row) => dimensionIds.every((id) => Number.isFinite(row.dimensions[id])));
  const dates = [...new Set(rows.map((row) => row.observation_date))].sort();
  const trainingDates = dates.slice(0, 1);
  const validationDates = dates.slice(1, 2);
  const diagnosticDates = dates.slice(2);
  const trainingRows = rows.filter((row) => trainingDates.includes(row.observation_date));
  const validationRows = rows.filter((row) => validationDates.includes(row.observation_date));
  const diagnosticRows = rows.filter((row) => diagnosticDates.includes(row.observation_date));
  const defaultThresholds = { priority: 75, monitor: 60 };
  const baseline = {
    training: { weights: defaultWeights, thresholds: defaultThresholds, metrics: evaluation(trainingRows, defaultWeights, defaultThresholds) },
    validation: { weights: defaultWeights, thresholds: defaultThresholds, metrics: evaluation(validationRows, defaultWeights, defaultThresholds) },
    diagnostic: { weights: defaultWeights, thresholds: defaultThresholds, metrics: evaluation(diagnosticRows, defaultWeights, defaultThresholds) }
  };
  const searches = [];
  for (const weights of weightCandidates()) {
    for (const thresholds of thresholdCandidates()) {
      const metrics = evaluation(trainingRows, weights, thresholds);
      const objective = selectionObjective(metrics);
      if (Number.isFinite(objective)) searches.push({ weights, thresholds, metrics, objective: round(objective, 4) });
    }
  }
  searches.sort((left, right) => right.objective - left.objective);
  const selected = searches[0];
  if (!selected) throw new Error("No candidate met the minimum train-sample requirements.");
  const candidate = {
    training: { weights: selected.weights, thresholds: selected.thresholds, metrics: selected.metrics },
    validation: { weights: selected.weights, thresholds: selected.thresholds, metrics: evaluation(validationRows, selected.weights, selected.thresholds) },
    diagnostic: { weights: selected.weights, thresholds: selected.thresholds, metrics: evaluation(diagnosticRows, selected.weights, selected.thresholds) }
  };
  const validationTier = candidate.validation.metrics.thresholds.tiers;
  const validationGate = {
    min_spearman: 0.1,
    min_priority_minus_defer_relative_return_pct: 3,
    min_priority_positive_relative_rate_pct: 55,
    min_tier_sample_count: 15
  };
  const passed = (candidate.validation.metrics.score_return_spearman ?? -1) >= validationGate.min_spearman
    && (candidate.validation.metrics.thresholds.priority_minus_defer_relative_return_pct ?? -Infinity) >= validationGate.min_priority_minus_defer_relative_return_pct
    && (validationTier.priority.positive_relative_rate_pct ?? -Infinity) >= validationGate.min_priority_positive_relative_rate_pct
    && validationTier.priority.count >= validationGate.min_tier_sample_count
    && validationTier.defer.count >= validationGate.min_tier_sample_count;
  const result = {
    version: "1.0.0",
    generated_at: new Date().toISOString(),
    source,
    methodology: {
      scoring: "Six core dimensions only. Industry evidence remains a separate adjustment and is excluded from the search.",
      selection: "Optimize only on the first complete observation date, then evaluate the chosen rule on the next complete observation date.",
      outcome: "20-day forward return minus the same-date cross-sectional average return."
    },
    splits: {
      training_dates: trainingDates,
      validation_dates: validationDates,
      diagnostic_dates: diagnosticDates,
      training_count: trainingRows.length,
      validation_count: validationRows.length,
      diagnostic_count: diagnosticRows.length
    },
    default_weights: defaultWeights,
    default_thresholds: defaultThresholds,
    search: {
      weight_candidate_count: weightCandidates().length,
      threshold_candidate_count: thresholdCandidates().length,
      eligible_combination_count: searches.length,
      objective: "Priority-vs-defer relative-return spread, then rank correlation and priority relative hit rate; each extreme tier needs at least 15 training observations."
    },
    baseline,
    candidate,
    dimension_diagnostics: {
      training: dimensionDiagnostics(trainingRows),
      validation: dimensionDiagnostics(validationRows),
      diagnostic: dimensionDiagnostics(diagnosticRows)
    },
    validation_gate: { ...validationGate, passed },
    top_training_candidates: searches.slice(0, 10).map((item) => ({
      weights: item.weights,
      thresholds: item.thresholds,
      objective: item.objective,
      score_return_spearman: item.metrics.score_return_spearman,
      priority_minus_defer_relative_return_pct: item.metrics.thresholds.priority_minus_defer_relative_return_pct,
      priority_count: item.metrics.thresholds.tiers.priority.count,
      defer_count: item.metrics.thresholds.tiers.defer.count
    }))
  };
  const outDir = path.resolve(root, out);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "calibration.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "calibration.md"), `${markdown(result)}\n`, "utf8");
  console.log(JSON.stringify({ out, validation_passed: passed, candidate: result.candidate.validation.metrics }, null, 2));
}

await main();
