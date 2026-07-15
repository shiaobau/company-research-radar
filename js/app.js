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
  universe: { companies: [] },
  researchCache: { index: { companies: [] }, records: {}, pending: new Set() },
  schedulerStatus: { schedules: {}, current_run: null },
  referenceSources: [],
  selectedId: null
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
  fetch("data/listed_companies_universe.json").then((response) => response.json()).catch(() => ({ companies: [] })),
  fetch("data/research_cache/index.json").then((response) => response.json()).catch(() => ({ companies: [] })),
  fetch("data/scheduler_status.json").then((response) => response.json()).catch(() => ({ schedules: {}, current_run: null }))
]).then(([templates, definitions, rules, companies, signals, marketData, revenueData, financialData, catalystData, ownershipData, riskData, industryEvidenceData, industryData, dataStatus, universe, researchCacheIndex, schedulerStatus]) => {
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
  state.universe = universe;
  state.researchCache.index = researchCacheIndex;
  state.schedulerStatus = schedulerStatus;
  state.referenceSources = [
    ...(companies.reference_sources || []),
    ...(marketData.sources || []),
    ...(revenueData.sources || []),
    ...(financialData.sources || []),
    ...(catalystData.sources || []),
    ...(ownershipData.sources || []),
    ...(riskData.sources || []),
    ...(industryEvidenceData.sources || []),
    ...(industryData.sources || [])
  ];
  state.signals = signals.signals || [];
  initControls();
  state.selectedId = universeSelectionMode()
    ? candidateWatchlistItems()[0]?.id || state.companies[0]?.id || null
    : state.companies[0]?.id || null;
  renderAll();
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
      thesis: "已加入研究候選，尚未建立正式研究檔與評分資料。",
      tags: ["研究候選", "待建立研究檔"],
      official
    };
  });
}

function companyById(id) {
  return state.companies.find((item) => item.id === id)
    || candidateWatchlistItems().find((item) => item.id === id);
}

function ensureCandidatePanel() {
  let panel = $("#universe-candidate-panel");
  if (panel) return panel;
  panel = document.createElement("section");
  panel.id = "universe-candidate-panel";
  panel.className = "section-block";
  const anchor = $("#summary-grid");
  anchor.parentNode.insertBefore(panel, anchor);
  return panel;
}

