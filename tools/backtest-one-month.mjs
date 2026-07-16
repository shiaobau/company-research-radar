import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  average,
  clamp,
  fetchJson,
  monthStarts,
  readJson,
  rocDateToIso,
  round,
  scoreByThresholds,
  toNumber,
  tpexDateParam,
  twDateParam,
  writeJson
} from "./data-sources.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);
const startDate = args.start || "2026-06-07";
const endDate = args.end || "2026-07-07";
const selectedIndustry = args.industry || null;
const backtestId = args["backtest-id"] || [
  `${startDate}_to_${endDate}`,
  selectedIndustry
].filter(Boolean).join("_");
const outDir = path.join(root, "backtests", backtestId);
const generatedAt = new Date().toISOString();

const companiesJson = await readJson(path.join(dataDir, "companies.json"));
const templatesJson = await readJson(path.join(dataDir, "industry_templates.json"));
const rules = await readJson(path.join(dataDir, "scoring_rules.json"));
const marketData = await readJson(path.join(dataDir, "market_data.json"));
const revenueData = await readJson(path.join(dataDir, "revenue_data.json"));
const financialData = await readJson(path.join(dataDir, "financial_data.json"));
const catalystData = await readJson(path.join(dataDir, "catalyst_data.json"));
const ownershipData = await readJson(path.join(dataDir, "ownership_data.json"));
const riskData = await readJson(path.join(dataDir, "risk_data.json"));
const industryData = await readJson(path.join(dataDir, "industry_data.json"));

const companies = (companiesJson.companies || []).filter((company) => {
  return !selectedIndustry || company.industry_template === selectedIndustry;
});
const industryLabel = selectedIndustry
  ? templatesJson.industries?.[selectedIndustry]?.label || selectedIndustry
  : "全部產業";
const backtestEnd = new Date(`${endDate}T00:00:00Z`);
const priceMonths = monthStarts(backtestEnd, 14);

function pricePositionScore(positionPct) {
  if (!Number.isFinite(positionPct)) return 50;
  if (positionPct <= 15) return 45;
  if (positionPct <= 35) return 60;
  if (positionPct <= 70) return 72;
  if (positionPct <= 90) return 65;
  return 55;
}

function return20Score(value) {
  return scoreByThresholds(value, [[10, 78], [3, 68], [0, 60], [-5, 52], [-999, 42]], 50);
}

function return60Score(value) {
  return scoreByThresholds(value, [[20, 80], [5, 70], [0, 60], [-10, 50], [-999, 38]], 50);
}

function scoreBand(score) {
  const bands = rules.score_bands || [];
  return bands.find((band) => score >= band.min)?.label || "未分級";
}

function computeTotal(scores) {
  const dimensions = rules.common_dimensions || [];
  const weighted = dimensions.reduce((sum, dimension) => {
    return sum + (Number(scores[dimension.id]) || 0) * dimension.weight;
  }, 0);
  const weightSum = dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  return weightSum ? Math.round(weighted / weightSum) : 0;
}

function currentDimensionScores(company) {
  return {
    catalyst: catalystData.companies?.[company.id]?.score ?? company.score_inputs?.catalyst?.score ?? 0,
    revenueMomentum: revenueData.companies?.[company.id]?.score ?? company.score_inputs?.revenueMomentum?.score ?? 0,
    cashProfitQuality: financialData.companies?.[company.id]?.score ?? company.score_inputs?.cashProfitQuality?.score ?? 0,
    priceTrend: marketData.companies?.[company.id]?.score ?? company.score_inputs?.priceTrend?.score ?? 0,
    ownership: ownershipData.companies?.[company.id]?.score ?? company.score_inputs?.ownership?.score ?? 0,
    riskNews: riskData.companies?.[company.id]?.score ?? company.score_inputs?.riskNews?.score ?? 0,
    industryFundamental: industryData.companies?.[company.id]?.score ?? company.score_inputs?.industryFundamental?.score ?? 0
  };
}

function asOfDimensionScores(company, priceScore) {
  return {
    catalyst: company.score_inputs?.catalyst?.score ?? 50,
    revenueMomentum: company.score_inputs?.revenueMomentum?.score ?? 50,
    cashProfitQuality: financialData.companies?.[company.id]?.score ?? company.score_inputs?.cashProfitQuality?.score ?? 50,
    priceTrend: priceScore ?? company.score_inputs?.priceTrend?.score ?? 50,
    ownership: company.score_inputs?.ownership?.score ?? 50,
    riskNews: company.score_inputs?.riskNews?.score ?? 50,
    industryFundamental: company.score_inputs?.industryFundamental?.score ?? 50
  };
}

