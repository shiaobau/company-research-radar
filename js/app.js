const state = {
  companies: [],
  templates: {},
  definitions: {},
  rules: {},
  signals: [],
  marketData: { companies: {}, sources: [] },
  revenueData: { companies: {}, sources: [] },
  financialData: { companies: {}, sources: [] },
  catalystData: { companies: {}, sources: [] },
  ownershipData: { companies: {}, sources: [] },
  riskData: { companies: {}, sources: [] },
  industryEvidenceData: { companies: {}, sources: [] },
  industryData: { companies: {}, sources: [] },
  dataStatus: { companies: {} },
  publicFactsData: { companies: {}, sources: [] },
  universe: { companies: [] },
  researchCache: { index: { companies: [] }, records: {}, pending: new Set() },
  schedulerStatus: { schedules: {}, current_run: null },
  researchStatus: { summary: {}, companies: {} },
  referenceSources: [],
  selectedId: null,
  managementMode: false,
  companyOrder: readWatchlistOrder(),
  pendingDeletionTicker: null,
  selectedManagerTickers: new Set(),
  pendingDeletionTickers: []
};

const $ = (selector) => document.querySelector(selector);

Promise.all([
  fetch("data/industry_templates.json").then((response) => response.json()),
  fetch("data/field_definitions.json").then((response) => response.json()),
  fetch("data/scoring_rules.json").then((response) => response.json()),
  fetch("data/companies.json").then((response) => response.json()),
  fetch("data/signals.json").then((response) => response.json()).catch(() => ({ signals: [] })),
  fetch("data/market_data.json").then((response) => response.json()).catch(() => ({ companies: {}, sources: [] })),
  fetch("data/revenue_data.json").then((response) => response.json()).catch(() => ({ companies: {}, sources: [] })),
  fetch("data/financial_data.json").then((response) => response.json()).catch(() => ({ companies: {}, sources: [] })),
  fetch("data/catalyst_data.json").then((response) => response.json()).catch(() => ({ companies: {}, sources: [] })),
  fetch("data/ownership_data.json").then((response) => response.json()).catch(() => ({ companies: {}, sources: [] })),
  fetch("data/risk_data.json").then((response) => response.json()).catch(() => ({ companies: {}, sources: [] })),
  fetch("data/industry_evidence_data.json").then((response) => response.json()).catch(() => ({ companies: {}, sources: [] })),
  fetch("data/industry_data.json").then((response) => response.json()).catch(() => ({ companies: {}, sources: [] })),
  fetch("data/data_status.json").then((response) => response.json()).catch(() => ({ companies: {} })),
  fetch("data/public_facts.json").then((response) => response.json()).catch(() => ({ companies: {}, sources: [] })),
  fetch("data/listed_companies_universe.json").then((response) => response.json()).catch(() => ({ companies: [] })),
  fetch("data/research_cache/index.json", { cache: "no-store" }).then((response) => response.json()).catch(() => ({ companies: [] })),
  fetch("data/scheduler_status.json", { cache: "no-store" }).then((response) => response.json()).catch(() => ({ schedules: {}, current_run: null })),
  fetch("data/research_status.json", { cache: "no-store" }).then((response) => response.json()).catch(() => ({ summary: {}, companies: {} }))
]).then(([templates, definitions, rules, companies, signals, marketData, revenueData, financialData, catalystData, ownershipData, riskData, industryEvidenceData, industryData, dataStatus, publicFactsData, universe, researchCacheIndex, schedulerStatus, researchStatus]) => {
  state.templates = templates.industries;
  state.definitions = definitions.fields;
  state.rules = rules;
  state.companies = companies.companies;
  state.marketData = marketData;
  state.revenueData = revenueData;
  state.financialData = financialData;
  state.catalystData = catalystData;
  state.ownershipData = ownershipData;
  state.riskData = riskData;
  state.industryEvidenceData = industryEvidenceData;
  state.industryData = industryData;
  state.dataStatus = dataStatus;
  state.publicFactsData = publicFactsData;
  state.universe = universe;
  state.researchCache.index = researchCacheIndex;
  state.schedulerStatus = schedulerStatus;
  state.researchStatus = researchStatus;
  state.referenceSources = [
    ...(companies.reference_sources || []),
    ...(marketData.sources || []),
    ...(revenueData.sources || []),
    ...(financialData.sources || []),
    ...(catalystData.sources || []),
    ...(ownershipData.sources || []),
    ...(riskData.sources || []),
    ...(industryEvidenceData.sources || []),
    ...(industryData.sources || []),
    ...(publicFactsData.sources || [])
  ];
  state.signals = signals.signals || [];
  pruneCompletedUniverseCandidates();
  initControls();
  state.selectedId = universeSelectionMode()
    ? candidateWatchlistItems()[0]?.id || state.companies[0]?.id || null
    : state.companies[0]?.id || null;
  renderAll();
  autoStartResearchFromUrl();
}).catch((error) => {
  $("#company-list").innerHTML = `<p class="risk">資料載入失敗：${RadarRenderers.escapeHtml(error.message)}</p>`;
});

function selectedUniverseTickers() {
  const urlTickers = new URLSearchParams(window.location.search)
    .get("tickers")
    ?.split(",")
    .map((ticker) => ticker.trim())
    .filter(Boolean) || [];

  if (urlTickers.length) {
    const tickers = [...new Set(urlTickers)].sort((a, b) => a.localeCompare(b, "zh-Hant-TW"));
    localStorage.setItem("researchUniverseSelectedTickers", JSON.stringify(tickers));
    return tickers;
  }

  let storedTickers = [];
  try {
    storedTickers = JSON.parse(localStorage.getItem("researchUniverseSelectedTickers") || "[]")
      .filter((ticker) => typeof ticker === "string" && ticker.trim());
  } catch {
    storedTickers = [];
  }

  return [...new Set(storedTickers)].sort((a, b) => a.localeCompare(b, "zh-Hant-TW"));
}

function autoStartResearchFromUrl() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("autostart") !== "1") return;
  params.delete("autostart");
  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  sessionStorage.setItem("researchAutoRefreshAfterRun", "1");
  window.setTimeout(startResearchFromDashboard, 120);
}

function clearUniverseResearchRequest() {
  localStorage.removeItem("researchUniverseSelectedTickers");
  const params = new URLSearchParams(window.location.search);
  params.delete("universe");
  params.delete("tickers");
  params.delete("autostart");
  const query = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
}

function pruneCompletedUniverseCandidates() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("universe") !== "selected" || params.get("autostart") === "1") return;

  const tickers = selectedUniverseTickers();
  if (!tickers.length) return;

  const researchedTickers = new Set(state.companies.map((company) => company.ticker));
  const pendingTickers = tickers.filter((ticker) => !researchedTickers.has(ticker));
  if (pendingTickers.length === tickers.length) return;
  if (!pendingTickers.length) {
    clearUniverseResearchRequest();
    return;
  }

  localStorage.setItem("researchUniverseSelectedTickers", JSON.stringify(pendingTickers));
  params.set("tickers", pendingTickers.join(","));
  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
}

function universeSelectionMode() {
  return new URLSearchParams(window.location.search).get("universe") === "selected";
}

function selectedUniverseCompanies() {
  const tickers = new Set(selectedUniverseTickers());
  const officialByTicker = Object.fromEntries((state.universe.companies || []).map((company) => [company.ticker, company]));
  const researchByTicker = Object.fromEntries(state.companies.map((company) => [company.ticker, company]));
  return [...tickers]
    .sort((a, b) => a.localeCompare(b, "zh-Hant-TW"))
    .map((ticker) => ({
      ticker,
      official: officialByTicker[ticker],
      research: researchByTicker[ticker]
    }))
    .filter((item) => item.official || item.research);
}

