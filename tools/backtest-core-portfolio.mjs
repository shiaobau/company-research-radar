import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const defaultFiles = [
  "backtests/2026-04-16_to_2026-05-16_15_templates_x10/backtest.json",
  "backtests/2026-05-16_to_2026-06-16_15_templates_x10/backtest.json",
  "backtests/2026-06-16_to_2026-07-16_15_templates_x10/backtest.json"
];
const argValue = (name, fallback) => {
  const value = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return value ? value.slice(name.length + 3) : fallback;
};
const inputFiles = argValue("files", defaultFiles.join(",")).split(",").filter(Boolean);
const outDir = path.resolve(root, argValue("out", "backtests/2026-Q2_Q3_core_portfolio_validation"));
const rules = JSON.parse(await readFile(path.join(root, "data", "scoring_rules.json"), "utf8"));
const coreDimensions = (rules.common_dimensions || []).filter((dimension) => dimension.role !== "adjustment");
const weights = Object.fromEntries(coreDimensions.map((dimension) => [dimension.id, Number(dimension.weight || 0)]));
const bands = [...(rules.score_bands || [])].sort((left, right) => Number(right.min) - Number(left.min));
const readJson = async (file) => JSON.parse(await readFile(path.resolve(root, file), "utf8"));
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const bandFor = (score) => bands.find((band) => score >= Number(band.min)) || bands.at(-1);
const pearson = (pairs) => {
  if (pairs.length < 3) return null;
  const xMean = average(pairs.map((pair) => pair.score));
  const yMean = average(pairs.map((pair) => pair.return_pct));
  const numerator = pairs.reduce((sum, pair) => sum + (pair.score - xMean) * (pair.return_pct - yMean), 0);
  const xSpread = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair.score - xMean) ** 2, 0));
  const ySpread = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair.return_pct - yMean) ** 2, 0));
  return xSpread && ySpread ? numerator / (xSpread * ySpread) : null;
};

const inputs = await Promise.all(inputFiles.map(readJson));
const observations = inputs.flatMap((payload, fileIndex) => (payload.companies || []).map((row) => {
  const dimensions = row.as_of_dimensions || {};
  const complete = coreDimensions.every((dimension) => Number.isFinite(Number(dimensions[dimension.id])));
  const score = complete
    ? coreDimensions.reduce((sum, dimension) => sum + Number(dimensions[dimension.id]) * weights[dimension.id], 0)
    : null;
  const returnPct = Number(row.outcome?.price_return_pct);
  return {
    backtest_file: inputFiles[fileIndex],
    period: `${row.as_of_date} to ${row.end_date}`,
    ticker: row.ticker,
    name: row.name,
    template: row.template_label,
    score: Number.isFinite(score) ? round(score) : null,
    band: Number.isFinite(score) ? bandFor(score).label : "資料不足",
    return_pct: Number.isFinite(returnPct) ? returnPct : null,
    dimensions
  };
}));

const usable = observations.filter((item) => Number.isFinite(item.score) && Number.isFinite(item.return_pct));
const allReturns = usable.map((item) => item.return_pct);
const byBand = Object.fromEntries(bands.map((band) => {
  const items = usable.filter((item) => item.band === band.label);
  const returns = items.map((item) => item.return_pct);
  return [band.id, {
    label: band.label,
    threshold: band.min,
    count: items.length,
    average_return_pct: round(average(returns)),
    median_return_pct: round(median(returns)),
    win_rate_pct: returns.length ? round((returns.filter((value) => value > 0).length / returns.length) * 100, 1) : null
  }];
}));
const scoreSorted = [...usable].sort((left, right) => right.score - left.score);
const quartileSize = Math.floor(scoreSorted.length / 4);
const topQuartile = scoreSorted.slice(0, quartileSize);
const bottomQuartile = scoreSorted.slice(-quartileSize);
const summary = {
  version: "1.0.0",
  generated_at: new Date().toISOString(),
  scope: "三個月、15 種產業模板、公司期別的核心分數壓力測試",
  source_files: inputFiles,
  direct_core_weights: weights,
  core_weight_sum: round(Object.values(weights).reduce((sum, weight) => sum + weight, 0), 4),
  observations: observations.length,
  usable_observations: usable.length,
  missing_return_observations: observations.length - usable.length,
  overall_average_return_pct: round(average(allReturns)),
  overall_median_return_pct: round(median(allReturns)),
  score_return_correlation: round(pearson(usable)),
  by_band: byBand,
  top_quartile: {
    count: topQuartile.length,
    average_score: round(average(topQuartile.map((item) => item.score))),
    average_return_pct: round(average(topQuartile.map((item) => item.return_pct))),
    win_rate_pct: round((topQuartile.filter((item) => item.return_pct > 0).length / topQuartile.length) * 100, 1)
  },
  bottom_quartile: {
    count: bottomQuartile.length,
    average_score: round(average(bottomQuartile.map((item) => item.score))),
    average_return_pct: round(average(bottomQuartile.map((item) => item.return_pct))),
    win_rate_pct: round((bottomQuartile.filter((item) => item.return_pct > 0).length / bottomQuartile.length) * 100, 1)
  },
  limitations: [
    "這是使用既有回測保存的六項維度快照重新加權的壓力測試，並非重新下載每一日原始資料。",
    "既有快照中的風險維度仍採當時的舊事件規則，不能單獨驗證新版事件嚴重度分類。",
    "部分財報、治理與產業資料未保存完整 point-in-time 原始快照；結果不應被視為投資績效歸因或買賣建議。"
  ]
};

const markdown = [
  "# 核心分數擴大回測",
  "",
  `- 觀測值：${summary.observations} 個公司期別；可用報酬：${summary.usable_observations} 筆。`,
  `- 核心權重合計：${summary.core_weight_sum * 100}%。`,
  `- 整體平均報酬：${summary.overall_average_return_pct ?? "NA"}%；中位數：${summary.overall_median_return_pct ?? "NA"}%。`,
  `- 分數與後續一個月報酬 Pearson 相關：${summary.score_return_correlation ?? "NA"}。`,
  "",
  "## 依分數區間",
  "",
  "| 區間 | 門檻 | 筆數 | 平均報酬 | 中位數 | 勝率 |",
  "|---|---:|---:|---:|---:|---:|",
  ...Object.values(byBand).map((item) => `| ${item.label} | ${item.threshold} | ${item.count} | ${item.average_return_pct ?? "NA"}% | ${item.median_return_pct ?? "NA"}% | ${item.win_rate_pct ?? "NA"}% |`),
  "",
  "## 四分位比較",
  "",
  `- 最高四分位：平均分數 ${summary.top_quartile.average_score}，平均報酬 ${summary.top_quartile.average_return_pct}% ，勝率 ${summary.top_quartile.win_rate_pct}%。`,
  `- 最低四分位：平均分數 ${summary.bottom_quartile.average_score}，平均報酬 ${summary.bottom_quartile.average_return_pct}% ，勝率 ${summary.bottom_quartile.win_rate_pct}%。`,
  "",
  "## 限制",
  "",
  ...summary.limitations.map((item) => `- ${item}`)
].join("\n");

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "core-portfolio-backtest.json"), `${JSON.stringify({ summary, observations: usable }, null, 2)}\n`, "utf8");
await writeFile(path.join(outDir, "core-portfolio-backtest.md"), `${markdown}\n`, "utf8");
console.log(JSON.stringify({ out: path.relative(root, outDir), usable_observations: usable.length, correlation: summary.score_return_correlation }, null, 2));