async function fetchPriceHistory(company) {
  const rows = [];
  const errors = [];
  for (const month of priceMonths) {
    try {
      if (company.market === "TWSE") {
        const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${twDateParam(month)}&stockNo=${company.ticker}&response=json`;
        const payload = await fetchJson(url);
        if (payload.stat === "OK" && Array.isArray(payload.data)) {
          for (const item of payload.data) {
            rows.push({
              date: rocDateToIso(item[0]),
              close: toNumber(item[6]),
              volume: toNumber(item[1]),
              source_id: "twse_stock_day"
            });
          }
        }
      } else {
        const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${company.ticker}&date=${encodeURIComponent(tpexDateParam(month))}&id=&response=json`;
        const payload = await fetchJson(url);
        const table = payload.tables?.[0];
        if (payload.stat === "ok" && Array.isArray(table?.data)) {
          for (const item of table.data) {
            rows.push({
              date: rocDateToIso(item[0]),
              close: toNumber(item[6]),
              volume: toNumber(item[1]) ? toNumber(item[1]) * 1000 : null,
              source_id: "tpex_trading_stock"
            });
          }
        }
      }
    } catch (error) {
      errors.push(`${month.toISOString().slice(0, 7)}: ${error.message}`);
    }
  }

  const byDate = new Map();
  for (const row of rows) {
    if (row.date && Number.isFinite(row.close)) byDate.set(row.date, row);
  }
  return {
    history: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    errors
  };
}

function scorePriceAt(history, cutoffDate) {
  const filtered = history.filter((row) => row.date <= cutoffDate);
  const closes = filtered.map((row) => row.close);
  const latest = filtered.at(-1);
  if (!latest) return null;

  const yearHigh = Math.max(...closes);
  const yearLow = Math.min(...closes);
  const extremeRange = yearHigh && yearLow ? yearHigh / yearLow > 4 : false;
  const rangeHistory = extremeRange ? filtered.slice(-60) : filtered;
  const rangeCloses = rangeHistory.map((row) => row.close);
  const scoringHigh = Math.max(...rangeCloses);
  const scoringLow = Math.min(...rangeCloses);
  const positionPct = scoringHigh !== scoringLow ? ((latest.close - scoringLow) / (scoringHigh - scoringLow)) * 100 : null;
  const close20 = closes.length > 20 ? closes.at(-21) : null;
  const close60 = closes.length > 60 ? closes.at(-61) : null;
  const return20d = close20 ? ((latest.close / close20) - 1) * 100 : null;
  const return60d = close60 ? ((latest.close / close60) - 1) * 100 : null;
  const score = Math.round(
    pricePositionScore(positionPct) * 0.4 +
    return20Score(return20d) * 0.3 +
    return60Score(return60d) * 0.3
  );

  return {
    trade_date: latest.date,
    close: latest.close,
    score: clamp(score),
    year_high: yearHigh,
    year_low: yearLow,
    scoring_high: scoringHigh,
    scoring_low: scoringLow,
    position_pct: round(positionPct),
    ma20: round(average(closes.slice(-20))),
    ma60: round(average(closes.slice(-60))),
    return_20d_pct: round(return20d),
    return_60d_pct: round(return60d),
    price_range_basis: extremeRange ? "近 60 個交易日區間；一年高低價比例過大，可能受面額、除權息或未調整價格影響。" : "近一年交易區間"
  };
}

function classifyBacktest({ startScore, scoreChange, priceReturnPct, revenueScore, riskScore }) {
  const positiveDevelopment = priceReturnPct >= 5 || scoreChange >= 4 || revenueScore >= 65;
  const negativeDevelopment = priceReturnPct <= -5 || scoreChange <= -4 || riskScore < 65;

  if (startScore >= 75) {
    if (positiveDevelopment && !negativeDevelopment) return "符合";
    if (!negativeDevelopment) return "部分符合";
    return "不符合";
  }
  if (startScore >= 65) {
    if (positiveDevelopment && !negativeDevelopment) return "符合";
    if (negativeDevelopment && !positiveDevelopment) return "不符合";
    return "部分符合";
  }
  if (startScore < 65) {
    if (positiveDevelopment && !negativeDevelopment) return "不符合";
    if (positiveDevelopment && negativeDevelopment) return "部分符合";
    return "符合";
  }
  return "部分符合";
}