function setCandidateTickers(tickers) {
  const cleanTickers = [...new Set(
    tickers
      .map((ticker) => String(ticker).trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, "zh-Hant-TW"));
  localStorage.setItem("researchUniverseSelectedTickers", JSON.stringify(cleanTickers));
  updateUniverseUrl(cleanTickers);
  const input = $("#candidate-tickers-input");
  if (input) input.value = cleanTickers.join(", ");
  return cleanTickers;
}

function setResearchStatus(message, active = true) {
  const status = $("#research-status");
  if (!status) return;
  status.className = active ? "research-status active" : "research-status";
  status.textContent = message || "";
}

function setResearchProgress(message, percent = 0) {
  const status = $("#research-status");
  if (!status) return;
  const progress = Math.max(0, Math.min(99, Number(percent) || 0));
  status.className = "research-status active research-progress";
  status.innerHTML = `
    <div><strong>${RadarRenderers.escapeHtml(message || "研究流程執行中")}</strong><span>${progress}%</span><div class="progress-track"><i style="--progress:${progress}%"></i></div></div>
  `;
}

function parseTickerText(text) {
  return String(text || "")
    .split(/[\s,，、;；]+/)
    .map((ticker) => ticker.trim())
    .filter(Boolean);
}

function candidateWatchlistItems() {
  return selectedUniverseCompanies().map(({ ticker, official, research }) => {
    if (research) return research;
    const templateId = official?.industry_template || "other";
    return {
      __candidate: true,
      id: `candidate-${ticker}`,
      ticker,
      market: official?.market || "",
      market_label: official?.market_label || "",
      name: official?.abbreviation || official?.name || ticker,
      legal_name: official?.name || "",
      industry_template: templateId,
      template_label: official?.template_label || templateId,
      official_industry_label: official?.official_industry_label || "",
      thesis: "已加入研究候選，公開資料蒐集中。",
      tags: ["研究候選", "研究準備中"],
      official
    };
  });
}

function companyById(id) {
  return state.companies.find((item) => item.id === id)
    || candidateWatchlistItems().find((item) => item.id === id);
}

function readWatchlistOrder() {
  try {
    const stored = JSON.parse(localStorage.getItem("researchWatchlistOrder") || "[]");
    return Array.isArray(stored) ? stored.filter((ticker) => typeof ticker === "string") : [];
  } catch {
    return [];
  }
}

function orderedResearchCompanies(companies) {
  const position = new Map(state.companyOrder.map((ticker, index) => [ticker, index]));
  return [...companies].sort((left, right) => {
    const leftPosition = position.get(left.ticker);
    const rightPosition = position.get(right.ticker);
    if (leftPosition !== undefined && rightPosition !== undefined) return leftPosition - rightPosition;
    if (leftPosition !== undefined) return -1;
    if (rightPosition !== undefined) return 1;
    return String(left.ticker).localeCompare(String(right.ticker), "zh-Hant-TW");
  });
}

function moveResearchCompany(ticker, direction) {
  const ordered = orderedResearchCompanies(state.companies);
  const fromIndex = ordered.findIndex((company) => company.ticker === ticker);
  const toIndex = fromIndex + direction;
  if (fromIndex < 0 || toIndex < 0 || toIndex >= ordered.length) return;
  [ordered[fromIndex], ordered[toIndex]] = [ordered[toIndex], ordered[fromIndex]];
  state.companyOrder = ordered.map((company) => company.ticker);
  localStorage.setItem("researchWatchlistOrder", JSON.stringify(state.companyOrder));
  renderAll();
}

function placeResearchCompanyBefore(ticker, targetTicker) {
  if (!ticker || ticker === targetTicker) return;
  const ordered = orderedResearchCompanies(state.companies);
  const fromIndex = ordered.findIndex((company) => company.ticker === ticker);
  const targetIndex = ordered.findIndex((company) => company.ticker === targetTicker);
  if (fromIndex < 0 || targetIndex < 0) return;
  const [moved] = ordered.splice(fromIndex, 1);
  const nextTargetIndex = ordered.findIndex((company) => company.ticker === targetTicker);
  ordered.splice(nextTargetIndex, 0, moved);
  state.companyOrder = ordered.map((company) => company.ticker);
  localStorage.setItem("researchWatchlistOrder", JSON.stringify(state.companyOrder));
  renderAll();
}

function renderCompanyManager() {
  const panel = $("#company-manager");
  const button = $("#manage-list-button");
  if (!panel || !button) return;
  panel.hidden = !state.managementMode;
  button.textContent = state.managementMode ? "完成管理" : "管理清單";
  button.setAttribute("aria-expanded", String(state.managementMode));
  const heading = panel.closest(".primary-panel")?.querySelector(".section-heading");
  if (heading?.nextElementSibling !== panel) heading.insertAdjacentElement("afterend", panel);
  if (!state.managementMode) return;

  const companies = orderedResearchCompanies(state.companies);
  const selected = state.selectedManagerTickers;
  const allSelected = companies.length > 0 && companies.every((company) => selected.has(company.ticker));
  panel.innerHTML = `
    <div class="manager-heading">
      <div>
        <p class="eyebrow">Watchlist Management</p>
        <h3>刪除與排序</h3>
      </div>
      <div class="manager-toolbar">
        <button class="ghost-button" type="button" data-select-all-manager>${allSelected ? "取消全選" : "全選"}</button>
        <button class="ghost-button manager-remove" type="button" data-request-bulk-delete ${selected.size ? "" : "disabled"}>移除已選 ${selected.size ? `(${selected.size})` : ""}</button>
      </div>
    </div>
    <p class="muted">拖曳調整順序，僅保存在此瀏覽器。</p>
    <div class="manager-list">
      ${companies.map((company) => `
        <article class="manager-row" draggable="true" data-company-ticker="${RadarRenderers.escapeHtml(company.ticker)}">
          <label class="manager-select" title="選擇 ${RadarRenderers.escapeHtml(company.name)}">
            <input type="checkbox" data-manager-select="${RadarRenderers.escapeHtml(company.ticker)}" ${selected.has(company.ticker) ? "checked" : ""}>
          </label>
          <div class="manager-company">
            <strong>${RadarRenderers.escapeHtml(company.name)}</strong>
            <small>${RadarRenderers.escapeHtml(stockLabel(company))}</small>
          </div>
        </article>
      `).join("")}
    </div>
  `;

  panel.querySelector("[data-select-all-manager]")?.addEventListener("click", () => {
    state.selectedManagerTickers = allSelected ? new Set() : new Set(companies.map((company) => company.ticker));
    renderCompanyManager();
  });
  panel.querySelector("[data-request-bulk-delete]")?.addEventListener("click", () => requestResearchDeletion([...state.selectedManagerTickers]));
  panel.querySelectorAll("[data-manager-select]").forEach((input) => {
    input.addEventListener("change", () => {
      const ticker = input.dataset.managerSelect;
      if (input.checked) state.selectedManagerTickers.add(ticker);
      else state.selectedManagerTickers.delete(ticker);
      renderCompanyManager();
    });
  });

  panel.querySelectorAll(".manager-row").forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", row.dataset.companyTicker || "");
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      panel.querySelectorAll(".manager-row").forEach((item) => item.classList.remove("dragging", "drag-over"));
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      placeResearchCompanyBefore(event.dataTransfer?.getData("text/plain"), row.dataset.companyTicker);
    });
  });
}

function ensureCandidatePanel() {
  let panel = $("#universe-candidate-panel");
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "universe-candidate-panel";
    panel.className = "section-block";
  }
  const anchor = $(".candidate-loader");
  if (anchor?.nextElementSibling !== panel) anchor?.insertAdjacentElement("afterend", panel);
  return panel;
}

function renderUniverseCandidates() {
  const panel = ensureCandidatePanel();
  const candidates = selectedUniverseCompanies().filter(({ research }) => !research);
  if (!candidates.length) {
    panel.style.display = "none";
    return;
  }

  panel.style.display = "";
  panel.innerHTML = `
    <div class="section-heading">
      <div>
        <p class="eyebrow">Universe Selection</p>
        <h2>選股頁送來的研究候選</h2>
      </div>
      <div class="candidate-actions">
        <span class="pill">${candidates.length}</span>
        <button class="ghost-button" type="button" data-start-research>開始研究</button>
        <a class="ghost-button" href="universe.html">回選股頁</a>
      </div>
    </div>
    <div class="candidate-list">
      ${candidates.map(({ ticker, official, research }) => {
        const name = research?.name || official?.abbreviation || official?.name || ticker;
        const legalName = official?.name || research?.legal_name || "";
        const template = state.templates[research?.industry_template]?.label || official?.template_label || "待分類";
        const status = research ? "已在觀察清單" : "研究準備中";
        return `
          <span class="candidate-chip" title="${RadarRenderers.escapeHtml(template)} / ${RadarRenderers.escapeHtml(status)}">
            <b>${RadarRenderers.escapeHtml(ticker)}</b>
            <strong>${RadarRenderers.escapeHtml(name)}</strong>
            ${legalName && legalName !== name ? `<small>${RadarRenderers.escapeHtml(legalName)}</small>` : ""}
            <em>${RadarRenderers.escapeHtml(status)}</em>
            <button class="candidate-remove" type="button" data-remove-candidate="${RadarRenderers.escapeHtml(ticker)}" aria-label="移除 ${RadarRenderers.escapeHtml(ticker)}">x</button>
          </span>
        `;
      }).join("")}
    </div>
    <p class="muted">研究完成後，這批候選會自動移入觀察清單。</p>
  `;
}

function updateUniverseUrl(tickers) {
  const params = new URLSearchParams(window.location.search);
  if (params.get("universe") === "selected") {
    if (tickers.length) params.set("tickers", tickers.join(","));
    else params.delete("tickers");
    const next = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, "", next);
  }
}

function removeUniverseCandidate(ticker) {
  const tickers = selectedUniverseTickers().filter((item) => item !== ticker);
  localStorage.setItem("researchUniverseSelectedTickers", JSON.stringify(tickers));
  updateUniverseUrl(tickers);
  if (state.selectedId === `candidate-${ticker}`) {
    state.selectedId = candidateWatchlistItems()[0]?.id || state.companies[0]?.id || null;
  }
  const input = $("#candidate-tickers-input");
  if (input) input.value = tickers.join(", ");
  renderAll();
}

function ensureDeletionDialog() {
  let dialog = $("#research-deletion-dialog");
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.id = "research-deletion-dialog";
  dialog.className = "confirm-dialog";
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "confirm") deleteResearchCompanies(state.pendingDeletionTickers);
    state.pendingDeletionTickers = [];
  });
  document.body.append(dialog);
  return dialog;
}

