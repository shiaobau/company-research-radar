const state = {
  universe: null,
  companies: [],
  visibleCompanies: [],
  selected: new Set(JSON.parse(localStorage.getItem("researchUniverseSelectedTickers") || "[]")),
  filters: {
    search: "",
    template: "all",
    market: "all"
  }
};

const RESEARCH_SESSION_KEY = "researchUniversePendingFlow";

const els = {
  searchInput: document.querySelector("#search-input"),
  templateFilter: document.querySelector("#template-filter"),
  marketFilter: document.querySelector("#market-filter"),
  clearButton: document.querySelector("#clear-button"),
  saveSeedButton: document.querySelector("#save-seed-button"),
  startResearchButton: document.querySelector("#start-research-button"),
  copyStatus: document.querySelector("#copy-status"),
  totalCount: document.querySelector("#total-count"),
  visibleCount: document.querySelector("#visible-count"),
  selectedCount: document.querySelector("#selected-count"),
  generatedAt: document.querySelector("#generated-at"),
  selectedList: document.querySelector("#selected-list"),
  sections: document.querySelector("#template-sections")
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function saveSelection() {
  localStorage.setItem("researchUniverseSelectedTickers", JSON.stringify([...state.selected].sort()));
}

function selectedTickers() {
  return [...state.selected].sort((a, b) => a.localeCompare(b, "zh-Hant-TW"));
}

function selectedCompaniesForSeed() {
  return selectedTickers()
    .map((ticker) => state.companies.find((company) => company.ticker === ticker))
    .filter(Boolean)
    .map((company) => ({
      ticker: company.ticker,
      name: company.name,
      abbreviation: company.abbreviation,
      market: company.market,
      market_label: company.market_label,
      official_industry_code: company.official_industry_code,
      official_industry_label: company.official_industry_label,
      industry_template: company.industry_template,
      template_label: company.template_label,
      match_reason: company.match_reason
    }));
}

function formatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function companySearchText(company) {
  return [
    company.ticker,
    company.name,
    company.abbreviation,
    company.market_label,
    company.official_industry_label,
    company.template_label,
    company.industry_template
  ].join(" ").toLowerCase();
}

function applyFilters() {
  const keyword = state.filters.search.trim().toLowerCase();
  state.visibleCompanies = state.companies.filter((company) => {
    const templateOk = state.filters.template === "all" || company.industry_template === state.filters.template;
    const marketOk = state.filters.market === "all" || company.market === state.filters.market;
    const keywordOk = !keyword || companySearchText(company).includes(keyword);
    return templateOk && marketOk && keywordOk;
  });
}

function renderTemplateOptions() {
  const options = [`<option value="all">全部產業模板</option>`]
    .concat((state.universe.templates || []).map((template) => {
      const count = state.companies.filter((company) => company.industry_template === template.id).length;
      return `<option value="${escapeHtml(template.id)}">${escapeHtml(template.label)} (${count})</option>`;
    }));
  els.templateFilter.innerHTML = options.join("");
}

function renderSummary() {
  els.totalCount.textContent = state.universe.total_count.toLocaleString("zh-TW");
  els.visibleCount.textContent = state.visibleCompanies.length.toLocaleString("zh-TW");
  els.selectedCount.textContent = state.selected.size.toLocaleString("zh-TW");
  els.generatedAt.textContent = formatDateTime(state.universe.generated_at);
}

function renderSelectedList() {
  const selectedCompanies = [...state.selected]
    .map((ticker) => state.companies.find((company) => company.ticker === ticker))
    .filter(Boolean)
    .sort((a, b) => a.ticker.localeCompare(b.ticker, "zh-Hant-TW"));

  if (!selectedCompanies.length) {
    els.selectedList.innerHTML = `<span class="empty-state">尚未勾選公司</span>`;
    return;
  }

  els.selectedList.innerHTML = selectedCompanies.map((company) => `
    <span class="selected-chip">
      <strong>${escapeHtml(company.ticker)}</strong>
      ${escapeHtml(company.abbreviation || company.name)}
      <button class="chip-remove" type="button" data-remove="${escapeHtml(company.ticker)}" aria-label="移除 ${escapeHtml(company.ticker)}">x</button>
    </span>
  `).join("");
}

function companyRow(company) {
  const checked = state.selected.has(company.ticker) ? "checked" : "";
  return `
    <label class="company-row">
      <input type="checkbox" data-ticker="${escapeHtml(company.ticker)}" ${checked}>
      <span class="company-main">
        <span class="company-name"><span class="ticker">${escapeHtml(company.ticker)}</span> ${escapeHtml(company.abbreviation || company.name)}</span>
        <span class="company-sub">
          <span class="market-badge">${escapeHtml(company.market_label)}</span>
          <span class="company-industry">${escapeHtml(company.official_industry_label)} · ${escapeHtml(company.match_reason)}</span>
        </span>
      </span>
    </label>
  `;
}

function renderSections() {
  const byTemplate = new Map();
  for (const company of state.visibleCompanies) {
    if (!byTemplate.has(company.industry_template)) byTemplate.set(company.industry_template, []);
    byTemplate.get(company.industry_template).push(company);
  }

  const sections = (state.universe.templates || [])
    .map((template) => {
      const allCount = state.companies.filter((company) => company.industry_template === template.id).length;
      const visible = byTemplate.get(template.id) || [];
      if (!visible.length && state.filters.template !== template.id && state.filters.search) return "";
      const selectedCount = visible.filter((company) => state.selected.has(company.ticker)).length;
      const body = visible.length
        ? `<div class="company-grid">${visible.map(companyRow).join("")}</div>`
        : `<div class="empty-state">目前篩選條件下沒有公司。</div>`;

      return `
        <section class="template-section" data-template="${escapeHtml(template.id)}">
          <div class="section-heading">
            <div>
              <p class="eyebrow">${escapeHtml(template.short_label || template.id)}</p>
              <h2>${escapeHtml(template.label)}</h2>
            </div>
            <div class="section-meta">
              <span class="pill">全部 ${allCount.toLocaleString("zh-TW")}</span>
              <span class="pill">顯示 ${visible.length.toLocaleString("zh-TW")}</span>
              <span class="pill" data-selected-count="${escapeHtml(template.id)}">已選 ${selectedCount.toLocaleString("zh-TW")}</span>
              <button class="select-visible" type="button" data-select-template="${escapeHtml(template.id)}">勾選本區可見</button>
            </div>
          </div>
          <p class="template-description">${escapeHtml(template.description)}</p>
          ${body}
        </section>
      `;
    })
    .filter(Boolean);

  els.sections.innerHTML = sections.length
    ? sections.join("")
    : `<div class="empty-state">沒有符合條件的公司。</div>`;
}

function render() {
  applyFilters();
  renderSummary();
  renderSelectedList();
  renderSections();
}

function toggleCompany(ticker, checked) {
  if (checked) state.selected.add(ticker);
  else state.selected.delete(ticker);
  saveSelection();
  updateSelectionUi(ticker);
}

function updateSelectionUi(ticker) {
  renderSummary();
  renderSelectedList();

  const checkbox = document.querySelector(`input[data-ticker="${ticker}"]`);
  if (checkbox) checkbox.checked = state.selected.has(ticker);

  const company = state.companies.find((item) => item.ticker === ticker);
  if (!company) return;

  const selectedCount = state.visibleCompanies.filter((item) => (
    item.industry_template === company.industry_template && state.selected.has(item.ticker)
  )).length;
  const countPill = document.querySelector(`[data-selected-count="${company.industry_template}"]`);
  if (countPill) countPill.textContent = `已選 ${selectedCount.toLocaleString("zh-TW")}`;
}

function selectVisibleTemplate(templateId) {
  const targets = state.visibleCompanies.filter((company) => company.industry_template === templateId);
  const allSelected = targets.length && targets.every((company) => state.selected.has(company.ticker));
  for (const company of targets) {
    if (allSelected) state.selected.delete(company.ticker);
    else state.selected.add(company.ticker);
  }
  saveSelection();
  render();
}

async function copySelectedTickers() {
  const tickers = selectedTickers();
  const text = tickers.join(", ");
  if (!text) {
    els.copyStatus.textContent = "尚未勾選公司";
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    els.copyStatus.textContent = `已複製 ${tickers.length} 個代號`;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    els.copyStatus.textContent = `已複製 ${tickers.length} 個代號`;
  }
}

function saveCandidateSeed() {
  const tickers = selectedTickers();
  if (!tickers.length) {
    els.copyStatus.textContent = "尚未勾選公司";
    return;
  }

  const payload = {
    version: "0.1.0",
    type: "research_candidate_seed",
    generated_at: new Date().toISOString(),
    source: "universe.html",
    total_count: tickers.length,
    tickers,
    companies: selectedCompaniesForSeed(),
    note: "這是研究候選種子檔，尚未代表已建立正式研究檔或投資評分。"
  };
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `research-candidate-seed-${date}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  els.copyStatus.textContent = `已保存 ${tickers.length} 檔候選種子`;
}

function dashboardUrlForSelection(autoStart = false) {
  const params = new URLSearchParams();
  params.set("universe", "selected");
  const tickers = selectedTickers();
  if (tickers.length) params.set("tickers", tickers.join(","));
  if (autoStart) params.set("autostart", "1");
  return `index.html?${params.toString()}`;
}

function startResearch() {
  const tickers = selectedTickers();
  if (!tickers.length) {
    els.copyStatus.textContent = "尚未勾選公司";
    return;
  }

  saveSelection();
  setResearchProgress(`正在將 ${tickers.length} 家公司加入研究與更新流程...`, true);
  window.location.href = dashboardUrlForSelection(true);
}

function setResearchProgress(message, active = false) {
  els.copyStatus.textContent = message;
  els.startResearchButton.disabled = active;
  els.startResearchButton.textContent = active ? "正在前往研究流程" : "加入研究並更新";
}

async function pollResearchProgress() {
  if (!sessionStorage.getItem(RESEARCH_SESSION_KEY)) return;
  try {
    const response = await fetch("/api/research/status", { cache: "no-store" });
    if (!response.ok) throw new Error("無法讀取研究進度");
    const status = await response.json();
    if (status.status === "running") {
      setResearchProgress(`${status.message || "研究處理中"}（${status.tickers?.length || 0} 家）`, true);
      window.setTimeout(pollResearchProgress, 1800);
      return;
    }
    if (status.status === "done") {
      sessionStorage.removeItem(RESEARCH_SESSION_KEY);
      setResearchProgress("研究完成，正在開啟研究結果...", true);
      window.location.href = dashboardUrlForSelection();
      return;
    }
    if (status.status === "failed") {
      sessionStorage.removeItem(RESEARCH_SESSION_KEY);
      setResearchProgress(`研究失敗：${status.message || "請稍後再試"}`);
      return;
    }
    return;
  } catch (error) {
    setResearchProgress(`無法取得研究進度：${error.message}`);
  }
}

function bindEvents() {
  els.searchInput.addEventListener("input", (event) => {
    state.filters.search = event.target.value;
    render();
  });
  els.templateFilter.addEventListener("change", (event) => {
    state.filters.template = event.target.value;
    render();
  });
  els.marketFilter.addEventListener("change", (event) => {
    state.filters.market = event.target.value;
    render();
  });
  els.clearButton.addEventListener("click", () => {
    state.selected.clear();
    saveSelection();
    els.copyStatus.textContent = "已清除選取";
    render();
  });
  els.saveSeedButton.addEventListener("click", saveCandidateSeed);
  els.startResearchButton.addEventListener("click", startResearch);
  document.addEventListener("change", (event) => {
    const ticker = event.target?.dataset?.ticker;
    if (ticker) toggleCompany(ticker, event.target.checked);
  });
  document.addEventListener("click", (event) => {
    const removeTicker = event.target?.dataset?.remove;
    const templateId = event.target?.dataset?.selectTemplate;
    if (removeTicker) toggleCompany(removeTicker, false);
    if (templateId) selectVisibleTemplate(templateId);
  });
}

async function init() {
  try {
    const response = await fetch("data/listed_companies_universe.json");
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    state.universe = await response.json();
    state.companies = state.universe.companies || [];
    renderTemplateOptions();
    bindEvents();
    render();
    if (sessionStorage.getItem(RESEARCH_SESSION_KEY)) pollResearchProgress().catch(() => {});
  } catch (error) {
    els.sections.innerHTML = `<div class="error-state">無法載入上市上櫃公司清單：${escapeHtml(error.message)}</div>`;
  }
}

init();
