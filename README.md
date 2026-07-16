# 跨產業公司研究雷達

這是 v0.7 靜態網站 MVP，用來驗證「跨產業公司研究與評分儀錶板」的資料模型、互動方式、真實公司試點資料，以及公開客觀資料接入後的可追溯評分。

## 目前定位

網站仍不做登入、資料庫或付費 API。這一版放入 10 家台灣上市櫃公司作為試點：5 家保健營養食品/機能素材關聯公司，以及 5 家半導體公司。客觀資料透過官方公開 API 產生股價、月營收、財務、重大訊息與產業證據 JSON：

- 共通評分層：催化事件、營收動能、現金/獲利品質、股價位置/趨勢、籌碼/股權結構、新聞/重大訊息風險、產業基本面
- 產業模板層：保健營養食品、半導體、電子硬體、軟體/SaaS、AI、醫療器材、製造業
- 訊號層：`data/signals.json` 可存放未來由重大訊息、新聞、財報、股價或人工研究產生的事件訊號
- 客觀資料層：`data/market_data.json`、`data/revenue_data.json`、`data/financial_data.json`、`data/catalyst_data.json`、`data/ownership_data.json`、`data/risk_data.json`、`data/industry_evidence_data.json`、`data/industry_data.json` 由 `tools/update-data.mjs` 產生

## v0.7 升級內容

- 新增半導體試點 5 家：台積電（2330）、聯發科（2454）、聯電（2303）、日月光投控（3711）、環球晶（6488）
- 半導體產業證據使用技術與產品位置、客戶導入、庫存週期、毛利韌性、供應鏈與出口風險
- 客觀資料更新已擴充到 10 家公司，半導體 5 家目前皆為「客觀資料 7/7」
- `fetchJson` 加入逾時與重試，官方 API 不穩時不會讓整輪更新長時間卡住
- 保留 v0.6 的產業證據層與 TFDA 來源 metadata 架構

目前試點公司包含葡萄王生技（1707）、大江生醫（8436）、大研生醫（7780）、生展（8279）、景岳（3164）、台積電（2330）、聯發科（2454）、聯電（2303）、日月光投控（3711）、環球晶（6488）。名單是為了測試跨產業資料模型與公開資料可得性，不代表市值、營收或投資價值排名。

## 使用方式

因為前端會使用 `fetch()` 載入 `data/*.json`，請用本機 HTTP 伺服器開啟。

如果系統有 Python：

```powershell
python -m http.server 8000
```

如果沒有 Python，可以用本專案附的無相依 Node 伺服器：

```powershell
node tools/static-server.mjs . 8767
```

然後在瀏覽器開啟對應的本機網址。

## 資料檔

- `data/industry_templates.json`：產業模板、各產業基本面子檢核與產業證據權重
- `data/field_definitions.json`：欄位定義
- `data/scoring_rules.json`：共通評分規則與權重
- `data/companies.json`：真實公司試點資料與來源 metadata
- `data/signals.json`：真實公司試點的研究待辦與觀察訊號
- `data/market_data.json`：近一年股價區間、20/60 日報酬與趨勢分數
- `data/revenue_data.json`：最近月營收、YoY、MoM、累計 YoY 與營收動能分數
- `data/financial_data.json`：最近季度毛利率、營益率、流動比率、負債比率、EPS 與財務品質分數
- `data/catalyst_data.json`：月營收、財務品質與重大訊息關鍵字合成的催化事件分數
- `data/ownership_data.json`：大股東、內部人轉讓申報與資訊申報違規合成的籌碼/股權結構分數
- `data/risk_data.json`：重大訊息與資訊申報違規合成的新聞/重大訊息風險分數
- `data/industry_evidence_data.json`：依產業模板產生的產業證據子分數；保健營養食品已列入 TFDA 許可與廣告合規來源，半導體使用技術/客戶/庫存/毛利/供應鏈風險
- `data/industry_data.json`：產業證據、營收、財務、風險、催化與來源可追溯度合成的產業基本面分數
- `data/data_status.json`：每家公司客觀資料接入狀態

## 更新資料

使用內建 Node.js 或系統 Node.js 執行：

```powershell
node tools/update-data.mjs
```

腳本會讀取 `data/companies.json` 的股票代碼，並更新客觀資料 JSON。前端會用這些資料覆蓋 `catalyst`、`revenueMomentum`、`cashProfitQuality`、`priceTrend`、`ownership`、`riskNews`、`industryFundamental` 七個評分維度。

評分分級與資料覆蓋分開顯示：低於 65 分不等於沒資料，而是目前客觀資料合成後分數偏弱。卡片上的「客觀資料 7/7」代表催化、股價、月營收、財務、籌碼、風險、產業基本面七類資料是否已接入。

TFDA 目前已作為保健營養食品產業證據層的正式來源 metadata 接入，但尚未完成逐品項自動比對健康食品許可證與食品廣告違規裁罰。半導體則不使用 TFDA，而是用技術位置、客戶導入、庫存週期、毛利韌性與供應鏈風險作為替代標準。

## 下一步

下一版可以加入「股票代碼 → 建立研究檔」流程。建議先讓輸入股票代碼新增到 watchlist，再依產業模板補齊重大訊息、新聞、TFDA/產業法規、集保籌碼與產業證據自動建檔。
## v0.8 研究宇宙選股頁

新增獨立頁面 `universe.html`，作為建立研究檔之前的前置篩選器：

