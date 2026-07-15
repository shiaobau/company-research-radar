(function () {
  function scoreBand(score, rules) {
    const bands = rules?.score_bands || [
      { min: 85, label: "高度研究名單" },
      { min: 75, label: "值得追蹤" },
      { min: 65, label: "觀察中" },
      { min: 0, label: "資料不足" }
    ];
    return bands.find((band) => score >= band.min) || bands[bands.length - 1];
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

  function computeCompanyScore(company, rules, datasets = {}) {
    const dimensions = dimensionsFor(company, rules);
    if (!dimensions.length) return { total: 0, band: scoreBand(0, rules), rows: [] };

    let weighted = 0;
    let weightSum = 0;
    const rows = dimensions.map((dimension) => {
      const input = objectiveInput(company, dimension.id, datasets) || company.score_inputs?.[dimension.id] || {};
      const score = Number(input.score || 0);
      weighted += score * dimension.weight;
      weightSum += dimension.weight;
      return {
        id: dimension.id,
        label: dimension.label,
        weight: dimension.weight,
        score,
        rationale: input.rationale || "尚未填寫評分理由",
        evidenceLevel: input.evidence_level || "unknown",
        sourceIds: input.source_ids || [],
        objective: Boolean(input.objective)
      };
    });

    const total = weightSum ? Math.round(weighted / weightSum) : 0;
    return { total, band: scoreBand(total, rules), rows };
  }

  window.RadarScoring = { computeCompanyScore, scoreBand };
})();