function formatPct(value) {
  return Number.isFinite(value) ? `${round(value)}%` : "NA";
}

function markdownTable(rows) {
  const header = "| 公司 | 6/7 估計分數 | 7/7 分數 | 變化 | 股價表現 | 營收分數 | 判定 |\n|---|---:|---:|---:|---:|---:|---|";
  const body = rows.map((row) => {
    return `| ${row.name} | ${row.as_of_score} | ${row.current_score} | ${row.score_change >= 0 ? "+" : ""}${row.score_change} | ${formatPct(row.outcome.price_return_pct)} | ${row.current_dimensions.revenueMomentum} | ${row.consistency} |`;
  }).join("\n");
  return `${header}\n${body}`;
}

function companyNotes(row) {
  const notes = [
    `- ${row.name}：6/7 估計 ${row.as_of_score}（${row.as_of_band}），7/7 為 ${row.current_score}（${row.current_band}），股價 ${formatPct(row.outcome.price_return_pct)}。`,
    `  - 6/7 股價分數 ${row.as_of_dimensions.priceTrend}，7/7 股價分數 ${row.current_dimensions.priceTrend}。`,
    `  - 最新可見月營收分數 ${row.current_dimensions.revenueMomentum}；資料月份 ${row.outcome.revenue_month || "NA"}。`,
    `  - 判定：${row.consistency}。${row.consistency_reason}`
  ];
  return notes.join("\n");
}

function reportInterpretation(rows) {
  const matched = rows.filter((row) => row.consistency === "符合").length;
  const partial = rows.filter((row) => row.consistency === "部分符合").length;
  const missed = rows.filter((row) => row.consistency === "不符合").length;
  const exceptionNames = rows.filter((row) => row.consistency === "不符合").map((row) => row.name).join("、") || "無";
  const positiveNames = rows
    .filter((row) => row.current_dimensions.revenueMomentum >= 65 || row.score_change >= 4)
    .map((row) => row.name)
    .join("、") || "無";

  return [
    `這次旁路回測有 ${matched}/${rows.length} 家方向大致符合評分期待，${partial}/${rows.length} 家部分符合，${missed}/${rows.length} 家不符合。`,
    `主要反例是 ${exceptionNames}，代表這套模型需要回頭檢查該類公司短期營收、股價趨勢或產業權重是否低估了轉弱訊號。`,
    `正向樣本是 ${positiveNames}；若正向主要來自營收而不是股價，表示目前模型比較像「基本面改善偵測器」，還不是「短期股價預測器」。`
  ].join("");
}

function reportRecommendations(industry) {
  if (industry === "semiconductor") {
    return [
      "- 半導體公司要把「營收動能」和「股價趨勢」一起看；景氣上行時兩者同步轉強比較有說服力。",
      "- 成熟製程、封測、材料的評分不能直接套用先進製程龍頭邏輯，庫存週期與毛利韌性應該加重。",
      "- 若公司總分不低但營收分數低於 55，應標為週期疑慮，避免被產業地位分數掩蓋。",
      "- 這次半導體樣本只有 5 家、一個月，適合用來檢查方向，不適合視為統計回測。"
    ];
  }
  if (industry === "nutrition_health_food") {
    return [
      "- 65 分上下的「觀察中」門檻偏寬，若要接近投資篩選，至少應要求營收動能或股價趨勢其中一項不能低於 55。",
      "- ODM/製造型保健食品公司需要提高「月營收轉弱」的扣分權重，避免起始分數仍在觀察級但後續發展偏弱。",
      "- 低分公司後續偏弱的辨識能力目前看起來較好，但樣本只有 5 家、一個月，不能視為統計結論。",
      "- 若正向主要來自營收而非股價，模型應定位為基本面改善偵測器，而不是短期股價預測器。"
    ];
  }
  return [
    "- 65 分上下的「觀察中」門檻偏寬，若要接近投資篩選，至少應要求營收動能或股價趨勢其中一項不能低於 55。",
    "- 不同產業需要各自檢查權重，避免產業地位分數掩蓋短期營運轉弱。",
    "- 樣本數與期間仍太短，這版只能檢查方向，不能視為統計回測。"
  ];
}