- `data/industry_template_map.json`：15 個產業模板、官方產業代碼映射、少量關鍵字覆寫規則。
- `tools/build-universe.mjs`：從 TWSE/TPEx 官方公司基本資料 OpenAPI 產生上市/上櫃公司宇宙。
- `data/listed_companies_universe.json`：目前 1,974 檔四碼上市/上櫃股票清單。
- `data/universe_coverage_report.json`：各產業模板、官方產業代碼、市場別覆蓋統計。
- `universe.html`、`css/universe.css`、`js/universe.js`：搜尋、分區、勾選、複製股票代號。
- 選股頁的「送到主頁」會把目前勾選清單帶到 `index.html?universe=selected&tickers=...`，主頁會顯示「研究候選」區塊；尚未加入 `data/companies.json` 的公司會標示為待建立研究檔。
- 主頁研究候選區可以逐檔移除，會同步更新本機暫存與網址中的 `tickers` 參數。
- 選股頁的「保存種子」會下載 `research-candidate-seed-YYYY-MM-DD.json`，可作為後續批次建立研究檔的輸入。
- 主頁也可以直接載入研究候選：在「候選代號」貼上 `2330, 1101` 這類清單後按「載入候選」，或用「候選種子檔」選取前述 JSON。載入後左側 Watchlist 會顯示正式研究卡片與「待建立研究檔」候選卡片。
- v0.8 起新增本機動態研究流程：使用 `tools/research-server.mjs` 啟動網站後，選股頁或主頁可按「開始研究」，系統會把任選股票升級到 `data/companies.json`，再執行公開資料更新，完成後主頁可看到正式分數。
- 主頁正式研究卡片提供「刪除」按鈕，會透過動態伺服器移除 `data/companies.json` 與各客觀資料檔中的該公司資料。
- 近期觀察訊號已改用接入後的客觀資料產生，包括月營收、股價、財務、重大訊息、風險事件、揭露違規與產業分數；不再依賴早期手寫的待接入訊號。

動態研究伺服器：

```powershell
& "C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" tools\research-server.mjs . 8767
```

手動升級候選：

```powershell
& "C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" tools\promote-candidates.mjs --tickers=1595,2301,3044
& "C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" tools\update-data.mjs
```

使用方式：

```powershell
& "C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" tools\build-universe.mjs
```

再開啟：

```text
http://127.0.0.1:8767/universe.html
```

注意：這一頁只建立研究候選清單，不會自動把所有公司加入 `data/companies.json`，也不會啟動自動爬蟲。被勾選的代號可以作為下一步建立研究檔的輸入。
# v0.11：回測資料補強與資料不足修正

15 類模板獨立回測包已加入資料來源補強：

- `tools/backtest-template-cohort.mjs` 現在會用 PowerShell `Invoke-WebRequest` 作為 TWSE/TPEx OpenAPI 的後援抓取方式。
- 共享資料會快取到 `backtests/2026-06-09_to_2026-07-09_15_templates/source-cache/`，避免每次重跑都重新打公開 API。
- TWSE 單檔股價被 WAF 擋住時，會用 `MI_INDEX` 全市場日行情補回測起點與終點價格。
- 高資料覆蓋但低起點分數的公司會標為 `weak` 訊號，不再誤列為資料不足。

修正後本次回測資料覆蓋：

- 價格：75/75
- 營收：63/75
- 財報：66/75
- 可判定樣本：71/75
- 資料不足：4/75

目前仍待補強：重大訊息在本次 75 家樣本中沒有命中事件，治理資料大多只有部分覆蓋；下一步可針對 MOPS 重大訊息與股權/違規來源建立更穩定的歷史快照。

# v0.10：15 類模板獨立回測包

這一版新增不污染主頁 watchlist 的獨立回測流程：

- `tools/select-template-backtest-cohort.mjs`：從 15 類模板各挑 5 家公司，產生 cohort。
- `tools/backtest-template-cohort.mjs`：針對 cohort 抓公開資料、計分，並回測一個月前到現在的結果。
- `backtests/2026-06-09_to_2026-07-09_15_templates/`：本次 75 家樣本的輸出包。

重跑指令：

```powershell
& "C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" tools\select-template-backtest-cohort.mjs --backtest-id=2026-06-09_to_2026-07-09_15_templates --count=5
& "C:\Users\user\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" tools\backtest-template-cohort.mjs --start=2026-06-09 --end=2026-07-09 --backtest-id=2026-06-09_to_2026-07-09_15_templates
```

注意：本次價格資料覆蓋完整，但 TWSE 部分 OpenAPI 在執行時連線失敗，總報告已將來源缺口寫入 `summary.md` 的資料來源警告段落。這份結果適合先看模板壓力測試與方向性，不應視為嚴格 point-in-time 投資績效歸因。

# 關注企業儀錶板

## v0.9：15 類正式產業模板

這一版把選股宇宙中的 15 類分類補齊為正式研究模板，不再只靠保健食品、半導體、電子硬體或通用製造模板支撐。

正式模板包含：

- 半導體
- 電子硬體與零組件
- 軟體、雲端與資訊服務
- AI 與資料平台
- 生技製藥
- 醫療器材
- 保健營養食品
- 金融保險
- 工業製造與自動化
- 原物料、化工與基礎材料
- 汽車與電動車供應鏈
- 基礎建設、營建與運輸
- 消費、食品、零售與生活
- 能源、環境與公用事業
- 其他與待分類

相關檔案：

- `data/industry_templates.json`：15 類產業模板、模組、產業證據維度與權重。
- `data/field_definitions.json`：所有模板可引用的欄位字典。
- `tools/promote-candidates.mjs`：將選股頁候選股票升級為正式研究檔時，直接套用對應產業模板。
- `tools/update-data.mjs`：產業證據分數會依新維度對應到可解釋欄位。

下一步適合接資料來源管線，讓各產業的專屬欄位從公開資料逐步補強。