function requestResearchDeletion(tickers) {
  const selected = [...new Set(tickers)].filter((ticker) => state.companies.some((company) => company.ticker === ticker));
  if (!selected.length) return;
  const companies = selected.map((ticker) => state.companies.find((company) => company.ticker === ticker));
  state.pendingDeletionTickers = selected;
  const dialog = ensureDeletionDialog();
  dialog.innerHTML = `
    <form method="dialog">
      <p class="eyebrow">Confirm removal</p>
      <h2>確認移除 ${companies.length} 家公司？</h2>
      <div class="dialog-list">${companies.map((company) => `<span>${RadarRenderers.escapeHtml(`${company.ticker} ${company.name}`)}</span>`).join("")}</div>
      <div class="dialog-actions"><button class="ghost-button" value="cancel">取消</button><button class="ghost-button manager-remove" value="confirm">確認移除</button></div>
    </form>
  `;
  dialog.showModal();
}

async function deleteResearchCompanies(tickers) {
  if (!tickers.length) return;
  setResearchStatus(`移除 ${tickers.length} 家公司中...`);
  try {
    const response = await fetch(`/api/company?tickers=${encodeURIComponent(tickers.join(","))}`, { method: "DELETE" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "刪除失敗");
    setCandidateTickers(selectedUniverseTickers().filter((item) => !tickers.includes(item)));
    state.selectedManagerTickers = new Set();
    setResearchStatus(`已移除 ${tickers.length} 家公司，正在重新整理...`);
    window.location.reload();
  } catch (error) {
    setResearchStatus(`無法移除公司：${error.message}`);
  }
}

async function pollResearchStatus() {
  try {
    const response = await fetch("/api/research/status");
    if (!response.ok) return;
    const status = await response.json();
    if (status.status === "idle") return;
    const message = `${status.message}${status.tickers?.length ? `（${status.tickers.join(", ")}）` : ""}`;
    if (status.status === "running") {
      setResearchProgress(message, status.progress_percent);
      setTimeout(pollResearchStatus, 2500);
    }
    if (status.status === "done") {
      if (sessionStorage.getItem("researchAutoRefreshAfterRun") === "1") {
        sessionStorage.removeItem("researchAutoRefreshAfterRun");
        clearUniverseResearchRequest();
        setResearchStatus(`${status.message}，正在載入最新結果...`);
        window.setTimeout(() => window.location.reload(), 900);
        return;
      }
      setResearchStatus(status.message, false);
      return;
    }
    if (status.status === "error") {
      sessionStorage.removeItem("researchAutoRefreshAfterRun");
      setResearchStatus(`研究流程未完成：${status.message}`, false);
    }
  } catch {
    // 靜態伺服器沒有 API 時保持安靜，避免干擾一般瀏覽。
  }
}

async function startResearchFromDashboard() {
  const tickers = selectedUniverseCompanies()
    .filter(({ research }) => !research)
    .map(({ ticker }) => ticker);
  if (!tickers.length) {
    setResearchStatus("請先載入候選代號或候選種子檔。");
    return;
  }

  setResearchProgress("研究流程啟動中...", 0);
  try {
    const response = await fetch("/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tickers })
    });
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("研究功能只能在本機的 127.0.0.1:8768 使用。");
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "研究 API 無法啟動");
    setResearchProgress(`研究流程已啟動：${tickers.join(", ")}`, 0);
    setTimeout(pollResearchStatus, 1200);
  } catch (error) {
    sessionStorage.removeItem("researchAutoRefreshAfterRun");
    setResearchStatus(`目前使用的是靜態伺服器，請改用動態研究伺服器後再按開始研究。${error.message}`);
  }
}

function ensureCollectorControls() {
  return;
  const loader = $(".candidate-loader");
  if (!loader || $("#collect-events-button")) return;
  const button = document.createElement("button");
  button.id = "collect-events-button";
  button.type = "button";
  button.className = "ghost-button";
  button.textContent = "更新公告事件";
  button.addEventListener("click", collectEventsFromDashboard);
  loader.append(button);

  const status = document.createElement("section");
  status.id = "collector-status";
  status.className = "research-status";
  status.setAttribute("aria-live", "polite");
  loader.insertAdjacentElement("afterend", status);
}

function setCollectorStatus(message, active = false) {
  const status = $("#collector-status");
  if (!status) return;
  status.textContent = message || "";
  status.className = active ? "research-status active" : "research-status";
}

async function refreshResearchCacheIndex() {
  try {
    const response = await fetch("data/research_cache/index.json", { cache: "no-store" });
    if (response.ok) state.researchCache.index = await response.json();
  } catch {
    // The dashboard still works when it is opened as a static site without a collector cache.
  }
}

async function loadResearchCacheFor(company) {
  if (!company || company.__candidate || state.researchCache.records[company.ticker] || state.researchCache.pending.has(company.ticker)) return;
  state.researchCache.pending.add(company.ticker);
  const urls = [
    `/api/research-cache?ticker=${encodeURIComponent(company.ticker)}`,
    `data/research_cache/${encodeURIComponent(company.ticker)}.json`
  ];
  try {
    for (const url of urls) {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) continue;
      state.researchCache.records[company.ticker] = await response.json();
      break;
    }
  } catch {
    // A missing cache is a normal state before the first targeted collection.
  } finally {
    state.researchCache.pending.delete(company.ticker);
    if (state.selectedId === company.id) renderDetail();
  }
}

async function pollCollectorStatus() {
  try {
    const response = await fetch("/api/collector/status");
    if (!response.ok) return;
    const status = await response.json();
    if (status.status === "idle") return;
    setCollectorStatus(status.message || "公告事件蒐集中", status.status === "running");
    if (status.status === "running") {
      setTimeout(pollCollectorStatus, 1800);
      return;
    }
    if (status.status === "done") {
      await refreshResearchCacheIndex();
      for (const ticker of status.tickers || []) delete state.researchCache.records[ticker];
      renderDetail();
    }
  } catch {
    // The static site mode has no collector endpoint.
  }
}

async function collectEventsFromDashboard() {
  const tickers = state.companies.map((company) => company.ticker).filter((ticker) => /^\d{4}$/.test(ticker));
  if (!tickers.length) {
    setCollectorStatus("目前沒有已建立研究檔的公司。");
    return;
  }
  setCollectorStatus("正在更新研究公司的官方公告事件...", true);
  try {
    const response = await fetch("/api/collector", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tickers })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "Collector request failed.");
    setTimeout(pollCollectorStatus, 800);
  } catch (error) {
    setCollectorStatus(`公告事件更新失敗：${error.message}`);
  }
}

function ensureSchedulerPanel() {
  if ($("#scheduler-panel")) return;
  const panel = document.createElement("section");
  panel.id = "scheduler-panel";
  panel.className = "scheduler-panel";
  const anchor = $("#collector-status") || $("#research-status");
  anchor?.insertAdjacentElement("afterend", panel);
  renderSchedulerPanel();
}

function schedulerRunLabel(run) {
  if (!run) return "尚未執行";
  if (run.status === "running") return "更新中";
  if (run.status === "done") return `完成 ${new Date(run.finished_at || run.started_at).toLocaleString("zh-TW")}`;
  if (run.status === "dry_run") return "模擬執行完成";
  if (run.status === "skipped") return "略過：已有更新工作執行中";
  return `失敗 ${new Date(run.finished_at || run.started_at).toLocaleString("zh-TW")}`;
}

function renderSchedulerPanel() {
  const panel = $("#scheduler-panel");
  if (!panel) return;
  const schedules = state.schedulerStatus.schedules || {};
  const order = ["morning", "evening"];
  const active = state.schedulerStatus.current_run;
  const localServer = ["127.0.0.1", "localhost"].includes(window.location.hostname);
  const coverage = state.researchStatus.summary || {};
  const calculatedReadiness = state.companies.map((company) => ({
    company,
    score: RadarScoring.computeCompanyScore(company, state.rules, scoringDatasets())
  }));
  const incomplete = calculatedReadiness.filter(({ score }) => !score.complete).map(({ company }) => researchReadiness(company));
  const coreComplete = calculatedReadiness.filter(({ score }) => score.complete && score.isProvisional);
  const stateLabel = active ? "更新中" : incomplete.length ? "資料待補" : coreComplete.length ? "核心分析完成" : "完成分析";
  const activeProgress = Math.max(0, Math.min(99, Number(active?.progress_percent) || 0));
  panel.innerHTML = `
    <div class="update-dashboard">
      <section class="update-section">
        <div><p class="eyebrow">Automatic</p><h2>自動更新</h2></div>
        <p class="muted">平日早晚各一次完整更新，包含公開來源、評分資料、MOPS 歷史事件與完整性驗證。</p>
        <div class="scheduler-grid">
          ${order.map((id) => {
            const schedule = schedules[id] || {};
            const run = schedule.last_run;
            const label = run ? schedulerRunLabel(run) : `預定平日 ${schedule.time || "--:--"}`;
            return `<article class="scheduler-card ${run?.status || "idle"}"><div><strong>${RadarRenderers.escapeHtml(schedule.time || "--:--")}</strong><span>${RadarRenderers.escapeHtml(schedule.label || id)}</span></div><small>${RadarRenderers.escapeHtml(label)}</small></article>`;
          }).join("")}
        </div>
      </section>
      <section class="update-section update-manual">
        <div><p class="eyebrow">Manual</p><h2>手動更新</h2></div>
        <p class="muted">立即執行與平日排程相同的完整更新與一次補抓。</p>
        <button class="ghost-button" type="button" data-run-manual-update ${localServer ? "" : "disabled"} title="${localServer ? "更新後會重新驗證所有必要評分維度" : "手動更新僅能在本機服務執行"}">執行完整更新</button>
      </section>
      <section class="update-section update-status">
        <div><p class="eyebrow">Status</p><h2>更新情形 <span class="pill">${stateLabel}</span></h2></div>
        ${active ? `<div class="update-progress"><span class="progress-spinner" aria-hidden="true"></span><div><strong>${RadarRenderers.escapeHtml(active.current_step?.label || active.label || "更新中")}</strong><span>${activeProgress}%</span><div class="progress-track"><i style="--progress:${activeProgress}%"></i></div></div></div>` : `<p class="muted">完整分析 ${coverage.complete_count || 0}/${coverage.total || 0} 家；核心分析完成 ${coverage.core_complete_count || 0} 家</p>`}
        ${incomplete.length ? `<div class="update-missing-list">${incomplete.map((company) => `<span title="${RadarRenderers.escapeHtml((company.missing_dimensions || []).map((item) => item.label).join("、"))}">${RadarRenderers.escapeHtml(`${company.ticker} ${company.name}`)}：${RadarRenderers.escapeHtml((company.missing_dimensions || []).map((item) => item.label).join("、"))}</span>`).join("")}</div>` : "<p class=\"muted\">目前研究公司均已通過七項必要維度驗證。</p>"}
      </section>
    </div>
  `;
}