function renderUniverseCandidates() {
  const panel = ensureCandidatePanel();
  const candidates = selectedUniverseCompanies();
  if (!candidates.length) {
    if (!universeSelectionMode()) {
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
        <a class="ghost-button" href="universe.html">回選股頁</a>
      </div>
      <p class="muted">目前沒有讀到候選代號。請回選股頁勾選公司後按「送到主頁」，或使用包含 tickers 參數的網址。</p>
    `;
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
        <a class="ghost-button" href="universe.html">回選股頁</a>
      </div>
    </div>
    <div class="candidate-list">
      ${candidates.map(({ ticker, official, research }) => {
        const name = research?.name || official?.abbreviation || official?.name || ticker;
        const template = state.templates[research?.industry_template]?.label || official?.template_label || "待分類";
        const status = research ? "已在研究檔" : "待建立研究檔";
        return `
          <span class="candidate-chip" title="${RadarRenderers.escapeHtml(template)} / ${RadarRenderers.escapeHtml(status)}">
            <b>${RadarRenderers.escapeHtml(ticker)}</b>
            ${RadarRenderers.escapeHtml(name)}
            <em>${RadarRenderers.escapeHtml(status)}</em>
            <button class="candidate-remove" type="button" data-remove-candidate="${RadarRenderers.escapeHtml(ticker)}" aria-label="移除 ${RadarRenderers.escapeHtml(ticker)}">x</button>
          </span>
        `;
      }).join("")}
    </div>
    <p class="muted">這裡只呈現你在選股宇宙頁勾選的候選名單；正式評分仍只針對已加入 data/companies.json 且已接資料的公司。</p>
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

async function deleteResearchCompany(ticker) {
  if (!ticker) return;
  const confirmed = window.confirm(`確定要刪除 ${ticker} 的觀察研究檔嗎？這會從本機 JSON 研究資料移除。`);
  if (!confirmed) return;
  setResearchStatus(`刪除 ${ticker} 中...`);
  try {
    const response = await fetch(`/api/company?ticker=${encodeURIComponent(ticker)}`, { method: "DELETE" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "刪除失敗");
    setCandidateTickers(selectedUniverseTickers().filter((item) => item !== ticker));
    setResearchStatus(`${ticker} 已刪除，正在重新整理...`);
    window.location.reload();
  } catch (error) {
    setResearchStatus(`無法刪除 ${ticker}：${error.message}`);
  }
}

async function pollResearchStatus() {
  try {
    const response = await fetch("/api/research/status");
    if (!response.ok) return;
    const status = await response.json();
    if (status.status === "idle") return;
    setResearchStatus(`${status.message}${status.tickers?.length ? `（${status.tickers.join(", ")}）` : ""}`);
    if (status.status === "running") {
      setTimeout(pollResearchStatus, 2500);
    }
    if (status.status === "done") {
      setResearchStatus(`${status.message}，請重新整理主頁查看最新分數。`);
    }
  } catch {
    // 靜態伺服器沒有 API 時保持安靜，避免干擾一般瀏覽。
  }
}

async function startResearchFromDashboard() {
  const tickers = selectedUniverseTickers();
  if (!tickers.length) {
    setResearchStatus("請先載入候選代號或候選種子檔。");
    return;
  }

  setResearchStatus("研究流程啟動中...");
  try {
    const response = await fetch("/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tickers })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || "研究 API 無法啟動");
    setResearchStatus(`研究流程已啟動：${tickers.join(", ")}`);
    setTimeout(pollResearchStatus, 1200);
  } catch (error) {
    setResearchStatus(`目前使用的是靜態伺服器，請改用動態研究伺服器後再按開始研究。${error.message}`);
  }
}

function ensureCollectorControls() {
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
  const order = ["morning", "market_close", "evening"];
  const active = state.schedulerStatus.current_run;
  panel.innerHTML = `
    <details class="scheduler-details">
      <summary>
        <span>
          <span class="eyebrow">Automatic Updates</span>
          <strong>每日研究更新</strong>
        </span>
        <span class="pill">${active ? "更新中" : "平日更新"}</span>
      </summary>
      <div class="scheduler-content">
        <div class="scheduler-heading">
      <div>
        <p class="eyebrow">Automatic Updates</p>
        <h2>每日研究更新</h2>
      </div>
      <span class="pill">${active ? "更新中" : "平日"}</span>
    </div>
    <div class="scheduler-grid">
      ${order.map((id) => {
        const schedule = schedules[id] || {};
        const run = schedule.last_run;
        return `
          <article class="scheduler-card ${run?.status || "idle"}">
            <div><strong>${RadarRenderers.escapeHtml(schedule.time || "--:--")}</strong><span>${RadarRenderers.escapeHtml(schedule.label || id)}</span></div>
            <p>${RadarRenderers.escapeHtml(schedule.description || "")}</p>
            <small>${RadarRenderers.escapeHtml(schedulerRunLabel(run))}</small>
          </article>
        `;
      }).join("")}
    </div>
      </div>
    </details>
  `;
}

async function refreshSchedulerStatus() {
  try {
    const response = await fetch("data/scheduler_status.json", { cache: "no-store" });
    if (!response.ok) return;
    state.schedulerStatus = await response.json();
    renderSchedulerPanel();
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
    const ticker = event.target?.dataset?.removeCandidate;
    if (ticker) removeUniverseCandidate(ticker);
    const deleteTicker = event.target?.dataset?.deleteResearch;
    if (deleteTicker) deleteResearchCompany(deleteTicker);
  });

  ensureCollectorControls();
  ensureOnboardingPanel();
  ensureSchedulerPanel();
  setupCollapsibleSections();
  pollResearchStatus();
  pollCollectorStatus();
  refreshSchedulerStatus();
  setInterval(refreshSchedulerStatus, 60000);
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

function dataCoverageLabel(company) {
  const status = state.dataStatus.companies?.[company.id];
  if (!status) return "客觀資料待建立";
  return `客觀資料 ${status.completed_count}/${status.total_count}`;
}

function filteredCompanies() {
  const query = $("#search-input").value.trim().toLowerCase();
  const industry = $("#industry-filter").value;
  const minimumScore = $("#score-filter").value;
  const sourceCompanies = universeSelectionMode() ? candidateWatchlistItems() : state.companies;

  return sourceCompanies.filter((company) => {
    if (company.__candidate) {
      return (industry === "all" || company.industry_template === industry)
        && (!query || companyText(company).includes(query));
    }
    const score = RadarScoring.computeCompanyScore(company, state.rules, scoringDatasets()).total;
    return (industry === "all" || company.industry_template === industry)
      && (!query || companyText(company).includes(query))
      && (minimumScore === "all" || score >= Number(minimumScore));
  });
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
  renderDetail();
  renderStandards();
  renderTimeline(companies);
  renderSources();
}

function renderSummary(companies) {
  {
  const scoredCompanies = companies.filter((company) => !company.__candidate);
  const candidateOnlyCount = companies.length - scoredCompanies.length;
  const scores = scoredCompanies.map((company) => RadarScoring.computeCompanyScore(company, state.rules, scoringDatasets()).total);
  const average = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : "尚未評分";
  const activeSignals = scoredCompanies.flatMap(objectiveSignalsFor).length;
  const dataCoverage = scoredCompanies.reduce((sum, company) => sum + (state.dataStatus.companies?.[company.id]?.completed_count || 0), 0);
  const totalCoverage = scoredCompanies.reduce((sum, company) => sum + (state.dataStatus.companies?.[company.id]?.total_count || 6), 0);
  const modeLabel = universeSelectionMode() ? "候選" : "公司";

  $("#company-count").textContent = `${companies.length} ${modeLabel}`;
  $("#visible-count").textContent = `${companies.length} 筆`;
  $("#last-updated").textContent = `更新：${new Date().toLocaleDateString("zh-TW")}`;
  $("#summary-grid").innerHTML = [
    ["平均評分", average],
    ["已正式評分", scoredCompanies.length],
    ["待建立研究檔", candidateOnlyCount],
    ["資料覆蓋", scoredCompanies.length ? `${dataCoverage}/${totalCoverage}` : "尚未接資料"],
    ["追蹤訊號", activeSignals]
  ].map(([label, value]) => `<div class="metric"><span class="muted">${label}</span><strong>${value}</strong></div>`).join("");
  return;
  }

  const scoredCompanies = companies.filter((company) => !company.__candidate);
  const scores = scoredCompanies.map((company) => RadarScoring.computeCompanyScore(company, state.rules, scoringDatasets()).total);
  const average = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
  const highEvidence = scoredCompanies.filter((company) => RadarScoring.computeCompanyScore(company, state.rules, scoringDatasets()).rows.some((row) => row.evidenceLevel === "high")).length;
  const openRisks = scoredCompanies.reduce((sum, company) => sum + ((company.risks || []).length), 0);
  const activeSignals = state.signals.filter((signal) => scoredCompanies.some((company) => company.id === signal.company_id)).length;
  const dataCoverage = scoredCompanies.reduce((sum, company) => sum + (state.dataStatus.companies?.[company.id]?.completed_count || 0), 0);
  const totalCoverage = scoredCompanies.reduce((sum, company) => sum + (state.dataStatus.companies?.[company.id]?.total_count || 6), 0);

  $("#company-count").textContent = `${state.companies.length} 家公司`;
  $("#visible-count").textContent = `${companies.length} 筆`;
  $("#last-updated").textContent = `更新：${new Date().toLocaleDateString("zh-TW")}`;
  $("#summary-grid").innerHTML = [
    ["平均評分", average],
    ["高證據項目", highEvidence],
    ["待追風險", openRisks],
    ["客觀資料", `${dataCoverage}/${totalCoverage}`],
    ["訊號數", activeSignals]
  ].map(([label, value]) => `<div class="metric"><span class="muted">${label}</span><strong>${value}</strong></div>`).join("");
}

function renderCandidateCard(company) {
  return `
    <article class="company-card candidate-only ${company.id === state.selectedId ? "active" : ""}" data-id="${company.id}" tabindex="0">
      <div class="candidate-score"><span>待<br>建檔</span></div>
      <div>
        <p class="eyebrow">${RadarRenderers.escapeHtml(company.template_label || company.industry_template)} · 研究候選</p>
        <h3>${RadarRenderers.escapeHtml(company.name)}</h3>
        <p class="stock-meta">${RadarRenderers.escapeHtml(stockLabel(company))} · 尚未建立評分資料</p>
        <p class="muted">${RadarRenderers.escapeHtml(company.thesis)}</p>
        <div class="card-tags">${(company.tags || []).map((tag) => `<span class="tag">${RadarRenderers.escapeHtml(tag)}</span>`).join("")}</div>
      </div>
      <div class="mini-fields">
        <span><b>官方產業</b>：${RadarRenderers.escapeHtml(company.official_industry_label || "未提供")}</span>
        <span><b>狀態</b>：待加入 data/companies.json</span>
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
    const sourceIndex = sourceIndexFor(company);
    const summary = (template.summary_fields || []).map((fieldId) => {
      const fact = RadarRenderers.getFact(company, fieldId);
      const definition = state.definitions[fieldId] || { label: fieldId };
      return `<span><b>${RadarRenderers.escapeHtml(definition.label)}</b>：${RadarRenderers.escapeHtml(RadarRenderers.formatFactValue(fact, definition))}</span>`;
    }).join("");

    return `
      <article class="company-card ${company.id === state.selectedId ? "active" : ""}" data-id="${company.id}" tabindex="0" style="--score-deg:${score.total * 3.6}deg">
        <div class="score-ring"><span>${score.total}</span></div>
        <div>
          <p class="eyebrow">${RadarRenderers.escapeHtml(template.label)} · ${RadarRenderers.escapeHtml(score.band.label)}</p>
          <h3>${RadarRenderers.escapeHtml(company.name)}</h3>
          <p class="stock-meta">${RadarRenderers.escapeHtml(stockLabel(company))} · ${RadarRenderers.escapeHtml(dataCoverageLabel(company))}</p>
          <p class="muted">${RadarRenderers.escapeHtml(company.thesis)}</p>
          <div class="card-tags">${(company.tags || []).map((tag) => `<span class="tag">${RadarRenderers.escapeHtml(tag)}</span>`).join("")}</div>
        </div>
        <div class="mini-fields">${summary}${RadarRenderers.sourceLinks(company.primary_source_ids, sourceIndex)}</div>
        <button class="card-delete" type="button" data-delete-research="${RadarRenderers.escapeHtml(company.ticker)}" title="刪除觀察公司">刪除</button>
      </article>
    `;
  }).join("");

  document.querySelectorAll(".company-card").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target?.dataset?.removeCandidate) return;
      if (event.target?.dataset?.deleteResearch) return;
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
        <p class="muted">這家公司目前只在研究候選清單中，尚未建立正式研究檔。</p>
      </div>
      <span class="pill">待建檔</span>
    </div>
    <section class="module">
      <h3>下一步</h3>
      <p>若要產生評分，需要把此公司加入 <code>data/companies.json</code>，再執行資料接入流程，取得股價、營收、財務、重大訊息、風險與產業證據。</p>
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
  const record = state.researchCache.records[company.ticker];
  const indexed = (state.researchCache.index.companies || []).find((item) => item.ticker === company.ticker);
  if (!record) {
    const text = state.researchCache.pending.has(company.ticker)
      ? "正在載入公告事件..."
      : indexed
        ? "公告事件快取已建立，正在載入。"
        : "尚未建立公告事件快取。可使用「更新公告事件」開始蒐集。";
    return `<section class="module collected-events"><h3>官方公告事件</h3><p class="muted">${text}</p></section>`;
  }

  const eventItems = (record.events || []).map((event) => `
    <article class="collector-event">
      <div class="collector-event-head">
        <span class="timeline-date">${RadarRenderers.escapeHtml(event.date || "未提供日期")}</span>
        <span class="tag">${RadarRenderers.escapeHtml(event.claim_type || "official_disclosure")}</span>
      </div>
      <strong>${RadarRenderers.escapeHtml(event.title)}</strong>
      ${event.clause ? `<p class="muted">${RadarRenderers.escapeHtml(event.clause)}</p>` : ""}
      ${event.description ? `<p>${RadarRenderers.escapeHtml(event.description.slice(0, 280))}${event.description.length > 280 ? "..." : ""}</p>` : ""}
      <a class="source-chip" href="${RadarRenderers.escapeHtml(event.source_url)}" target="_blank" rel="noopener">官方來源</a>
    </article>
  `).join("");
  const references = (record.references || []).map((reference) => `
    <a class="source-chip" href="${RadarRenderers.escapeHtml(reference.url)}" target="_blank" rel="noopener">${RadarRenderers.escapeHtml(reference.title)}</a>
  `).join("");
  const sourceStatus = (record.source_status || []).map((status) => `${status.source_id}: ${status.cache_status || (status.available ? "available" : "unavailable")}`).join(" | ");

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
  const companySignals = state.signals.filter((signal) => signal.company_id === company.id);
  const dataSnapshot = renderDataSnapshot(company, sourceIndex);

  const modules = template.modules.map((module) => `
    <section class="module">
      <h3>${RadarRenderers.escapeHtml(module.label)}</h3>
      <div class="module-grid">
        ${module.fields.map((fieldId) => RadarRenderers.renderFact(company, fieldId, state.definitions, sourceIndex)).join("")}
      </div>
    </section>
  `).join("");

  const riskItems = (company.risks || []).map((risk) => `<li>${RadarRenderers.escapeHtml(risk)}</li>`).join("");
  const signalItems = companySignals.map((signal) => `
    <li><b>${RadarRenderers.escapeHtml(signal.type)}</b>：${RadarRenderers.escapeHtml(signal.title)} <span class="muted">(${RadarRenderers.escapeHtml(signal.impact)} / ${RadarRenderers.escapeHtml(signal.confidence)})</span></li>
  `).join("");

  $("#company-detail").className = "detail-content";
  $("#company-detail").innerHTML = `
    <div class="detail-title">
      <div>
        <p class="eyebrow">${RadarRenderers.escapeHtml(template.label)} · ${RadarRenderers.escapeHtml(score.band.label)}</p>
        <h2>${RadarRenderers.escapeHtml(company.name)}</h2>
        <p class="stock-meta">${RadarRenderers.escapeHtml(stockLabel(company))} · ${RadarRenderers.escapeHtml(dataCoverageLabel(company))}${company.legal_name ? ` · ${RadarRenderers.escapeHtml(company.legal_name)}` : ""}</p>
        <p class="muted">${RadarRenderers.escapeHtml(company.data_quality)} · ${RadarRenderers.escapeHtml(company.last_reviewed)}</p>
      </div>
      <span class="pill">${score.total}</span>
    </div>
    <p>${RadarRenderers.escapeHtml(company.thesis)}</p>
    <div class="score-breakdown">${RadarRenderers.renderScoreRows(score)}</div>
    <details class="detail-fold">
      <summary>資料快照與產業證據</summary>
      ${dataSnapshot}
    </details>
    ${renderCollectedEvents(company)}
    <details class="detail-fold">
      <summary>完整研究欄位</summary>
      ${modules}
    </details>
    <section class="module">
      <h3>主要風險</h3>
      <ul>${riskItems || "<li>尚未填寫</li>"}</ul>
    </section>
    <section class="module">
      <h3>近期訊號</h3>
      <ul>${signalItems || "<li>尚未建立訊號</li>"}</ul>
    </section>
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

function renderDataSnapshot(company, sourceIndex) {
  const market = state.marketData.companies?.[company.id];
  const revenue = state.revenueData.companies?.[company.id];
  const financial = state.financialData.companies?.[company.id];
  const catalyst = state.catalystData.companies?.[company.id];
  const ownership = state.ownershipData.companies?.[company.id];
  const risk = state.riskData.companies?.[company.id];
  const industryEvidence = state.industryEvidenceData.companies?.[company.id];
  const industry = state.industryData.companies?.[company.id];
  const status = state.dataStatus.companies?.[company.id];
  const statusText = status ? `${status.completed_count}/${status.total_count} 類資料已接入` : "資料狀態未建立";
  const evidenceRows = industryEvidence?.dimensions || [];

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
      rows: [
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
        ["大股東", `${formatNumber(ownership?.major_shareholder_count)} 名`],
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
    },
    {
      title: "產業基本面",
      sourceIds: industry?.source_ids,
      rows: [
        ["分數", formatNumber(industry?.score)],
        ["產業證據", industry?.industry_evidence_total_count ? `${formatNumber(industry?.industry_evidence_score)} (${formatNumber(industry?.industry_evidence_completed_count)}/${formatNumber(industry?.industry_evidence_total_count)})` : "尚無資料"],
        ["來源追溯", formatNumber(industry?.traceability_score)],
        ["營收/財務/風險", `${formatNumber(industry?.revenue_score)} / ${formatNumber(industry?.financial_score)} / ${formatNumber(industry?.risk_score)}`],
        ["理由", industry?.rationale || "尚無資料"]
      ]
    }
  ];

  return `
    <section class="module">
      <h3>客觀資料快照 <span class="muted">${RadarRenderers.escapeHtml(statusText)}</span></h3>
      <div class="data-grid">
        ${cards.map((card) => `
          <article class="data-card">
            <strong>${RadarRenderers.escapeHtml(card.title)}</strong>
            ${card.rows.map(([label, value]) => `
              <div class="data-row">
                <span>${RadarRenderers.escapeHtml(label)}</span>
                <b>${RadarRenderers.escapeHtml(value)}</b>
              </div>
            `).join("")}
            ${RadarRenderers.sourceLinks(card.sourceIds, sourceIndex)}
          </article>
        `).join("")}
      </div>
      <p class="muted">七個評分維度皆由公開資料或可追溯公式產生；若官方 API 暫時失敗，更新腳本會使用上一版快取資料並保留資料狀態。</p>
      ${evidenceRows.length ? `
        <div class="evidence-list">
          ${evidenceRows.map((dimension) => `
            <article class="evidence-item">
              <div>
                <strong>${RadarRenderers.escapeHtml(dimension.label)}</strong>
                <p class="muted">${RadarRenderers.escapeHtml(dimension.rationale || dimension.description || "")}</p>
              </div>
              <span class="pill">${RadarRenderers.escapeHtml(formatNumber(dimension.score))}</span>
              ${RadarRenderers.sourceLinks(dimension.source_ids, sourceIndex)}
            </article>
          `).join("")}
        </div>
      ` : ""}
    </section>
  `;
}

function renderStandards() {
  const industry = $("#industry-filter").value;
  const template = industry === "all" ? null : state.templates[industry];
  const commonCards = state.rules.common_dimensions.map((dimension) => `
    <article class="standard-card">
      <strong>${RadarRenderers.escapeHtml(dimension.label)} · ${Math.round(dimension.weight * 100)}%</strong>
      <p>${RadarRenderers.escapeHtml(dimension.description)}</p>
      <p class="muted">高分條件：${RadarRenderers.escapeHtml(dimension.high_score_signal)}</p>
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
      title: `毛利率 ${formatPercent(financial.gross_margin_pct)}，營益率 ${formatPercent(financial.operating_margin_pct)}，EPS ${formatNumber(financial.eps)}`,
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
