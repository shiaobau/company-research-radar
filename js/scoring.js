(function () {
  function scoreBand(score, rules) {
    const bands = rules?.score_bands || [
      { id: "priority", min: 75, label: "優先觀察", color: "#46b88a" },
      { id: "monitor", min: 55, label: "持續追蹤", color: "#d6a94b" },
      { id: "defer", min: 0, label: "訊號待確認", color: "#cf6a6a" }
    ];
    return bands.find((band) => score >= band.min) || bands[bands.length - 1];
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
    return Math.round(anchors[anchors.length - 1].display);
  }

  function dimensionsFor(company, rules) {
    if (rules.common_dimensions) return rules.common_dimensions;
    return rules.industries?.[company.industry_template]?.dimensions || [];
  }

  function objectiveInput(company, dimensionId, datasets) {
    const dataMap = {
      catalyst: datasets?.catalystData?.companies,
      revenueMomentum: datasets?.revenueData?.companies,
      cashProfitQuality: datasets?.financialData?.companies,
      priceTrend: datasets?.marketData?.companies,
      ownership: datasets?.ownershipData?.companies,
      riskNews: datasets?.riskData?.companies,
      industryFundamental: datasets?.industryData?.companies
    };
    const record = dataMap[dimensionId]?.[company.id];
    if (!record || record.status !== "ok" || !Number.isFinite(Number(record.score))) return null;
    return {
      score: Number(record.score),
      evidence_level: record.evidence_level || "high",
      rationale: record.rationale || "由公開客觀資料計算。",
      source_ids: record.source_ids || [],
      objective: true
    };
  }

  function missingDimensionLabel(dimension) {
    return dimension?.label || dimension?.id || "未命名維度";
  }

  function computeCompanyScore(company, rules, datasets = {}) {
    const dimensions = dimensionsFor(company, rules);
    if (!dimensions.length) return { total: null, complete: false, missingDimensions: ["評分規則"], band: { label: "資料不足" }, rows: [] };

    let weighted = 0;
    let weightSum = 0;
    const rows = dimensions.map((dimension) => {
      const input = objectiveInput(company, dimension.id, datasets);
      const available = Boolean(input);
      const score = available ? Number(input.score) : null;
      if (available) {
        weighted += score * dimension.weight;
        weightSum += dimension.weight;
      }
      return {
        id: dimension.id,
        label: dimension.label,
        weight: dimension.weight,
        score,
        status: available ? "ok" : "missing",
        rationale: input?.rationale || "尚未取得可計分的公開資料。",
        evidenceLevel: input?.evidence_level || "none",
        sourceIds: input?.source_ids || [],
        objective: Boolean(input?.objective)
      };
    });

    const missingDimensions = rows.filter((row) => row.status !== "ok").map(missingDimensionLabel);
    if (missingDimensions.length) {
      return {
        total: null,
        complete: false,
        missingDimensions,
        band: { label: "資料不足" },
        rows
      };
    }
    const rawTotal = weightSum ? Math.round(weighted / weightSum) : 0;
    const total = calibrateScore(rawTotal, rules);
    return { total, rawTotal, complete: true, missingDimensions: [], band: scoreBand(total, rules), rows };
  }

  window.RadarScoring = { computeCompanyScore, scoreBand, calibrateScore };
})();