async function runManualFullUpdate() {
  try {
    const response = await fetch("/api/scheduler/manual", { method: "POST" });
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("手動完整更新只能在本機的 127.0.0.1:8768 使用。");
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "手動更新無法啟動");
    setResearchStatus("手動完整更新已開始，完成後會驗證所有評分維度。");
    window.setTimeout(refreshSchedulerStatus, 800);
    window.setTimeout(refreshSchedulerStatus, 3500);
  } catch (error) {
    setResearchStatus(`無法啟動手動完整更新：${error.message}`);
  }
}

async function refreshSchedulerStatus() {
  try {
    const response = await fetch("data/scheduler_status.json", { cache: "no-store" });
    if (!response.ok) return;
    state.schedulerStatus = await response.json();
    const researchResponse = await fetch("data/research_status.json", { cache: "no-store" });
    if (researchResponse.ok) state.researchStatus = await researchResponse.json();
    renderSchedulerPanel();
    if (state.schedulerStatus.current_run) window.setTimeout(refreshSchedulerStatus, 2200);
  } catch {
    // The dashboard can still be opened without a configured local scheduler.
  }
}

function sourceIndexFor(company) {
  const index = {};
  [...state.referenceSources, ...(company.sources || [])].forEach((source) => {
    index[source.id] = source;
  });
  return index;
}

function scoringDatasets() {
  return {
    catalystData: state.catalystData,
    marketData: state.marketData,
    revenueData: state.revenueData,
    financialData: state.financialData,
    ownershipData: state.ownershipData,
    riskData: state.riskData,
    industryEvidenceData: state.industryEvidenceData,
    industryData: state.industryData
  };
}

function ensureOnboardingPanel() {
  if ($("#onboarding-panel")) return;
  const panel = document.createElement("section");
  panel.id = "onboarding-panel";
  panel.className = "onboarding-panel";
  $(".candidate-loader")?.insertAdjacentElement("afterend", panel);
}

function renderOnboarding() {
  const panel = $("#onboarding-panel");
  if (!panel) return;
  if (state.companies.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const selectedTickers = selectedUniverseTickers();
  panel.innerHTML = `
    <div class="onboarding-copy">
      <p class="eyebrow">Start Here</p>
      <h2>${selectedTickers.length ? "回到選股頁建立研究檔" : "從選股頁選擇公司"}</h2>
      <p>勾選公司後在選股頁開始研究；完成後，研究結果會自動出現在這裡。</p>
    </div>
    <div class="onboarding-actions"><a class="ghost-button onboarding-action" href="universe.html">開啟選股頁</a></div>
  `;
}

function makeSectionCollapsible(targetSelector, open = false) {
  const target = $(targetSelector);
  const section = target?.closest(".section-block");
  if (!section || section.dataset.collapsible === "true") return;
  const heading = section.querySelector(".section-heading");
  const eyebrow = heading?.querySelector(".eyebrow")?.textContent || "研究資料";
  const title = heading?.querySelector("h2")?.textContent || "更多資料";
  const details = document.createElement("details");
  details.className = "collapsible-section";
  details.open = open;
  const summary = document.createElement("summary");
  summary.innerHTML = `<span><span class="eyebrow">${RadarRenderers.escapeHtml(eyebrow)}</span><strong>${RadarRenderers.escapeHtml(title)}</strong></span>`;
  const content = document.createElement("div");
  content.className = "collapsible-content";
  [...section.children].forEach((child) => {
    if (child !== heading) content.appendChild(child);
  });
  details.append(summary, content);
  section.replaceChildren(details);
  section.dataset.collapsible = "true";
}

function setupCollapsibleSections() {
  makeSectionCollapsible("#standards-grid");
  makeSectionCollapsible("#timeline");
  makeSectionCollapsible("#source-list");
}

function initControls() {
  const industryFilter = $("#industry-filter");
  industryFilter.innerHTML = [
    `<option value="all">全部產業</option>`,
    ...Object.values(state.templates).map((template) => `<option value="${template.id}">${RadarRenderers.escapeHtml(template.label)}</option>`)
  ].join("");

  ["search-input", "industry-filter", "score-filter"].forEach((id) => {
    $(`#${id}`).addEventListener("input", renderAll);
  });

  $("#reset-button").addEventListener("click", () => {
    $("#search-input").value = "";
    $("#score-filter").value = "all";
    $("#industry-filter").value = "all";
    renderAll();
  });

  $("#manage-list-button").addEventListener("click", () => {
    state.managementMode = !state.managementMode;
    renderCompanyManager();
  });

  const quickCompanyInput = $("#quick-company-input");
  quickCompanyInput.addEventListener("input", renderQuickCompanyResults);
  quickCompanyInput.addEventListener("focus", renderQuickCompanyResults);
  quickCompanyInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    hideQuickCompanyResults();
    quickCompanyInput.blur();
  });

  $("#candidate-seed-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const tickers = Array.isArray(payload.tickers)
        ? payload.tickers
        : Array.isArray(payload.companies)
          ? payload.companies.map((company) => company.ticker)
          : [];
      setCandidateTickers(tickers);
      const params = new URLSearchParams(window.location.search);
      params.set("universe", "selected");
      params.set("tickers", selectedUniverseTickers().join(","));
      window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
      state.selectedId = candidateWatchlistItems()[0]?.id || state.companies[0]?.id || null;
      renderAll();
    } catch (error) {
      $("#universe-candidate-panel")?.remove();
      alert(`候選種子檔無法讀取：${error.message}`);
    } finally {
      event.target.value = "";
    }
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-run-manual-update]")) {
      runManualFullUpdate();
      return;
    }
    if (event.target.closest("[data-start-research]")) {
      sessionStorage.setItem("researchAutoRefreshAfterRun", "1");
      startResearchFromDashboard();
      return;
    }
    const quickResult = event.target.closest("[data-quick-company-ticker]");
    if (quickResult) {
      handleQuickCompanyResult(quickResult.dataset.quickCompanyTicker);
      return;
    }
    const ticker = event.target?.dataset?.removeCandidate;
    if (ticker) removeUniverseCandidate(ticker);
    const moveTicker = event.target?.dataset?.moveCompany;
    if (moveTicker) moveResearchCompany(moveTicker, Number(event.target.dataset.moveDirection));
  });

  ensureOnboardingPanel();
  ensureSchedulerPanel();
  setupCollapsibleSections();
  pollResearchStatus();
  pollCollectorStatus();
  refreshSchedulerStatus();
  setInterval(refreshSchedulerStatus, 60000);
}

function quickCompanySearchText(company) {
  return [
    company.ticker,
    company.name,
    company.abbreviation,
    company.market_label,
    company.official_industry_label,
    company.template_label
  ].filter(Boolean).join(" ").toLowerCase();
}

function quickCompanyDisplayName(company) {
  const shortName = String(company?.abbreviation || "").trim();
  const officialName = String(company?.name || "").trim();
  if (shortName && officialName && shortName !== officialName) return `${shortName}（${officialName}）`;
  return shortName || officialName || "公司名稱未提供";
}

function hideQuickCompanyResults() {
  const results = $("#quick-company-results");
  const input = $("#quick-company-input");
  if (!results || !input) return;
  results.hidden = true;
  results.replaceChildren();
  input.setAttribute("aria-expanded", "false");
}

