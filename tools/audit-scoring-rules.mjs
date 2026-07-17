import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const argValue = (name, fallback) => {
  const value = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return value ? value.slice(name.length + 3) : fallback;
};
const sourcePath = path.resolve(root, argValue("source", "backtests/2026-06-16_to_2026-07-16_15_templates_x10/backtest.json"));
const outDir = path.resolve(root, argValue("out", "backtests/2026-06-16_to_2026-07-16_negative_event_validation"));

const [rules, source] = await Promise.all([
  JSON.parse(await readFile(path.join(root, "data", "scoring_rules.json"), "utf8")),
  JSON.parse(await readFile(sourcePath, "utf8"))
]);

const coreDimensions = (rules.common_dimensions || []).filter((dimension) => dimension.role !== "adjustment");
const coreWeight = coreDimensions.reduce((sum, dimension) => sum + Number(dimension.weight || 0), 0);
const dimensionAudit = coreDimensions.map((dimension) => ({
  id: dimension.id,
  label: dimension.label,
  weight: Number(dimension.weight || 0),
  submetric_weight: (dimension.submetrics || []).reduce((sum, submetric) => sum + Number(submetric.weight || 0), 0),
  status: Math.abs((dimension.submetrics || []).reduce((sum, submetric) => sum + Number(submetric.weight || 0), 0) - 1) < 0.0001 ? "ok" : "review"
}));

const rows = source.companies || [];
const allReturns = rows.map((row) => Number(row.outcome?.price_return_pct)).filter(Number.isFinite);
const flaggedRows = rows.filter((row) => Number(row.outcome?.new_negative_event_count || 0) > 0 || Number(row.outcome?.disclosure_violation_count || 0) > 0);
const negativeRows = flaggedRows.filter((row) => Number(row.outcome?.new_negative_event_count || 0) > 0);
const violationRows = flaggedRows.filter((row) => Number(row.outcome?.disclosure_violation_count || 0) > 0);
const average = (values) => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : null;
const summarize = (items) => ({
  count: items.length,
  average_return_pct: average(items.map((row) => Number(row.outcome?.price_return_pct)).filter(Number.isFinite)),
  positive_return_count: items.filter((row) => Number(row.outcome?.price_return_pct) > 0).length,
  negative_return_count: items.filter((row) => Number(row.outcome?.price_return_pct) < 0).length,
  companies: items.map((row) => ({
    ticker: row.ticker,
    name: row.name,
    return_pct: row.outcome?.price_return_pct ?? null,
    legacy_negative_event_count: row.outcome?.new_negative_event_count || 0,
    disclosure_violation_count: row.outcome?.disclosure_violation_count || 0
  }))
});

const report = {
  version: "1.0.0",
  generated_at: new Date().toISOString(),
  source_backtest: path.relative(root, sourcePath),
  scope: "評分規則結構檢視與既有事件樣本壓力測試",
  core_score_audit: {
    direct_percent_scale: true,
    core_weight_sum: Number(coreWeight.toFixed(4)),
    status: Math.abs(coreWeight - 1) < 0.0001 ? "ok" : "review",
    dimensions: dimensionAudit
  },
  event_backtest: {
    period: { start: source.start_date, end: source.end_date },
    all_companies: {
      count: rows.length,
      average_return_pct: average(allReturns)
    },
    legacy_keyword_negative_events: summarize(negativeRows),
    disclosure_violations: summarize(violationRows),
    limitation: "既有回測未保存每則公告原文，且使用舊關鍵字規則；此結果只用來判定舊規則樣本不足，不能驗證新版事件分類的預測能力。"
  },
  decisions: [
    "六項核心權重合計為 100%，核心總分不再進行顯示放大。",
    "已移除以公告數量提高風險分數的設計，改以重大事件點數、申報違規與待閱讀公告分開計算。",
    "澄清、更正、補充及例行權利事件只列為待閱讀，不會直接產生負向事件點數。",
    "目前舊樣本中的負向事件與違規各只有 4 家，樣本不足以主張可預測後續股價；新版應持續累積含原文與事件後報酬的歷史快照。"
  ]
};

const markdown = [
  "# 評分規則與事件樣本檢視",
  "",
  `- 來源回測：\`${report.source_backtest}\``,
  `- 核心權重合計：${report.core_score_audit.core_weight_sum * 100}%`,
  "- 核心分數：直接 0-100 百分制，未使用展開或放大。",
  "",
  "## 結構檢查",
  "",
  "| 核心維度 | 權重 | 子測項權重 | 狀態 |",
  "|---|---:|---:|---|",
  ...dimensionAudit.map((item) => `| ${item.label} | ${(item.weight * 100).toFixed(0)}% | ${(item.submetric_weight * 100).toFixed(0)}% | ${item.status} |`),
  "",
  "## 舊規則樣本壓力測試",
  "",
  `- 全部 ${rows.length} 家平均報酬：${report.event_backtest.all_companies.average_return_pct ?? "NA"}%`,
  `- 舊關鍵字負向事件：${negativeRows.length} 家，平均報酬 ${report.event_backtest.legacy_keyword_negative_events.average_return_pct ?? "NA"}%，上漲 ${report.event_backtest.legacy_keyword_negative_events.positive_return_count} 家、下跌 ${report.event_backtest.legacy_keyword_negative_events.negative_return_count} 家。`,
  `- 申報違規：${violationRows.length} 家，平均報酬 ${report.event_backtest.disclosure_violations.average_return_pct ?? "NA"}%，上漲 ${report.event_backtest.disclosure_violations.positive_return_count} 家、下跌 ${report.event_backtest.disclosure_violations.negative_return_count} 家。`,
  "",
  "此樣本不足以驗證預測能力；它支持把舊的一律關鍵字扣分改為嚴重度與待閱讀分流。",
  "",
  "## 已採用的調整",
  "",
  ...report.decisions.map((item) => `- ${item}`)
].join("\n");

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "scoring-audit.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(path.join(outDir, "scoring-audit.md"), `${markdown}\n`, "utf8");
console.log(JSON.stringify({ out: path.relative(root, outDir), core_weight_sum: coreWeight, flagged_companies: flaggedRows.length }, null, 2));