async function build() {
  if (!companies.length) {
    throw new Error(`No companies found for industry: ${selectedIndustry || "all"}`);
  }
  await mkdir(outDir, { recursive: true });
  const rows = [];
  const warnings = [
    "此回測為旁路輸出，不覆蓋主站 data/*.json。",
    "6/7 as-of 分數避免使用 6/7 後才揭露的月營收與產業證據重算值；無法嚴格重建的維度使用 data/companies.json 內的原始研究初評或當時可合理取得的財務資料。",
    "目前重大訊息與 TFDA 品項級歷史尚未完整建立區間資料，因此判定以股價、最新月營收與總分變化為主。"
  ];

  for (const company of companies) {
    const priceFetch = await fetchPriceHistory(company);
    const startPrice = scorePriceAt(priceFetch.history, startDate);
    const endPrice = scorePriceAt(priceFetch.history, endDate);
    const asOfDimensions = asOfDimensionScores(company, startPrice?.score);
    const currentDimensions = currentDimensionScores(company);
    const asOfScore = computeTotal(asOfDimensions);
    const currentScore = computeTotal(currentDimensions);
    const priceReturnPct = startPrice && endPrice ? ((endPrice.close / startPrice.close) - 1) * 100 : null;
    const scoreChange = currentScore - asOfScore;
    const consistency = classifyBacktest({
      startScore: asOfScore,
      scoreChange,
      priceReturnPct,
      revenueScore: currentDimensions.revenueMomentum,
      riskScore: currentDimensions.riskNews
    });
    const consistencyReason = [
      asOfScore >= 65 ? "起始分數屬觀察級以上" : "起始分數未達觀察級",
      Number.isFinite(priceReturnPct) ? `一個月股價 ${formatPct(priceReturnPct)}` : "股價資料不足",
      `總分變化 ${scoreChange >= 0 ? "+" : ""}${scoreChange}`,
      `最新營收分數 ${currentDimensions.revenueMomentum}`
    ].join("；");

    rows.push({
      company_id: company.id,
      ticker: company.ticker,
      market: company.market,
      name: company.name,
      as_of_date: startDate,
      end_date: endDate,
      as_of_score: asOfScore,
      as_of_band: scoreBand(asOfScore),
      current_score: currentScore,
      current_band: scoreBand(currentScore),
      score_change: scoreChange,
      as_of_dimensions: asOfDimensions,
      current_dimensions: currentDimensions,
      outcome: {
        start_trade_date: startPrice?.trade_date || null,
        start_close: startPrice?.close ?? null,
        end_trade_date: endPrice?.trade_date || null,
        end_close: endPrice?.close ?? null,
        price_return_pct: round(priceReturnPct),
        revenue_month: revenueData.companies?.[company.id]?.data_month || null,
        revenue_yoy_pct: revenueData.companies?.[company.id]?.yoy_pct ?? null,
        revenue_mom_pct: revenueData.companies?.[company.id]?.mom_pct ?? null,
        risk_score: currentDimensions.riskNews,
        catalyst_score: currentDimensions.catalyst
      },
      price_as_of: startPrice,
      price_end: endPrice,
      consistency,
      consistency_reason: consistencyReason,
      warnings: priceFetch.errors
    });
  }

  const result = {
    version: "0.1.0",
    generated_at: generatedAt,
    backtest_id: backtestId,
    start_date: startDate,
    end_date: endDate,
    industry_template: selectedIndustry,
    industry_label: industryLabel,
    method: `旁路一個月回測：以 ${startDate} 可合理取得資訊估計起始分數，再與 ${endDate} 目前客觀資料、股價表現與最新月營收比對。`,
    warnings,
    companies: rows
  };

  await writeJson(path.join(outDir, "backtest.json"), result);

  const summary = [
    `# 一個月旁路回測：${startDate} 到 ${endDate}`,
    "",
    `產業範圍：${industryLabel}`,
    "",
    "## 結論摘要",
    "",
    reportInterpretation(rows),
    "",
    markdownTable(rows),
    "",
    "## 方法與限制",
    "",
    ...warnings.map((warning) => `- ${warning}`),
    "",
    "這版判定不是投資績效驗證，只是檢查評分和下一個月公開發展是否方向一致。若要做嚴格回測，下一步需要保存每日/每月 as-of 快照，並補齊區間重大訊息、TFDA 裁罰與完整歷史月營收。",
    "",
    "## 對評分標準的初步修正方向",
    "",
    ...reportRecommendations(selectedIndustry),
    "",
    "## 公司逐項觀察",
    "",
    rows.map(companyNotes).join("\n\n")
  ].join("\n");

  await writeFile(path.join(outDir, "report.md"), `${summary}\n`, "utf8");
  console.log(`Generated backtest at ${path.relative(root, outDir)}`);
}

await build();