function renderQuickCompanyResults() {
  const input = $("#quick-company-input");
  const results = $("#quick-company-results");
  if (!input || !results) return;
  const keyword = input.value.trim().toLowerCase();
  if (!keyword) {
    hideQuickCompanyResults();
    return;
  }

  const researchByTicker = new Map(state.companies.map((company) => [company.ticker, company]));
  const matches = (state.universe.companies || [])
    .filter((company) => quickCompanySearchText(company).includes(keyword))
    .slice(0, 8);

  if (!matches.length) {
    results.innerHTML = `<p class="quick-company-empty">找不到符合的上市上櫃公司</p>`;
  } else {
    results.innerHTML = matches.map((company) => {
      const researched = researchByTicker.has(company.ticker);
      const name = quickCompanyDisplayName(company);
      const legalName = String(company.name || name).trim();
      const status = researched ? "查看研究" : "加入研究";
      return `
        <button class="quick-company-result" type="button" role="option" data-quick-company-ticker="${RadarRenderers.escapeHtml(company.ticker)}">
          <span class="quick-company-name"><b>${RadarRenderers.escapeHtml(company.ticker)}</b><strong>${RadarRenderers.escapeHtml(name)}</strong></span>
          <small class="quick-company-legal-name">${RadarRenderers.escapeHtml(legalName)}</small>
          <small>${RadarRenderers.escapeHtml(company.market_label || company.market || "")} · ${RadarRenderers.escapeHtml(company.template_label || company.official_industry_label || "未分類")}</small>
          <em>${status}</em>
        </button>
      `;
    }).join("");
  }

  results.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

async function handleQuickCompanyResult(ticker) {
  const input = $("#quick-company-input");
  const existing = state.companies.find((company) => company.ticker === ticker);
  if (existing) {
    state.selectedId = existing.id;
    if (input) input.value = "";
    hideQuickCompanyResults();
    renderAll();
    document.querySelector(`.company-card[data-id="${existing.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }

  const official = (state.universe.companies || []).find((company) => company.ticker === ticker);
  const companyLabel = `${ticker} ${quickCompanyDisplayName(official)}`;
  const tickers = setCandidateTickers([...selectedUniverseTickers(), ticker]);
  const params = new URLSearchParams(window.location.search);
  params.set("universe", "selected");
  params.set("tickers", tickers.join(","));
  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  if (input) input.value = "";
  hideQuickCompanyResults();
  state.selectedId = `candidate-${ticker}`;
  setResearchStatus(`${companyLabel} 已加入待研究清單。請按「開始研究」。`);
  renderAll();
}

function companyText(company) {
  if (company.__candidate) {
    return [
      company.ticker,
      company.market,
      company.market_label,
      company.name,
      company.legal_name,
      company.template_label,
      company.official_industry_label,
      ...(company.tags || [])
    ].join(" ").toLowerCase();
  }

  const signalText = state.signals
    .filter((signal) => signal.company_id === company.id)
    .map((signal) => `${signal.title} ${signal.type} ${signal.dimension}`)
    .join(" ");
  return [
    company.ticker,
    company.market,
    company.market_label,
    company.name,
    company.legal_name,
    company.category,
    company.thesis,
    state.templates[company.industry_template]?.label,
    ...(company.tags || []),
    signalText,
    ...Object.values(company.facts || {}).map((fact) => Array.isArray(fact.value) ? fact.value.join(" ") : fact.value)
  ].join(" ").toLowerCase();
}

function stockLabel(company) {
  return [company.ticker, company.market_label || company.market]
    .filter(Boolean)
    .join(" · ");
}

function displayTags(company) {
  return (company.tags || []).filter((tag) => tag !== "自動研究檔");
}

function displayThesis(company) {
  const thesis = String(company.thesis || "");
  const isResearchWorkflowNote = thesis.includes("已由選股宇宙升級為正式研究檔")
    && thesis.includes("分數依公開資料自動計算");
  return isResearchWorkflowNote ? "" : thesis;
}

function publicFactsFor(company) {
  const facts = (state.publicFactsData.companies?.[company.id]?.facts || [])
    .filter((item) => item?.label && item?.value && Array.isArray(item.source_ids) && item.source_ids.length);
  const factIds = new Set(facts.map((item) => item.id));
  const ownership = state.ownershipData.companies?.[company.id];
  const risk = state.riskData.companies?.[company.id];

  if (ownership?.status === "ok" && !factIds.has("governance_snapshot")) {
    const parts = [
      Number.isFinite(Number(ownership.major_shareholder_count)) ? `主要股東揭露 ${formatNumber(ownership.major_shareholder_count, 0)} 位` : "",
      Number.isFinite(Number(ownership.insider_transfer_count)) ? `內部人轉讓 ${formatNumber(ownership.insider_transfer_count, 0)} 筆` : ""
    ].filter(Boolean);
    if (parts.length) facts.push({
      id: "governance_snapshot",
      label: "股權與治理",
      value: `${parts.join("；")}。`,
      source_ids: ownership.source_ids || []
    });
  }

  if (risk?.status === "ok" && !factIds.has("event_risk_snapshot")) {
    const parts = [
      Number.isFinite(Number(risk.event_count)) ? `官方事件 ${formatNumber(risk.event_count, 0)} 則` : "",
      Number.isFinite(Number(risk.review_event_count)) && Number(risk.review_event_count) > 0 ? `待閱讀 ${formatNumber(risk.review_event_count, 0)} 則` : "",
      Number.isFinite(Number(risk.negative_event_count)) && Number(risk.negative_event_count) > 0 ? `重大負向 ${formatNumber(risk.negative_event_count, 0)} 則` : "",
      Number.isFinite(Number(risk.disclosure_violation_count)) ? `申報違規 ${formatNumber(risk.disclosure_violation_count, 0)} 筆` : ""
    ].filter(Boolean);
    if (parts.length) facts.push({
      id: "event_risk_snapshot",
      label: "事件與合規",
      value: `${parts.join("；")}。`,
      source_ids: risk.source_ids || []
    });
  }

  return facts;
}

function publicFactSourceIds(company) {
  return [...new Set(publicFactsFor(company).flatMap((item) => item.source_ids))];
}

function renderSourceTooltipsForFacts(facts, sourceIndex) {
  const grouped = new Map();
  for (const fact of facts) {
    for (const sourceId of fact.source_ids) {
      const source = sourceIndex[sourceId];
      if (!source) continue;
      if (!grouped.has(sourceId)) grouped.set(sourceId, { source, facts: [] });
      grouped.get(sourceId).facts.push(fact);
    }
  }

  if (!grouped.size) return "";

  return `
    <div class="fact-source-list" aria-label="公司資料來源摘要">
      ${[...grouped.values()].map(({ source, facts }) => {
        const title = source.short_title || source.title;
        const description = source.note || source.title;
        const accessibleLabel = `${title}：${description}`;
        return `
          <span class="fact-source-tooltip" tabindex="0" role="note" aria-label="${RadarRenderers.escapeHtml(accessibleLabel)}">
            <span class="source-chip source-chip-static">${RadarRenderers.escapeHtml(title)}</span>
            <span class="fact-tooltip-content" role="tooltip">
              <strong>${RadarRenderers.escapeHtml(source.title)}</strong>
              <span>${RadarRenderers.escapeHtml(description)}</span>
            </span>
          </span>
        `;
      }).join("")}
    </div>
  `;
}

function renderPublicFactSourceTooltips(company, sourceIndex) {
  return renderSourceTooltipsForFacts(publicFactsFor(company), sourceIndex);
}

function renderPublicFacts(company, sourceIndex, compact = false) {
  const facts = publicFactsFor(company);
  const visibleFacts = compact ? facts.slice(0, 2) : facts;
  if (!visibleFacts.length) return "";

  if (compact) {
    return visibleFacts.map((item) => `
      <span><b>${RadarRenderers.escapeHtml(item.label)}</b>：${RadarRenderers.escapeHtml(item.value)}</span>
    `).join("");
  }

  return `
    <section class="module">
      <h3>公開資料摘要</h3>
      <div class="module-grid">
        ${visibleFacts.map((item) => `
          <article class="field-card">
            <span class="field-label">${RadarRenderers.escapeHtml(item.label)}</span>
            <p>${RadarRenderers.escapeHtml(item.value)}</p>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function dataCoverageLabel(company) {
  const status = state.dataStatus.companies?.[company.id];
  if (!status) return "客觀資料待建立";
  return `客觀資料 ${status.completed_count}/${status.total_count}`;
}

function scoreColorStyle(score) {
  if (!score.complete) return "";
  const color = String(score.band?.color || "").trim();
  return color ? `--score-color:${RadarRenderers.escapeHtml(color)};` : "";
}

function scoreDisplayTitle(score) {
  if (!score.complete) return "研究中，尚未具備完整評分資料";
  const submetricCount = score.rows.reduce((sum, row) => sum + (row.submetrics?.length || 0), 0);
  const adjustment = Number(score.industryAdjustment || 0);
  const adjustmentText = adjustment ? `；產業調整 ${adjustment > 0 ? "+" : ""}${adjustment}` : "";
  return `${score.band.label}（核心 ${score.coreTotal}/100${adjustmentText}；綜合 ${score.total}/100；${submetricCount} 個公開資料子測項）`;
}

function scoreMissingLabel(score) {
  return (score.missingDimensions || [])
    .map((label) => label === "產業證據調整" ? "產業證據待補，不影響核心分數" : label)
    .join("、");
}

function industryRankLabel(company, score) {
  if (!score.complete) return "";
  const peers = state.companies
    .filter((item) => !item.__candidate && item.industry_template === company.industry_template)
    .map((item) => ({
      id: item.id,
      score: RadarScoring.computeCompanyScore(item, state.rules, scoringDatasets())
    }))
    .filter((item) => item.score.complete)
    .sort((left, right) => right.score.total - left.score.total);
  if (peers.length < 2) return "同業樣本累積中";
  const rank = peers.findIndex((item) => item.id === company.id) + 1;
  return `同業第 ${rank}/${peers.length}`;
}

function researchReadiness(company) {
  const status = state.researchStatus.companies?.[company.id];
  if (status) return status;
  const dataStatus = state.dataStatus.companies?.[company.id];
  const missing = [
    ["catalyst", "催化事件"], ["market", "股價位置/趨勢"], ["revenue", "營收動能"],
    ["financial", "現金/獲利品質"], ["ownership", "籌碼/股權結構"], ["risk", "新聞/重大訊息風險"], ["industry", "產業基本面"]
  ].filter(([id]) => dataStatus?.[id] !== "ok").map(([id, label]) => ({ id, label }));
  return { status: missing.length ? "incomplete" : "complete", missing_dimensions: missing };
}

function readinessLabel(company) {
  const readiness = researchReadiness(company);
  if (readiness.status === "complete") return "完成分析";
  if (readiness.status === "core_complete") return "核心完成";
  if (readiness.status === "analyzing") return "分析中";
  return "資料待補";
}

function filteredCompanies() {
  const query = $("#search-input").value.trim().toLowerCase();
  const industry = $("#industry-filter").value;
  const minimumScore = $("#score-filter").value;
  const sourceCompanies = universeSelectionMode() ? candidateWatchlistItems() : state.companies;

  const matches = sourceCompanies.filter((company) => {
    if (company.__candidate) {
      return (industry === "all" || company.industry_template === industry)
        && (!query || companyText(company).includes(query));
    }
    const score = RadarScoring.computeCompanyScore(company, state.rules, scoringDatasets()).total;
    return (industry === "all" || company.industry_template === industry)
      && (!query || companyText(company).includes(query))
      && (minimumScore === "all" || (Number.isFinite(score) && score >= Number(minimumScore)));
  });
  const researchCompanies = matches.filter((company) => !company.__candidate);
  const candidates = matches.filter((company) => company.__candidate);
  return [...orderedResearchCompanies(researchCompanies), ...candidates];
}

function renderAll() {
  const companies = filteredCompanies();
  if (!companies.some((company) => company.id === state.selectedId)) {
    state.selectedId = companies[0]?.id || null;
  }
  renderOnboarding();
  renderUniverseCandidates();
  renderSummary(companies);
  renderCompanyList(companies);
  renderCompanyManager();
  renderDetail();
  renderStandards();
  renderTimeline(companies);
  renderSources();
}

function latestDataTimestamp() {
  const timestamps = [
    state.publicFactsData.generated_at,
    state.marketData.generated_at,
    state.revenueData.generated_at,
    state.financialData.generated_at,
    state.catalystData.generated_at,
    state.riskData.generated_at,
    state.dataStatus.generated_at
  ].map((value) => Date.parse(value || "")).filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)) : null;
}

function formatDashboardTimestamp() {
  const timestamp = latestDataTimestamp();
  if (!timestamp) return "更新時間未提供";
  return timestamp.toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function renderSummary(companies) {
  const scoredCompanies = companies.filter((company) => !company.__candidate);
  const candidateOnlyCount = companies.length - scoredCompanies.length;
  const scores = scoredCompanies
    .map((company) => RadarScoring.computeCompanyScore(company, state.rules, scoringDatasets()).total)
    .filter(Number.isFinite);
  const average = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : "尚未評分";
  const researchInProgress = candidateOnlyCount + scoredCompanies.length - scores.length;
  const modeLabel = universeSelectionMode() ? "候選" : "公司";

  $("#company-count").textContent = `${companies.length} ${modeLabel}`;
  $("#visible-count").textContent = `${companies.length} 筆`;
  $("#last-updated").textContent = `資料更新：${formatDashboardTimestamp()}`;
  $("#summary-grid").innerHTML = [
    ["平均評分", average],
    ["完成研究", `${scores.length}/${companies.length}`],
    ["研究中", researchInProgress]
  ].map(([label, value]) => `<div class="metric"><span class="muted">${label}</span><strong>${value}</strong></div>`).join("");
}

function renderCandidateCard(company) {
  return `
    <article class="company-card candidate-only ${company.id === state.selectedId ? "active" : ""}" data-id="${company.id}" tabindex="0">
      <div class="candidate-score"><span>研究<br>中</span></div>
      <div>
        <p class="eyebrow">${RadarRenderers.escapeHtml(company.template_label || company.industry_template)} · 研究候選</p>
        <h3>${RadarRenderers.escapeHtml(company.name)}</h3>
        <p class="stock-meta">${RadarRenderers.escapeHtml(stockLabel(company))} · 公開資料蒐集中</p>
        <p class="muted">${RadarRenderers.escapeHtml(company.thesis)}</p>
        <div class="card-tags">${(company.tags || []).map((tag) => `<span class="tag">${RadarRenderers.escapeHtml(tag)}</span>`).join("")}</div>
      </div>
      <div class="mini-fields">
        <span><b>官方產業</b>：${RadarRenderers.escapeHtml(company.official_industry_label || "未提供")}</span>
        <span><b>狀態</b>：研究準備中</span>
        <button class="ghost-button" type="button" data-remove-candidate="${RadarRenderers.escapeHtml(company.ticker)}">移除</button>
      </div>
    </article>
  `;
}

function renderCompanyList(companies) {
  if (!companies.length) {
    $("#company-list").innerHTML = `<p class="muted">目前沒有符合條件的公司。</p>`;
    return;
  }

  $("#company-list").innerHTML = companies.map((company) => {
    if (company.__candidate) return renderCandidateCard(company);

    const template = state.templates[company.industry_template];
    const score = RadarScoring.computeCompanyScore(company, state.rules, scoringDatasets());
    const summary = renderPublicFacts(company, {}, true);

    const readiness = researchReadiness(company);
    const missingLabels = (readiness.missing_dimensions || []).map((item) => item.label).join("、");
    const scoreValue = Number.isFinite(score.total) ? score.total : "待補";
    return `
      <article class="company-card ${company.id === state.selectedId ? "active" : ""} ${score.complete ? "" : "incomplete"}" data-id="${company.id}" tabindex="0" style="--score-deg:${Number.isFinite(score.total) ? score.total * 3.6 : 0}deg;${scoreColorStyle(score)}">
        <div class="score-ring" title="${RadarRenderers.escapeHtml(score.complete ? scoreDisplayTitle(score) : readinessLabel(company))}"><span>${scoreValue}</span></div>
        <div>
          <p class="eyebrow">${RadarRenderers.escapeHtml(template.label)} · ${RadarRenderers.escapeHtml(score.complete ? score.band.label : readinessLabel(company))}</p>
          <h3>${RadarRenderers.escapeHtml(company.name)}</h3>
          <p class="stock-meta">${RadarRenderers.escapeHtml(stockLabel(company))}</p>
          ${score.complete ? "" : `<p class="muted">缺少：${RadarRenderers.escapeHtml(scoreMissingLabel(score) || missingLabels || "評分資料")}</p>`}
          <div class="card-tags">${displayTags(company).map((tag) => `<span class="tag">${RadarRenderers.escapeHtml(tag)}</span>`).join("")}</div>
        </div>
        <div class="mini-fields">${summary}</div>
      </article>
    `;
  }).join("");

  document.querySelectorAll(".company-card").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target?.dataset?.removeCandidate) return;
      selectCompany(card.dataset.id);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter") selectCompany(card.dataset.id);
    });
  });
}

function selectCompany(id) {
  state.selectedId = id;
  renderAll();
}

function renderCandidateDetail(company) {
  $("#company-detail").className = "detail-content";
  $("#company-detail").innerHTML = `
    <div class="detail-title">
      <div>
        <p class="eyebrow">Research Candidate</p>
        <h2>${RadarRenderers.escapeHtml(company.name)}</h2>
        <p class="stock-meta">${RadarRenderers.escapeHtml(stockLabel(company))} · ${RadarRenderers.escapeHtml(company.template_label || company.industry_template)}</p>
        <p class="muted">公開資料正在整理中；完成後將顯示評分與可追溯的資料來源。</p>
      </div>
      <span class="pill">研究中</span>
    </div>
    <section class="module">
      <h3>研究狀態</h3>
      <p>正在蒐集股價、營收、財務、公告與產業資料；資料齊備並完成驗證後才會顯示評分。</p>
    </section>
    <section class="module">
      <h3>官方分類</h3>
      <div class="module-grid">
        <div class="fact"><div class="fact-label">股票代號</div><div class="fact-value">${RadarRenderers.escapeHtml(company.ticker)}</div></div>
        <div class="fact"><div class="fact-label">市場</div><div class="fact-value">${RadarRenderers.escapeHtml(company.market_label || company.market)}</div></div>
        <div class="fact"><div class="fact-label">官方產業</div><div class="fact-value">${RadarRenderers.escapeHtml(company.official_industry_label || "未提供")}</div></div>
        <div class="fact"><div class="fact-label">初步模板</div><div class="fact-value">${RadarRenderers.escapeHtml(company.template_label || company.industry_template)}</div></div>
      </div>
    </section>
  `;
}

function renderCollectedEvents(company) {
  let record = state.researchCache.records[company.ticker];
  const indexed = (state.researchCache.index.companies || []).find((item) => item.ticker === company.ticker);
  if (!record) {
    const text = state.researchCache.pending.has(company.ticker)
      ? "正在載入公告事件..."
      : indexed
        ? "公告事件快取已建立，正在載入。"
        : "尚未建立公告事件快取。可使用「更新公告事件」開始蒐集。";
    return `<section class="module collected-events"><h3>官方公告事件</h3><p class="muted">${text}</p></section>`;
  }

  const collectedAt = record.collected_at ? new Date(record.collected_at) : null;
  const collectedLabel = collectedAt && !Number.isNaN(collectedAt.getTime())
    ? collectedAt.toLocaleString("zh-TW", { dateStyle: "medium", timeStyle: "short" })
    : "尚未記錄";
  record = { ...record, collected_at: collectedLabel };

  const eventItems = (record.events || []).map((event) => {
    const title = normalizeDisclosureText(event.title);
    const clause = normalizeDisclosureText(event.clause);
    const description = normalizeDisclosureText(event.description);
    return `
      <article class="collector-event">
        <div class="collector-event-head">
          <span class="timeline-date">${RadarRenderers.escapeHtml(event.date || "未提供日期")}</span>
          <span class="tag">${RadarRenderers.escapeHtml(event.claim_type || "official_disclosure")}</span>
        </div>
        <strong>${RadarRenderers.escapeHtml(title)}</strong>
        ${clause ? `<p class="muted">${RadarRenderers.escapeHtml(clause)}</p>` : ""}
        ${description ? `<details class="collector-event-detail"><summary>查看完整公告</summary><p>${RadarRenderers.escapeHtml(description)}</p></details>` : `<p class="muted">此筆公告目前僅取得標題與日期。</p>`}
      </article>
    `;
  }).join("");
  const references = (record.references || [])
    .filter((reference) => reference.source_id !== "mops_history_search")
    .map((reference) => `<a class="source-chip" href="${RadarRenderers.escapeHtml(reference.url)}" target="_blank" rel="noopener">${RadarRenderers.escapeHtml(reference.title)}</a>`)
    .join("");
  const sourceStatus = "公告內容由公開資訊觀測站蒐集並快取；可展開查看完整已擷取內容。";

  return `
    <section class="module collected-events">
      <h3>官方公告事件 <span class="muted">${RadarRenderers.escapeHtml(record.collected_at || "")}</span></h3>
      <p class="muted">${RadarRenderers.escapeHtml(sourceStatus || "尚無來源狀態")}</p>
      <div class="collector-event-list">${eventItems || "<p class=\"muted\">近期交易所重大訊息快取未找到此公司的公告；可透過 MOPS 歷史重大訊息連結進一步覆核。</p>"}</div>
      <div class="source-links">${references}</div>
    </section>
  `;
}

function renderDetail() {
  const company = companyById(state.selectedId);
  if (!company) {
    $("#company-detail").className = "detail-empty";
    $("#company-detail").innerHTML = `
      <p class="eyebrow">Company File</p>
      <h2>尚未選取公司</h2>
      <p>請從左側觀察清單選取公司，或在上方載入研究候選。</p>
    `;
    return;
  }
  if (company.__candidate) {
    renderCandidateDetail(company);
    return;
  }

  const template = state.templates[company.industry_template];
  const score = RadarScoring.computeCompanyScore(company, state.rules, scoringDatasets());
  const sourceIndex = sourceIndexFor(company);
  const dataSnapshot = renderDataSnapshot(company, sourceIndex);
  const publicFacts = renderPublicFacts(company, sourceIndex);

  $("#company-detail").className = "detail-content";
  $("#company-detail").innerHTML = `
    <div class="detail-title">
      <div>
        <p class="eyebrow">${RadarRenderers.escapeHtml(template.label)} · ${RadarRenderers.escapeHtml(score.band.label)}</p>
        <h2>${RadarRenderers.escapeHtml(company.name)}</h2>
        <p class="stock-meta">${RadarRenderers.escapeHtml(stockLabel(company))}${company.legal_name ? ` · ${RadarRenderers.escapeHtml(company.legal_name)}` : ""}</p>
        <p class="muted">資料更新：${RadarRenderers.escapeHtml(company.last_reviewed || "未提供")}</p>
      </div>
      <span class="pill score-tier" title="${RadarRenderers.escapeHtml(scoreDisplayTitle(score))}" style="${scoreColorStyle(score)}">${Number.isFinite(score.total) ? `${score.total} · ${RadarRenderers.escapeHtml(score.band.label)}` : readinessLabel(company)}</span>
    </div>
    ${publicFacts}
    ${score.complete ? "" : `<p class="risk">尚未產生核心分數。缺少：${RadarRenderers.escapeHtml(scoreMissingLabel(score))}</p>`}
    <div class="score-breakdown">${RadarRenderers.renderScoreRows(score)}</div>
    <details class="detail-fold">
      <summary>公開資料快照</summary>
      ${dataSnapshot}
    </details>
    ${renderCollectedEvents(company)}
    <section class="module">
      <h3>評分理由</h3>
      ${score.rows.map((row) => `<p><b>${RadarRenderers.escapeHtml(row.label)}</b>：${RadarRenderers.escapeHtml(row.rationale)}</p>`).join("")}
    </section>
  `;
  loadResearchCacheFor(company);
}

function formatNumber(value, suffix = "") {
  if (!Number.isFinite(Number(value))) return "尚無資料";
  return `${Number(value).toLocaleString("zh-TW")}${suffix}`;
}

function formatPercent(value) {
  return formatNumber(value, "%");
}

function majorShareholderLabel(ownership) {
  const names = (ownership?.major_shareholders || [])
    .map((holder) => String(holder?.name || "").trim())
    .filter(Boolean);
  return names.length ? names.join("、") : `${formatNumber(ownership?.major_shareholder_count)} 名`;
}

function normalizeDisclosureText(value) {
  let text = String(value || "").replace(/\uFEFF/g, "");
  const looksMojibake = /[\u0080-\u009F\u00C2\u00C3\u00E5-\u00E9]/.test(text);
  const canReDecode = [...text].every((character) => character.charCodeAt(0) <= 255);
  if (looksMojibake && canReDecode) {
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(text, (character) => character.charCodeAt(0)));
      if (/[^\x00-\x7F]/.test(decoded)) text = decoded;
    } catch {
      // Preserve source text when it is not recoverable UTF-8 mojibake.
    }
  }
  return text
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderDataSnapshot(company, sourceIndex) {
  const market = state.marketData.companies?.[company.id];
  const revenue = state.revenueData.companies?.[company.id];
  const financial = state.financialData.companies?.[company.id];
  const catalyst = state.catalystData.companies?.[company.id];
  const ownership = state.ownershipData.companies?.[company.id];
  const risk = state.riskData.companies?.[company.id];
  const status = state.dataStatus.companies?.[company.id];
  const statusText = status ? `${status.completed_count}/${status.total_count} 類資料已接入` : "資料狀態未建立";

  const cards = [
    {
      title: "催化事件",
      sourceIds: catalyst?.source_ids,
      rows: [
        ["分數", formatNumber(catalyst?.score)],
        ["重大訊息", `${formatNumber(catalyst?.event_count)} 則`],
        ["正向/負向", `${formatNumber(catalyst?.positive_event_count)} / ${formatNumber(catalyst?.negative_event_count)}`],
        ["理由", catalyst?.rationale || "尚無資料"]
      ]
    },
    {
      title: "股價/趨勢",
      sourceIds: market?.source_ids,
      rows: [
        ["最近收盤", `${formatNumber(market?.latest_close)} (${RadarRenderers.escapeHtml(market?.latest_trade_date || "日期待補")})`],
        ["一年區間", `${formatNumber(market?.year_low)} - ${formatNumber(market?.year_high)}`],
        ["區間位置", formatPercent(market?.position_pct)],
        ["20/60 日報酬", `${formatPercent(market?.return_20d_pct)} / ${formatPercent(market?.return_60d_pct)}`]
      ]
    },
    {
      title: "月營收",
      sourceIds: revenue?.source_ids,
      rows: [
        ["資料月份", revenue?.data_month || "尚無資料"],
        ["當月營收", `${formatNumber(revenue?.current_revenue_thousand_twd)} 千元`],
        ["YoY / MoM", `${formatPercent(revenue?.yoy_pct)} / ${formatPercent(revenue?.mom_pct)}`],
        ["累計 YoY", formatPercent(revenue?.cumulative_yoy_pct)]
      ]
    },
    {
      title: "財務品質",
      sourceIds: financial?.source_ids,
      rows: company.industry_template === "financial"
        ? [
            ["財報類型", financial?.financial_report_profile_label || "金融專用財報"],
            ["季度", financial?.year && financial?.quarter ? `${financial.year}Q${financial.quarter}` : "尚無資料"],
            ["年化 ROE / ROA", `${formatPercent(financial?.annualized_roe_pct)} / ${formatPercent(financial?.annualized_roa_pct)}`],
            ["權益比率 / EPS", `${formatPercent(financial?.equity_ratio_pct)} / ${formatNumber(financial?.eps)}`]
          ]
        : [
            ["季度", financial?.year && financial?.quarter ? `${financial.year}Q${financial.quarter}` : "尚無資料"],
            ["毛利/營益率", `${formatPercent(financial?.gross_margin_pct)} / ${formatPercent(financial?.operating_margin_pct)}`],
            ["流動比率", formatNumber(financial?.current_ratio)],
            ["負債比率 / EPS", `${formatPercent(financial?.debt_ratio_pct)} / ${formatNumber(financial?.eps)}`]
          ]
    },
    {
      title: "籌碼/股權",
      sourceIds: ownership?.source_ids,
      rows: [
        ["分數", formatNumber(ownership?.score)],
        ["大股東", majorShareholderLabel(ownership)],
        ["內部人轉讓", `${formatNumber(ownership?.insider_transfer_count)} 筆`],
        ["理由", ownership?.rationale || "尚無資料"]
      ]
    },
    {
      title: "風險訊號",
      sourceIds: risk?.source_ids,
      rows: [
        ["分數", formatNumber(risk?.score)],
        ["負向訊息", `${formatNumber(risk?.negative_event_count)} 則`],
        ["申報違規", `${formatNumber(risk?.disclosure_violation_count)} 筆`],
        ["理由", risk?.rationale || "尚無資料"]
      ]
    }
  ];

  return `
    <section class="module">
      <h3>客觀資料快照 <span class="muted">${RadarRenderers.escapeHtml(statusText)}</span></h3>
      <div class="data-grid">
        ${cards.map((card) => `
          <article class="data-card">
            <div class="data-card-heading">
              <strong>${RadarRenderers.escapeHtml(card.title)}</strong>
              ${RadarRenderers.sourceLinks(card.sourceIds, sourceIndex)}
            </div>
            ${card.rows.map(([label, value]) => `
              <div class="data-row">
                <span>${RadarRenderers.escapeHtml(label)}</span>
                <b>${RadarRenderers.escapeHtml(value)}</b>
              </div>
            `).join("")}
          </article>
        `).join("")}
      </div>
      <p class="muted">各卡僅呈現已接入的公開資料；若官方 API 暫時失敗，更新腳本會使用上一版快取資料並保留資料狀態。</p>
    </section>
  `;
}

function renderStandards() {
  const industry = $("#industry-filter").value;
  const template = industry === "all" ? null : state.templates[industry];
  const standardsCompany = template ? { industry_template: template.id } : null;
  const standardsDimensions = standardsCompany
    ? RadarScoring.dimensionsFor(standardsCompany, state.rules)
    : state.rules.common_dimensions;
  const commonCards = standardsDimensions.map((dimension) => `
    <article class="standard-card">
      <strong>${RadarRenderers.escapeHtml(dimension.label)} · ${Math.round(dimension.weight * 100)}%</strong>
      <p>${RadarRenderers.escapeHtml(dimension.description)}</p>
      <p class="muted">高分條件：${RadarRenderers.escapeHtml(dimension.high_score_signal)}</p>
      ${dimension.submetrics?.length ? `<div class="card-tags">${dimension.submetrics.map((metric) => `<span class="tag">${RadarRenderers.escapeHtml(metric.label)}</span>`).join("")}</div>` : ""}
    </article>
  `).join("");

  const industryEvidence = template?.industry_evidence_dimensions || [];
  const industryCard = template ? `
    <article class="standard-card industry-card">
      <strong>${RadarRenderers.escapeHtml(template.label)} · 產業基本面子檢核</strong>
      <p>${RadarRenderers.escapeHtml(template.description)}</p>
      <div class="card-tags">${template.industry_quality_checks.map((check) => `<span class="tag">${RadarRenderers.escapeHtml(check)}</span>`).join("")}</div>
      <div class="standard-dimensions">
        ${industryEvidence.map((dimension) => `
          <div>
            <b>${RadarRenderers.escapeHtml(dimension.label)} · ${Math.round((dimension.weight || 0) * 100)}%</b>
            <p class="muted">${RadarRenderers.escapeHtml(dimension.description || "")}</p>
          </div>
        `).join("")}
      </div>
    </article>
  ` : `
    <article class="standard-card industry-card">
      <strong>產業模板層</strong>
      <p>選擇單一產業後，這裡會顯示該產業的基本面子檢核。產業基本面目前已由營收、財務、風險、催化與來源可追溯度合成。</p>
    </article>
  `;

  $("#standards-grid").innerHTML = industryCard + commonCards;
}

function objectiveSignalsFor(company) {
  if (company.__candidate) return [];
  const id = company.id;
  const signals = [];
  const revenue = state.revenueData.companies?.[id];
  const market = state.marketData.companies?.[id];
  const financial = state.financialData.companies?.[id];
  const catalyst = state.catalystData.companies?.[id];
  const risk = state.riskData.companies?.[id];
  const industry = state.industryData.companies?.[id];

  if (revenue?.status === "ok") {
    signals.push({
      date: revenue.data_month || state.revenueData.generated_at?.slice(0, 10) || "",
      type: "營收",
      company: company.name,
      title: `月營收 YoY ${formatPercent(revenue.yoy_pct)}，MoM ${formatPercent(revenue.mom_pct)}，營收動能分數 ${formatNumber(revenue.score)}`,
      impact: "objective"
    });
  }

  if (market?.status === "ok") {
    signals.push({
      date: market.latest_trade_date || state.marketData.generated_at?.slice(0, 10) || "",
      type: "股價",
      company: company.name,
      title: `收盤 ${formatNumber(market.latest_close)}，20日報酬 ${formatPercent(market.return_20d_pct)}，60日報酬 ${formatPercent(market.return_60d_pct)}`,
      impact: "objective"
    });
  }

  if (financial?.status === "ok") {
    signals.push({
      date: financial.year && financial.quarter ? `${financial.year}Q${financial.quarter}` : state.financialData.generated_at?.slice(0, 10) || "",
      type: "財務",
      company: company.name,
      title: company.industry_template === "financial"
        ? `年化 ROE ${formatPercent(financial.annualized_roe_pct)}，年化 ROA ${formatPercent(financial.annualized_roa_pct)}，EPS ${formatNumber(financial.eps)}`
        : `毛利率 ${formatPercent(financial.gross_margin_pct)}，營益率 ${formatPercent(financial.operating_margin_pct)}，EPS ${formatNumber(financial.eps)}`,
      impact: "objective"
    });
  }

  for (const event of catalyst?.events || []) {
    signals.push({
      date: event.announce_date || event.date || state.catalystData.generated_at?.slice(0, 10) || "",
      type: "重大訊息",
      company: company.name,
      title: event.title || event.description || "重大訊息",
      impact: event.sentiment || "objective"
    });
  }

  for (const event of risk?.events || []) {
    signals.push({
      date: event.announce_date || event.date || state.riskData.generated_at?.slice(0, 10) || "",
      type: "風險",
      company: company.name,
      title: event.title || event.description || "風險事件",
      impact: event.sentiment || "risk"
    });
  }

  for (const violation of risk?.violations || []) {
    signals.push({
      date: violation.date || state.riskData.generated_at?.slice(0, 10) || "",
      type: "揭露違規",
      company: company.name,
      title: violation.title || "資訊揭露違規",
      impact: "risk"
    });
  }

  if (industry?.status === "ok") {
    signals.push({
      date: state.industryData.generated_at?.slice(0, 10) || "",
      type: "產業分數",
      company: company.name,
      title: `產業綜合分數 ${formatNumber(industry.score)}，產業證據 ${formatNumber(industry.industry_evidence_score)}，可追蹤性 ${formatNumber(industry.traceability_score)}`,
      impact: "objective"
    });
  }

  return signals.filter((signal) => signal.date);
}

function renderTimeline(companies) {
  {
    const timeline = companies
      .flatMap(objectiveSignalsFor)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 40);

    $("#timeline").innerHTML = timeline.length ? timeline.map((event) => `
      <article class="timeline-item">
        <span class="timeline-date">${RadarRenderers.escapeHtml(event.date)}</span>
        <div>
          <b>${RadarRenderers.escapeHtml(event.company)}</b>
          <p class="muted">${RadarRenderers.escapeHtml(event.title)}</p>
        </div>
        <span class="tag">${RadarRenderers.escapeHtml(event.type)}</span>
      </article>
    `).join("") : `<p class="muted">目前沒有已接入的近期觀察訊號。</p>`;
    return;
  }

  const companyIds = new Set(companies.map((company) => company.id));
  const events = companies.flatMap((company) => (company.events || []).map((event) => ({
    ...event,
    company: company.name,
    impact: "event",
    confidence: "manual"
  })));
  const signals = state.signals
    .filter((signal) => companyIds.has(signal.company_id))
    .map((signal) => {
      const company = state.companies.find((item) => item.id === signal.company_id);
      return {
        date: signal.date,
        type: signal.type,
        title: signal.title,
        company: company?.name || signal.company_id,
        impact: signal.impact,
        confidence: signal.confidence
      };
    });

  const timeline = [...events, ...signals].sort((a, b) => a.date.localeCompare(b.date));

  $("#timeline").innerHTML = timeline.length ? timeline.map((event) => `
    <article class="timeline-item">
      <span class="timeline-date">${RadarRenderers.escapeHtml(event.date)}</span>
      <div>
        <b>${RadarRenderers.escapeHtml(event.company)}</b>
        <p class="muted">${RadarRenderers.escapeHtml(event.title)}</p>
      </div>
      <span class="tag">${RadarRenderers.escapeHtml(event.type)}</span>
    </article>
  `).join("") : `<p class="muted">尚無事件。</p>`;
}

function renderSources() {
  const uniqueSources = Object.values(state.referenceSources.reduce((index, source) => {
    index[source.id] = source;
    return index;
  }, {}));
  $("#source-list").innerHTML = uniqueSources.map((source) => `
    <article class="source-item">
      <a href="${RadarRenderers.escapeHtml(source.url)}" target="_blank" rel="noopener">${RadarRenderers.escapeHtml(source.title)}</a>
      <p class="muted">${RadarRenderers.escapeHtml(source.note)}</p>
    </article>
  `).join("");
}
