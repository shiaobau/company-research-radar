(function () {
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[char]));
  }

  function getFact(company, fieldId) {
    return (company.facts && company.facts[fieldId]) || { value: "未填寫", source_ids: [] };
  }

  function formatFactValue(fact, definition) {
    const value = fact.value;
    if (Array.isArray(value)) return value.join("、");
    if (definition && definition.type === "percent" && typeof value === "number") return `${value}%`;
    if (definition && definition.type === "number" && typeof value === "number") return value.toLocaleString();
    return value ?? "未填寫";
  }

  function sourceLinks(sourceIds, sourceIndex) {
    if (!sourceIds || !sourceIds.length) return "";
    const chips = sourceIds
      .map((id) => sourceIndex[id])
      .filter(Boolean)
      .map((source) => {
        const title = source.short_title || source.title;
        const description = source.note || source.title;
        return `
          <span class="fact-source-tooltip" tabindex="0" role="note" aria-label="${escapeHtml(`${title}：${description}`)}">
            <span class="source-chip source-chip-static">${escapeHtml(title)}</span>
            <span class="fact-tooltip-content" role="tooltip">
              <strong>${escapeHtml(source.title)}</strong>
              <span>${escapeHtml(description)}</span>
            </span>
          </span>
        `;
      })
      .join("");
    return `<div class="source-links source-links-static">${chips}</div>`;
  }

  function renderFact(company, fieldId, definitions, sourceIndex) {
    const definition = definitions[fieldId] || { label: fieldId };
    const fact = getFact(company, fieldId);
    return `
      <div class="fact">
        <div class="fact-label">${escapeHtml(definition.label)}</div>
        <div class="fact-value">${escapeHtml(formatFactValue(fact, definition))}</div>
        ${fact.note ? `<div class="muted">${escapeHtml(fact.note)}</div>` : ""}
        ${sourceLinks(fact.source_ids, sourceIndex)}
      </div>
    `;
  }

  function renderScoreRows(score) {
    return score.rows.map((row) => `
      <div class="score-row" title="${escapeHtml(row.rationale)}">
        <span>${escapeHtml(row.label)}</span>
        <div class="bar" style="--bar-width:${Number.isFinite(row.score) ? row.score : 0}%"><span></span></div>
        <b>${Number.isFinite(row.score) ? row.score : "待補"}</b>
      </div>
    `).join("");
  }

  window.RadarRenderers = {
    escapeHtml,
    getFact,
    formatFactValue,
    sourceLinks,
    renderFact,
    renderScoreRows
  };
})();
