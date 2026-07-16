import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function tierFor(score, scheme) {
  if (score >= scheme.priority_min) return "優先觀察";
  if (score >= scheme.monitor_min) return "持續追蹤";
  return "訊號待確認";
}

function calibrateScore(rawScore, rules) {
  const anchors = (rules?.score_calibration?.anchors || [])
    .map((anchor) => ({ raw: Number(anchor.raw), display: Number(anchor.display) }))
    .filter((anchor) => Number.isFinite(anchor.raw) && Number.isFinite(anchor.display))
    .sort((left, right) => left.raw - right.raw);
  if (!anchors.length) return Math.round(rawScore);
  if (rawScore <= anchors[0].raw) return Math.round(anchors[0].display);
  for (let index = 1; index < anchors.length; index += 1) {
    const lower = anchors[index - 1];
    const upper = anchors[index];
    if (rawScore <= upper.raw) {
      const progress = (rawScore - lower.raw) / (upper.raw - lower.raw);
      return Math.round(lower.display + (upper.display - lower.display) * progress);
    }
  }
  return Math.round(anchors.at(-1).display);
}

function tierMetrics(rows) {
  const returns = rows.map((row) => row.outcome.price_return_pct);
  return {
    sample_count: rows.length,
    average_as_of_score: round(average(rows.map((row) => row.as_of_score))),
    average_price_return_pct: round(average(returns)),
    median_price_return_pct: round(median(returns)),
    positive_return_rate: rows.length ? round(rows.filter((row) => row.outcome.price_return_pct >= 0).length / rows.length, 3) : null,
  };
}

function schemeAnalysis(rows, scheme) {
  const groups = Object.fromEntries(["優先觀察", "持續追蹤", "訊號待確認"].map((tier) => [tier, []]));
  rows.forEach((row) => groups[tierFor(row.as_of_score, scheme)].push(row));
  const tiers = Object.fromEntries(Object.entries(groups).map(([tier, items]) => [tier, tierMetrics(items)]));
  const priorityReturn = tiers.優先觀察.average_price_return_pct;
  const deferReturn = tiers.訊號待確認.average_price_return_pct;
  return {
    ...scheme,
    tiers,
    priority_minus_defer_return_pct: Number.isFinite(priorityReturn) && Number.isFinite(deferReturn)
      ? round(priorityReturn - deferReturn)
      : null
  };
}

function markdown(sources, rows, analyses) {
  const sourceLine = sources.map((source) => `${source.backtest_id}（${source.company_count} 家）`).join("、");
  const sections = analyses.map((analysis) => {
    const table = ["優先觀察", "持續追蹤", "訊號待確認"].map((tier) => {
      const metric = analysis.tiers[tier];
      return `| ${tier} | ${metric.sample_count} | ${metric.average_as_of_score ?? "NA"} | ${metric.average_price_return_pct ?? "NA"}% | ${metric.median_price_return_pct ?? "NA"}% | ${metric.positive_return_rate ?? "NA"} |`;
    }).join("\n");
    return [
      `## ${analysis.id}：優先 ${analysis.priority_min}+／持續 ${analysis.monitor_min}+`,
      "",
      "| 層級 | 樣本 | 起點均分 | 平均股價變化 | 中位數股價變化 | 正報酬比例 |",
      "|---|---:|---:|---:|---:|---:|",
      table,
      "",
      `優先觀察與訊號待確認的平均報酬差：${analysis.priority_minus_defer_return_pct ?? "NA"}%`
    ].join("\n");
  }).join("\n\n");
  return [
    "# 分數門檻校準報告",
    "",
    `回測來源：${sourceLine}`,
    `可比較樣本：${rows.length} 家。僅納入資料覆蓋率至少 0.55、起點分數與後續股價皆可得的公司。`,
    "",
    "此報告比較研究優先序對後續一個月資料的排序能力，不能視為個人化投資建議或保證報酬。",
    "",
    sections,
    "",
    "## 使用原則",
    "",
    "- 優先觀察應同時具備足夠樣本，且平均與中位數結果不劣於其餘層級。",
    "- 若層級間結果沒有明顯差異，應維持保守門檻，並優先改善維度資料與權重，而不是只下調門檻。",
    "- 財報、治理與部分產業資料尚未完整保存 point-in-time 快照，因此結果是校準壓力測試，不是嚴格績效歸因。"
  ].join("\n");
}

async function main() {
  const ids = argValue("backtests", "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!ids.length) throw new Error("Use --backtests=<backtest-id>[,<backtest-id>].");
  const scoringRules = JSON.parse(await readFile(path.join(root, "data", "scoring_rules.json"), "utf8"));
  if ((scoringRules.common_dimensions || []).some((dimension) => dimension.submetrics?.length)) {
    throw new Error("The current granular score model requires a point-in-time submetric data pack. Do not calibrate it with legacy seven-dimension backtests.");
  }
  const sources = [];
  const rows = [];
  for (const id of ids) {
    const file = path.join(root, "backtests", id, "backtest.json");
    const payload = JSON.parse(await readFile(file, "utf8"));
    const eligible = (payload.companies || []).filter((row) => (
      Number.isFinite(row.as_of_raw_score ?? row.as_of_score)
      && Number.isFinite(row.outcome?.price_return_pct)
      && Number(row.data_coverage_score) >= 0.55
    ));
    sources.push({ backtest_id: id, company_count: eligible.length });
    rows.push(...eligible.map((row) => {
      const rawScore = Number(row.as_of_raw_score ?? row.as_of_score);
      return {
        ...row,
        backtest_id: id,
        as_of_raw_score: rawScore,
        as_of_score: calibrateScore(rawScore, scoringRules)
      };
    }));
  }

  const activeBands = [...(scoringRules.score_bands || [])].sort((left, right) => right.min - left.min);
  const activePriority = Number(activeBands[0]?.min ?? 75);
  const activeMonitor = Number(activeBands[1]?.min ?? 55);
  const schemes = [
    { id: `current_${activePriority}_${activeMonitor}`, priority_min: activePriority, monitor_min: activeMonitor },
    { id: "candidate_80_60", priority_min: 80, monitor_min: 60 },
    { id: "candidate_70_50", priority_min: 70, monitor_min: 50 }
  ].filter((scheme, index, all) => all.findIndex((item) => (
    item.priority_min === scheme.priority_min && item.monitor_min === scheme.monitor_min
  )) === index);
  const analyses = schemes.map((scheme) => schemeAnalysis(rows, scheme));
  const outId = argValue("out", ids[0]);
  const outDir = path.join(root, "backtests", outId);
  const result = {
    version: "0.2.0",
    generated_at: new Date().toISOString(),
    sources,
    eligible_company_count: rows.length,
    analyses
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "calibration.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(path.join(outDir, "calibration.md"), `${markdown(sources, rows, analyses)}\n`, "utf8");
  console.log(JSON.stringify({ out: path.relative(root, outDir), eligible_company_count: rows.length, analyses }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
