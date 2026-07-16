import path from "node:path";
import { readJson, writeJson } from "./data-sources.mjs";

const root = process.cwd();
const companiesPath = path.join(root, "data", "companies.json");
const payload = await readJson(companiesPath);

const semiconductorCompanies = [
  {
    id: "tw-2330-tsmc",
    ticker: "2330",
    market: "TWSE",
    market_label: "上市",
    name: "台積電",
    legal_name: "台灣積體電路製造股份有限公司",
    category: "半導體",
    industry_template: "semiconductor",
    data_quality: "半導體試點：公司已列入 TWSE/TPEx 公開市場資料更新流程；產業欄位先以公開研究檔與官方來源建立。",
    last_reviewed: "2026-07-08",
    thesis: "全球晶圓代工龍頭，先進製程與先進封裝是 AI/HPC 供應鏈核心，適合作為半導體高品質基準樣本。",
    tags: ["上市", "晶圓代工", "先進製程", "AI", "HPC"],
    primary_source_ids: ["twse_company_basic", "tsmc_official", "mops"],
    facts: {
      business_model: { value: "專業晶圓代工，替全球 IC 設計與系統客戶製造先進與特殊製程晶片。", source_ids: ["tsmc_official", "twse_company_basic"] },
      industry_focus: { value: "先進製程、特殊製程、先進封裝與晶圓代工服務。", source_ids: ["tsmc_official"] },
      revenue_driver: { value: "AI/HPC、智慧手機、車用與資料中心需求；月營收與法說會展望是主要追蹤項。", source_ids: ["mops", "tsmc_official"] },
      key_catalyst: { value: "先進製程放量、AI/HPC 需求、先進封裝產能、海外廠進度與資本支出效率。", source_ids: ["mops", "tsmc_official"] },
      key_risk: { value: "地緣政治、出口管制、客戶集中、資本支出循環、匯率與海外擴產成本。", source_ids: ["mops"] },
      technology_position: { value: "先進製程與先進封裝具全球領先位置，是半導體產業鏈關鍵節點。", source_ids: ["tsmc_official"] },
      customer_structure: { value: "全球高階 IC 設計與系統客戶導入深，需持續追蹤前幾大客戶集中度與 AI/HPC 需求。", source_ids: ["mops"] },
      inventory_cycle: { value: "晶圓代工受終端庫存與客戶拉貨節奏影響，但高階製程需求能抵銷部分循環波動。", source_ids: ["mops"] },
      capex_intensity: { value: "資本支出強度高，須追蹤先進製程、先進封裝與海外廠投資報酬。", source_ids: ["mops"] },
      industry_quality: { value: "技術位置、客戶導入與供應鏈關鍵性都高，適合作為半導體模板的高分基準。", source_ids: ["tsmc_official", "mops"] }
    },
    score_inputs: {
      catalyst: { score: 78, evidence_level: "medium", rationale: "AI/HPC、先進製程與先進封裝是主要催化，但仍需由月營收與重大訊息更新。", source_ids: ["mops"] },
      revenueMomentum: { score: 75, evidence_level: "low", rationale: "半導體龍頭月營收可追蹤，待客觀資料覆蓋。", source_ids: ["mops"] },
      cashProfitQuality: { score: 82, evidence_level: "low", rationale: "高毛利與現金流品質需由財報自動帶入驗證。", source_ids: ["mops"] },
      priceTrend: { score: 60, evidence_level: "low", rationale: "待接入股價區間與趨勢。", source_ids: ["twse"] },
      ownership: { score: 58, evidence_level: "low", rationale: "待接入大股東與內部人資料。", source_ids: ["tdcc"] },
      riskNews: { score: 66, evidence_level: "medium", rationale: "地緣政治與出口管制是主要風險，需由重大訊息與新聞驗證。", source_ids: ["mops"] },
      industryFundamental: { score: 86, evidence_level: "medium", rationale: "先進製程與供應鏈地位明確，產業基本面品質高。", source_ids: ["tsmc_official"] }
    },
    risks: ["地緣政治與出口管制", "客戶集中", "海外擴產成本", "資本支出循環"],
    events: [{ date: "2026-Q3", type: "資料補齊", title: "接入月營收、財報與重大訊息後檢查 AI/HPC 與先進封裝動能" }],
    sources: [
      { id: "tsmc_official", title: "台積電官方網站", short_title: "台積電官網", url: "https://www.tsmc.com/english", note: "用於公司業務、技術與官方資訊追溯。" }
    ]
  },
  {
    id: "tw-2454-mediatek",
    ticker: "2454",
    market: "TWSE",
    market_label: "上市",
    name: "聯發科",
    legal_name: "聯發科技股份有限公司",
    category: "半導體",
    industry_template: "semiconductor",
    data_quality: "半導體試點：公司已列入 TWSE/TPEx 公開市場資料更新流程；產業欄位先以公開研究檔與官方來源建立。",
    last_reviewed: "2026-07-08",
    thesis: "台灣代表性 IC 設計公司，產品橫跨手機、智慧裝置、連網與 AI 邊緣應用，可測試 fabless 模板。",
    tags: ["上市", "IC 設計", "Fabless", "手機晶片", "AI Edge"],
    primary_source_ids: ["twse_company_basic", "mediatek_official", "mops"],
    facts: {
      business_model: { value: "Fabless IC 設計，透過晶圓代工與封測供應鏈推出 SoC 與連網晶片。", source_ids: ["mediatek_official", "twse_company_basic"] },
      industry_focus: { value: "手機 SoC、智慧家庭、連網、電源管理、車用與 AI 邊緣晶片。", source_ids: ["mediatek_official"] },
      revenue_driver: { value: "手機與消費性電子產品週期、AI/邊緣運算導入、新平台上市與客戶拉貨。", source_ids: ["mops", "mediatek_official"] },
      key_catalyst: { value: "旗艦 SoC 滲透率、AI 裝置需求、車用/連網產品成長與毛利率改善。", source_ids: ["mops", "mediatek_official"] },
      key_risk: { value: "手機市場循環、競爭價格壓力、客戶庫存、匯率與先進製程成本。", source_ids: ["mops"] },
      technology_position: { value: "具備大型 SoC 平台、通訊與多媒體整合能力，需追蹤高階平台競爭力。", source_ids: ["mediatek_official"] },
      customer_structure: { value: "客戶涵蓋手機與終端設備品牌，需追蹤高階客戶導入與產品組合改善。", source_ids: ["mops"] },
      inventory_cycle: { value: "Fabless 模式對終端庫存與通路拉貨敏感，月營收和存貨變化是核心觀察。", source_ids: ["mops"] },
      capex_intensity: { value: "資本支出相對晶圓製造低，重點在研發投入與先進製程投片成本。", source_ids: ["mops"] },
      industry_quality: { value: "IC 設計平台能力明確，適合作為 fabless 與消費電子週期樣本。", source_ids: ["mediatek_official", "mops"] }
    },
    score_inputs: {
      catalyst: { score: 74, evidence_level: "medium", rationale: "新平台、AI 邊緣與高階 SoC 可能帶動評價，但需月營收確認。", source_ids: ["mops"] },
      revenueMomentum: { score: 68, evidence_level: "low", rationale: "待接入月營收。", source_ids: ["mops"] },
      cashProfitQuality: { score: 76, evidence_level: "low", rationale: "研發效率、毛利率與現金流待財報驗證。", source_ids: ["mops"] },
      priceTrend: { score: 58, evidence_level: "low", rationale: "待接入股價趨勢。", source_ids: ["twse"] },
      ownership: { score: 55, evidence_level: "low", rationale: "待接入股權資料。", source_ids: ["tdcc"] },
      riskNews: { score: 64, evidence_level: "medium", rationale: "主要風險在競爭、庫存與終端需求波動。", source_ids: ["mops"] },
      industryFundamental: { score: 78, evidence_level: "medium", rationale: "IC 設計平台與產品組合有代表性，但週期敏感度高。", source_ids: ["mediatek_official"] }
    },
    risks: ["手機市場循環", "產品價格競爭", "客戶庫存", "先進製程成本"],
    events: [{ date: "2026-Q3", type: "資料補齊", title: "接入月營收與財報後檢查高階 SoC 與 AI 邊緣產品動能" }],
    sources: [
      { id: "mediatek_official", title: "聯發科官方網站", short_title: "聯發科官網", url: "https://www.mediatek.com/", note: "用於公司產品、平台與官方資訊追溯。" }
    ]
  },
  {
    id: "tw-2303-umc",
    ticker: "2303",
    market: "TWSE",
    market_label: "上市",
    name: "聯電",
    legal_name: "聯華電子股份有限公司",
    category: "半導體",
    industry_template: "semiconductor",
    data_quality: "半導體試點：公司已列入 TWSE/TPEx 公開市場資料更新流程；產業欄位先以公開研究檔與官方來源建立。",
    last_reviewed: "2026-07-08",
    thesis: "成熟製程晶圓代工代表，適合觀察成熟節點景氣、車用/工控需求、產能利用率與報價循環。",
    tags: ["上市", "晶圓代工", "成熟製程", "車用", "工控"],
    primary_source_ids: ["twse_company_basic", "umc_official", "mops"],
    facts: {
      business_model: { value: "專業晶圓代工，聚焦成熟與特殊製程，服務 IC 設計與系統客戶。", source_ids: ["umc_official", "twse_company_basic"] },
      industry_focus: { value: "成熟製程、特殊製程、車用、工控、通訊與消費性應用晶圓代工。", source_ids: ["umc_official"] },
      revenue_driver: { value: "產能利用率、成熟製程報價、車用/工控需求與客戶庫存去化。", source_ids: ["mops", "umc_official"] },
      key_catalyst: { value: "成熟製程庫存回補、車用需求改善、產能利用率回升與毛利率穩定。", source_ids: ["mops"] },
      key_risk: { value: "成熟製程供需循環、價格壓力、客戶庫存與中國同業產能競爭。", source_ids: ["mops"] },
      technology_position: { value: "成熟與特殊製程具規模與客戶基礎，差異化重點在穩定供應與特殊製程能力。", source_ids: ["umc_official"] },
      customer_structure: { value: "客戶分散於通訊、消費、車用與工控，需追蹤需求復甦速度。", source_ids: ["mops"] },
      inventory_cycle: { value: "成熟製程對客戶庫存循環敏感，月營收與產能利用率是核心檢核。", source_ids: ["mops"] },
      capex_intensity: { value: "資本支出低於先進製程代工，仍需看折舊、稼動與投資紀律。", source_ids: ["mops"] },
      industry_quality: { value: "成熟製程基準公司，能測試景氣循環與毛利韌性評估。", source_ids: ["umc_official", "mops"] }
    },
    score_inputs: {
      catalyst: { score: 64, evidence_level: "medium", rationale: "庫存回補與稼動率改善可能催化，需月營收驗證。", source_ids: ["mops"] },
      revenueMomentum: { score: 58, evidence_level: "low", rationale: "待接入月營收。", source_ids: ["mops"] },
      cashProfitQuality: { score: 70, evidence_level: "low", rationale: "毛利與現金流穩定性待財報驗證。", source_ids: ["mops"] },
      priceTrend: { score: 52, evidence_level: "low", rationale: "待接入股價趨勢。", source_ids: ["twse"] },
      ownership: { score: 55, evidence_level: "low", rationale: "待接入股權資料。", source_ids: ["tdcc"] },
      riskNews: { score: 62, evidence_level: "medium", rationale: "成熟製程供需與價格壓力是主要風險。", source_ids: ["mops"] },
      industryFundamental: { score: 70, evidence_level: "medium", rationale: "成熟製程地位明確，但循環風險較高。", source_ids: ["umc_official"] }
    },
    risks: ["成熟製程價格壓力", "客戶庫存", "產能利用率", "同業擴產競爭"],
    events: [{ date: "2026-Q3", type: "資料補齊", title: "接入月營收與財報後檢查成熟製程週期位置" }],
    sources: [
      { id: "umc_official", title: "聯電官方網站", short_title: "聯電官網", url: "https://www.umc.com/en/Home/Index", note: "用於公司技術、製程與官方資訊追溯。" }
    ]
  },
  {
    id: "tw-3711-aseh",
    ticker: "3711",
    market: "TWSE",
    market_label: "上市",
    name: "日月光投控",
    legal_name: "日月光投資控股股份有限公司",
    category: "半導體",
    industry_template: "semiconductor",
    data_quality: "半導體試點：公司已列入 TWSE/TPEx 公開市場資料更新流程；產業欄位先以公開研究檔與官方來源建立。",
    last_reviewed: "2026-07-08",
    thesis: "全球封測與電子製造服務重要公司，能測試先進封裝、測試需求與半導體後段景氣。",
    tags: ["上市", "封測", "先進封裝", "測試", "OSAT"],
    primary_source_ids: ["twse_company_basic", "aseh_official", "mops"],
    facts: {
      business_model: { value: "半導體封裝、測試與相關電子製造服務，位於晶片製造後段供應鏈。", source_ids: ["aseh_official", "twse_company_basic"] },
      industry_focus: { value: "封裝、測試、先進封裝、系統級封裝與電子製造服務。", source_ids: ["aseh_official"] },
      revenue_driver: { value: "先進封裝需求、測試稼動率、AI/HPC 與終端電子產品拉貨。", source_ids: ["mops", "aseh_official"] },
      key_catalyst: { value: "先進封裝需求提升、測試稼動改善、AI/HPC 封測訂單與毛利率回升。", source_ids: ["mops", "aseh_official"] },
      key_risk: { value: "終端需求波動、封測價格競爭、設備稼動、匯率與客戶庫存調整。", source_ids: ["mops"] },
      technology_position: { value: "封測規模與先進封裝能力具全球競爭地位，需追蹤高階封裝占比。", source_ids: ["aseh_official"] },
      customer_structure: { value: "服務全球半導體客戶，客戶導入深度與高階封裝需求是關鍵。", source_ids: ["mops"] },
      inventory_cycle: { value: "封測需求通常反映下游拉貨與晶圓投片節奏，對庫存循環敏感。", source_ids: ["mops"] },
      capex_intensity: { value: "先進封裝與測試設備投資需看稼動率與訂單能見度。", source_ids: ["mops"] },
      industry_quality: { value: "後段封測代表公司，適合觀察先進封裝與半導體景氣擴散。", source_ids: ["aseh_official", "mops"] }
    },
    score_inputs: {
      catalyst: { score: 70, evidence_level: "medium", rationale: "先進封裝與 AI/HPC 封測需求可能形成催化。", source_ids: ["mops"] },
      revenueMomentum: { score: 62, evidence_level: "low", rationale: "待接入月營收。", source_ids: ["mops"] },
      cashProfitQuality: { score: 68, evidence_level: "low", rationale: "稼動率與毛利率待財報驗證。", source_ids: ["mops"] },
      priceTrend: { score: 55, evidence_level: "low", rationale: "待接入股價趨勢。", source_ids: ["twse"] },
      ownership: { score: 55, evidence_level: "low", rationale: "待接入股權資料。", source_ids: ["tdcc"] },
      riskNews: { score: 63, evidence_level: "medium", rationale: "終端需求與稼動率是主要風險。", source_ids: ["mops"] },
      industryFundamental: { score: 74, evidence_level: "medium", rationale: "封測與先進封裝地位清楚，但景氣彈性仍高。", source_ids: ["aseh_official"] }
    },
    risks: ["終端需求波動", "封測價格競爭", "設備稼動率", "客戶庫存調整"],
    events: [{ date: "2026-Q3", type: "資料補齊", title: "接入月營收與財報後檢查先進封裝與測試稼動率" }],
    sources: [
      { id: "aseh_official", title: "日月光投控官方網站", short_title: "日月光官網", url: "https://www.aseglobal.com/", note: "用於封測、先進封裝與官方資訊追溯。" }
    ]
  },
  {
    id: "tw-6488-globalwafers",
    ticker: "6488",
    market: "TPEx",
    market_label: "上櫃",
    name: "環球晶",
    legal_name: "環球晶圓股份有限公司",
    category: "半導體",
    industry_template: "semiconductor",
    data_quality: "半導體試點：公司已列入 TWSE/TPEx 公開市場資料更新流程；產業欄位先以公開研究檔與官方來源建立。",
    last_reviewed: "2026-07-08",
    thesis: "矽晶圓材料代表公司，適合觀察半導體上游材料、長約、庫存週期、報價與產能擴張。",
    tags: ["上櫃", "矽晶圓", "材料", "長約", "上游"],
    primary_source_ids: ["tpex_company_basic", "globalwafers_official", "mops"],
    facts: {
      business_model: { value: "半導體矽晶圓材料供應商，提供晶圓製造所需關鍵基材。", source_ids: ["globalwafers_official", "tpex_company_basic"] },
      industry_focus: { value: "矽晶圓、半導體材料、上游供應鏈與長約出貨。", source_ids: ["globalwafers_official"] },
      revenue_driver: { value: "晶圓廠稼動率、長約、矽晶圓報價、客戶庫存與半導體資本支出週期。", source_ids: ["mops", "globalwafers_official"] },
      key_catalyst: { value: "矽晶圓價格回穩、客戶庫存去化、長約出貨、產能利用率改善。", source_ids: ["mops"] },
      key_risk: { value: "材料報價下行、客戶去庫存、長約重議、擴產折舊與能源成本。", source_ids: ["mops"] },
      technology_position: { value: "上游矽晶圓材料具規模與客戶基礎，需追蹤先進晶圓規格與產能利用。", source_ids: ["globalwafers_official"] },
      customer_structure: { value: "客戶為全球半導體製造商，長約與客戶庫存狀態是重要觀察。", source_ids: ["mops"] },
      inventory_cycle: { value: "矽晶圓對半導體景氣與晶圓廠庫存循環高度敏感。", source_ids: ["mops"] },
      capex_intensity: { value: "擴產與折舊壓力需搭配長約與價格週期評估。", source_ids: ["mops"] },
      industry_quality: { value: "上游材料代表公司，可補足半導體模板中的材料與庫存週期視角。", source_ids: ["globalwafers_official", "mops"] }
    },
    score_inputs: {
      catalyst: { score: 62, evidence_level: "medium", rationale: "矽晶圓價格與庫存去化可能形成催化，但週期尚需月營收確認。", source_ids: ["mops"] },
      revenueMomentum: { score: 55, evidence_level: "low", rationale: "待接入月營收。", source_ids: ["mops"] },
      cashProfitQuality: { score: 66, evidence_level: "low", rationale: "長約、毛利與折舊壓力待財報驗證。", source_ids: ["mops"] },
      priceTrend: { score: 52, evidence_level: "low", rationale: "待接入股價趨勢。", source_ids: ["tpex"] },
      ownership: { score: 55, evidence_level: "low", rationale: "待接入股權資料。", source_ids: ["tdcc"] },
      riskNews: { score: 60, evidence_level: "medium", rationale: "報價、庫存與長約重議是主要風險。", source_ids: ["mops"] },
      industryFundamental: { score: 68, evidence_level: "medium", rationale: "上游材料位置明確，但受半導體庫存週期影響較高。", source_ids: ["globalwafers_official"] }
    },
    risks: ["矽晶圓報價下行", "客戶去庫存", "長約重議", "擴產折舊壓力"],
    events: [{ date: "2026-Q3", type: "資料補齊", title: "接入月營收與財報後檢查矽晶圓報價與庫存週期" }],
    sources: [
      { id: "globalwafers_official", title: "環球晶官方網站", short_title: "環球晶官網", url: "https://www.sas-globalwafers.com/", note: "用於矽晶圓材料、公司業務與官方資訊追溯。" }
    ]
  }
];

const existingIds = new Set((payload.companies || []).map((company) => company.id));
payload.companies = [
  ...(payload.companies || []).filter((company) => !semiconductorCompanies.some((item) => item.id === company.id)),
  ...semiconductorCompanies
];

payload.version = "0.7.0";
payload.note = "v0.7 試點資料：保留原保健營養食品 5 家公司，新增半導體 5 家公司，用於測試跨產業模板、產業證據層與官方公開資料評分。";
payload.selection_method = "試點名單涵蓋保健營養食品與半導體。半導體名單橫跨晶圓代工、IC 設計、封測與矽晶圓材料；不代表市值、營收或投資價值排名。";

await writeJson(companiesPath, payload);
console.log(`Added ${semiconductorCompanies.filter((company) => !existingIds.has(company.id)).length} semiconductor companies.`);
