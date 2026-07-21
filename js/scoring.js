(function () {
  const sourceMaps = {
    catalyst: "catalystData",
    revenue: "revenueData",
    financial: "financialData",
    market: "marketData",
    ownership: "ownershipData",
    risk: "riskData",
    industry: "industryData",
    industryEvidence: "industryEvidenceData"
  };

  function clamp(score) {
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  function scoreBand(score, rules) {
    const bands = rules?.score_bands || [
      { id: "priority", min: 75, label: "優先觀察", color: "#46b88a" },
      { id: "monitor", min: 60, label: "持續追蹤", color: "#d6a94b" },
      { id: "defer", min: 0, label: "訊號待確認", color: "#cf6a6a" }
    ];
    return [...bands].sort((left, right) => right.min - left.min).find((band) => score >= band.min) || bands[bands.length - 1];
  }

  function dimensionsFor(company, rules) {
    if (rules.common_dimensions) {
      const overrides = rules.industry_overrides?.[company.industry_template] || {};
      return rules.common_dimensions.map((dimension) => (
        overrides[dimension.id]
          ? { ...dimension, ...overrides[dimension.id], id: dimension.id }
          : dimension
      ));
    }
    return rules.industries?.[company.industry_template]?.dimensions || [];
  }

  function recordFor(company, source, datasets) {
    const dataset = datasets?.[sourceMaps[source]];
    const record = dataset?.companies?.[company.id];
    return record?.status === "ok" ? record : null;
  }

  function numberAt(record, field) {
    const value = String(field || "").split(".").reduce((result, key) => result?.[key], record);
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    return null;
  }

  function thresholdScore(value, definition) {
    const bands = definition.bands || [];
    if (definition.direction === "lower") {
      const match = [...bands].sort((left, right) => left.max - right.max).find((band) => value <= Number(band.max));
      return match ? Number(match.score) : null;
    }
    const match = [...bands].sort((left, right) => right.min - left.min).find((band) => value >= Number(band.min));
    return match ? Number(match.score) : null;
  }

  function thresholdBand(value, definition) {
    const bands = definition.bands || [];
    return definition.direction === "lower"
      ? [...bands].sort((left, right) => left.max - right.max).find((band) => value <= Number(band.max))
      : [...bands].sort((left, right) => right.min - left.min).find((band) => value >= Number(band.min));
  }

  function displayValue(value, field = "") {
    if (!Number.isFinite(value)) return "未提供";
    const rounded = Math.round(value * 100) / 100;
    if (field.endsWith("_pct")) return `${rounded}%`;
    return String(rounded);
  }

  function sourceLabel(source) {
    return {
      catalyst: "事件",
      revenue: "營收",
      financial: "財務",
      market: "股價",
      ownership: "股權",
      risk: "風險",
      industry: "產業",
      industryEvidence: "產業證據"
    }[source] || source;
  }

  function weightedInputs(definition, company, datasets) {
    const values = (definition.inputs || []).map((input) => {
      const record = recordFor(company, input.source, datasets);
      const value = record ? numberAt(record, input.field) : null;
      return { value, weight: Number(input.weight), record };
    });
    if (values.some((item) => !Number.isFinite(item.value) || !Number.isFinite(item.weight))) return null;
    const weightSum = values.reduce((sum, item) => sum + item.weight, 0);
    if (!weightSum) return null;
    return {
      score: values.reduce((sum, item) => sum + item.value * item.weight, 0) / weightSum,
      sourceIds: [...new Set(values.flatMap((item) => item.record.source_ids || []))],
      inputs: values
    };
  }

  function evaluateSingle(definition, company, datasets) {
    const record = recordFor(company, definition.source, datasets);
    if (definition.formula === "weighted_average") {
      const result = weightedInputs(definition, company, datasets);
      return {
        ...definition,
        score: result ? clamp(result.score) : null,
        status: result ? "ok" : "missing",
        rationale: result
          ? `${result.inputs.map((item, index) => `${sourceLabel(definition.inputs[index].source)} ${displayValue(item.value, definition.inputs[index].field)} 分 × ${Math.round(item.weight * 100)}%`).join("；")}；加權後 ${clamp(result.score)} 分。`
          : "尚未取得所有必要的公開資料。",
        sourceIds: result?.sourceIds || []
      };
    }
    if (!record) {
      return { ...definition, score: null, status: "missing", rationale: "尚未取得必要的公開資料。", sourceIds: [] };
    }

    if (definition.formula === "event_balance") {
      const positive = numberAt(record, definition.positive_field) || 0;
      const negative = numberAt(record, definition.negative_field) || 0;
      const score = clamp(Number(definition.base || 0) + positive * Number(definition.positive_weight || 0) - negative * Number(definition.negative_weight || 0));
      return {
        ...definition,
        score: Math.max(Number(definition.min_score ?? 0), Math.min(Number(definition.max_score ?? 100), score)),
        status: "ok",
        rationale: `正向事件 ${positive} 件；負向事件 ${negative} 件。`,
        sourceIds: record.source_ids || []
      };
    }

    const value = numberAt(record, definition.field);
    if (!Number.isFinite(value)) {
      return { ...definition, score: null, status: "missing", rationale: "公開資料未提供此測項數值。", sourceIds: record.source_ids || [] };
    }
    const score = definition.formula === "threshold" ? thresholdScore(value, definition) : value;
    const band = definition.formula === "threshold" ? thresholdBand(value, definition) : null;
    const threshold = band
      ? definition.direction === "lower" ? `不高於 ${band.max}` : `不低於 ${band.min}`
      : "目前門檻";
    return {
      ...definition,
      score: Number.isFinite(score) ? clamp(score) : null,
      status: Number.isFinite(score) ? "ok" : "missing",
      rationale: Number.isFinite(score)
        ? definition.formula === "threshold"
          ? `公開數值 ${displayValue(value, definition.field)}；符合 ${threshold} 的區間，換算 ${clamp(score)} 分。`
          : `公開評分 ${displayValue(value, definition.field)} 分。`
        : "公開數值不符合目前的計分規則。",
      sourceIds: record.source_ids || []
    };
  }

  function evaluateSubmetrics(dimension, company, datasets) {
    return (dimension.submetrics || []).flatMap((definition) => {
      if (definition.formula !== "dimension_collection") return [evaluateSingle(definition, company, datasets)];
      const dataset = datasets?.[sourceMaps[definition.source]];
      const rawRecord = dataset?.companies?.[company.id];
      const record = rawRecord?.status === "ok" ? rawRecord : null;
      const dimensions = record?.[definition.field];
      const pendingDimensions = rawRecord?.[definition.field];
      if (!Array.isArray(dimensions) && Array.isArray(pendingDimensions) && pendingDimensions.length) {
        return pendingDimensions.map((item) => ({
          id: item.id,
          label: item.label,
          weight: Number(definition.weight) * Number(item.weight || 0),
          score: null,
          status: "missing",
          rationale: item.rationale || "尚未取得來源支持的產業子檢核資料。",
          sourceIds: item.source_ids || []
        }));
      }
      if (!Array.isArray(dimensions) || !dimensions.length) {
        return [{ ...definition, score: null, status: "missing", rationale: "尚未取得產業子檢核資料。", sourceIds: record?.source_ids || [] }];
      }
      return dimensions.map((item) => {
        const rationale = item.rationale || item.description || "產業子檢核。";
        const placeholder = /模板已建立|尚未填入|仍需逐品項|暫代檢查|待自動比對/.test(rationale);
        const sourceBacked = item.status === "ok" && Number.isFinite(Number(item.score)) && !placeholder;
        return {
          id: item.id,
          label: item.label,
          weight: Number(definition.weight) * Number(item.weight || 0),
          score: sourceBacked ? clamp(Number(item.score)) : null,
          status: sourceBacked ? "ok" : "missing",
          rationale,
          sourceIds: item.source_ids || record.source_ids || []
        };
      });
    });
  }

  function legacyDimension(dimension, company, datasets) {
    const sourceByDimension = {
      catalyst: "catalyst",
      revenueMomentum: "revenue",
      cashProfitQuality: "financial",
      priceTrend: "market",
      ownership: "ownership",
      riskNews: "risk",
      industryFundamental: "industry"
    };
    return evaluateSingle({ id: dimension.id, label: dimension.label, weight: 1, formula: "direct", source: sourceByDimension[dimension.id], field: "score" }, company, datasets);
  }

  function evaluateDimension(dimension, company, datasets) {
    const submetrics = dimension.submetrics?.length
      ? evaluateSubmetrics(dimension, company, datasets)
      : [legacyDimension(dimension, company, datasets)];
    const missing = submetrics.filter((item) => item.status !== "ok");
    const weightSum = submetrics.reduce((sum, item) => sum + (Number(item.weight) || 0), 0);
    const score = missing.length || !weightSum
      ? null
      : clamp(submetrics.reduce((sum, item) => sum + item.score * Number(item.weight), 0) / weightSum);
    return {
      id: dimension.id,
      label: dimension.label,
      weight: dimension.weight,
      score,
      status: Number.isFinite(score) ? "ok" : "missing",
      rationale: Number.isFinite(score)
        ? `加權結果 ${score} 分；可展開查看各子測項的公開數值與門檻換算。`
        : `尚缺 ${missing.map((item) => item.label).join("、")}。`,
      evidenceLevel: Number.isFinite(score) ? "high" : "none",
      sourceIds: [...new Set(submetrics.flatMap((item) => item.sourceIds || []))],
      objective: true,
      submetrics
    };
  }

  function computeCompanyScore(company, rules, datasets = {}) {
    const dimensions = dimensionsFor(company, rules);
    if (!dimensions.length) return { total: null, rawTotal: null, complete: false, missingDimensions: ["評分規則"], band: { label: "資料不足" }, rows: [] };
    const rows = dimensions.map((dimension) => evaluateDimension(dimension, company, datasets));
    const adjustmentRow = rows.find((row) => row.id === "industryFundamental");
    const adjustmentDefinition = dimensions.find((dimension) => dimension.id === "industryFundamental");
    const coreRows = rows.filter((row) => row.id !== "industryFundamental");
    const coreMissingDimensions = coreRows.filter((row) => row.status !== "ok").map((row) => row.label);
    const missingDimensions = rows.filter((row) => row.status !== "ok").map((row) => row.label);
    if (coreMissingDimensions.length) {
      return { total: null, rawTotal: null, complete: false, missingDimensions, coreMissingDimensions, band: { label: "資料不足" }, rows };
    }
    const weightSum = coreRows.reduce((sum, row) => sum + Number(row.weight), 0);
    const rawCoreTotal = clamp(coreRows.reduce((sum, row) => sum + row.score * Number(row.weight), 0) / weightSum);
    const coreTotal = rawCoreTotal;
    const industryRecord = recordFor(company, "industryEvidence", datasets);
    const industryDirection = adjustmentRow?.status === "ok"
      ? String(industryRecord?.direction || "neutral")
      : "pending";
    const adjustmentBand = (adjustmentDefinition?.adjustment?.bands || [])
      .find((band) => band.direction === industryDirection);
    const industryAdjustment = adjustmentBand
      ? Number(adjustmentBand.points || 0)
      : Number(adjustmentDefinition?.adjustment?.pending_points || 0);
    const total = clamp(coreTotal + industryAdjustment);
    const industryEvidencePending = adjustmentRow?.status !== "ok";
    return {
      total,
      rawTotal: rawCoreTotal,
      rawCoreTotal,
      coreTotal,
      industryAdjustment,
      industryAdjustmentLabel: adjustmentBand?.label || "產業證據待補",
      complete: true,
      isProvisional: industryEvidencePending,
      missingDimensions: industryEvidencePending ? ["產業證據調整"] : [],
      coreMissingDimensions: [],
      band: scoreBand(total, rules),
      rows
    };
  }

  window.RadarScoring = { computeCompanyScore, dimensionsFor, scoreBand };
})();
