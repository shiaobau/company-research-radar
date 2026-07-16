import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DATA_VERSION = "0.7.0";

export const SOURCE_CATALOG = [
  {
    id: "twse_stock_day",
    title: "臺灣證券交易所：個股日成交資訊",
    short_title: "TWSE 股價",
    url: "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY",
    note: "上市公司個股日成交資訊，用於計算近一年價格區間、20/60 日趨勢。"
  },
  {
    id: "tpex_trading_stock",
    title: "證券櫃檯買賣中心：個股日成交資訊",
    short_title: "TPEx 股價",
    url: "https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock",
    note: "上櫃公司個股日成交資訊，用於計算近一年價格區間、20/60 日趨勢。"
  },
  {
    id: "twse_monthly_revenue",
    title: "臺灣證券交易所 OpenAPI：上市公司每月營業收入彙總表",
    short_title: "TWSE 月營收",
    url: "https://openapi.twse.com.tw/v1/opendata/t187ap05_L",
    note: "上市公司每月營收、MoM、YoY 與累計 YoY。"
  },
  {
    id: "tpex_monthly_revenue",
    title: "證券櫃檯買賣中心 OpenAPI：上櫃公司每月營業收入彙總表",
    short_title: "TPEx 月營收",
    url: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O",
    note: "上櫃公司每月營收、MoM、YoY 與累計 YoY。"
  },
  {
    id: "twse_income_statement",
    title: "臺灣證券交易所 OpenAPI：上市公司綜合損益表",
    short_title: "TWSE 損益",
    url: "https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci",
    note: "上市公司一般業綜合損益表，用於毛利率、營益率、淨利率與 EPS。"
  },
  {
    id: "tpex_income_statement",
    title: "證券櫃檯買賣中心 OpenAPI：上櫃公司綜合損益表",
    short_title: "TPEx 損益",
    url: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_ci",
    note: "上櫃公司一般業綜合損益表，用於毛利率、營益率、淨利率與 EPS。"
  },
  {
    id: "twse_balance_sheet",
    title: "臺灣證券交易所 OpenAPI：上市公司資產負債表",
    short_title: "TWSE 資產負債",
    url: "https://openapi.twse.com.tw/v1/opendata/t187ap07_L_ci",
    note: "上市公司一般業資產負債表，用於流動比率、負債比率與每股淨值。"
  },
  {
    id: "tpex_balance_sheet",
    title: "證券櫃檯買賣中心 OpenAPI：上櫃公司資產負債表",
    short_title: "TPEx 資產負債",
    url: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap07_O_ci",
    note: "上櫃公司一般業資產負債表，用於流動比率、負債比率與每股淨值。"
  },
  {
    id: "twse_material_events",
    title: "臺灣證券交易所 OpenAPI：上市公司每日重大訊息",
    short_title: "TWSE 重大訊息",
    url: "https://openapi.twse.com.tw/v1/opendata/t187ap04_L",
    note: "上市公司每日重大訊息，用於催化事件與新聞/重大訊息風險評分。"
  },
  {
    id: "tpex_material_events",
    title: "證券櫃檯買賣中心 OpenAPI：上櫃公司每日重大訊息",
    short_title: "TPEx 重大訊息",
    url: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O",
    note: "上櫃公司每日重大訊息，用於催化事件與新聞/重大訊息風險評分。"
  },
  {
    id: "twse_major_shareholders",
    title: "臺灣證券交易所 OpenAPI：上市公司持股逾 10% 大股東名單",
    short_title: "TWSE 大股東",
    url: "https://openapi.twse.com.tw/v1/opendata/t187ap02_L",
    note: "上市公司持股逾 10% 大股東名單，用於籌碼/股權結構評分。"
  },
  {
    id: "tpex_major_shareholders",
    title: "證券櫃檯買賣中心 OpenAPI：上櫃公司持股逾 10% 大股東名單",
    short_title: "TPEx 大股東",
    url: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap02_O",
    note: "上櫃公司持股逾 10% 大股東名單，用於籌碼/股權結構評分。"
  },
  {
    id: "twse_insider_transfer",
    title: "臺灣證券交易所 OpenAPI：上市公司每日內部人持股轉讓事前申報表",
    short_title: "TWSE 內部人轉讓",
    url: "https://openapi.twse.com.tw/v1/opendata/t187ap12_L",
    note: "上市公司內部人持股轉讓事前申報，用於籌碼/股權結構風險評分。"
  },
  {
    id: "tpex_insider_transfer",
    title: "證券櫃檯買賣中心 OpenAPI：上櫃公司每日內部人持股轉讓事前申報表",
    short_title: "TPEx 內部人轉讓",
    url: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap12_O",
    note: "上櫃公司內部人持股轉讓事前申報，用於籌碼/股權結構風險評分。"
  },
  {
    id: "twse_disclosure_violations",
    title: "臺灣證券交易所 OpenAPI：上市公司違反資訊申報、重大訊息及說明記者會規定專區",
    short_title: "TWSE 申報違規",
    url: "https://openapi.twse.com.tw/v1/opendata/t187ap23_L",
    note: "上市公司資訊申報與重大訊息違規資料，用於新聞/重大訊息風險評分。"
  },
  {
    id: "tpex_disclosure_violations",
    title: "證券櫃檯買賣中心 OpenAPI：上櫃公司違反資訊申報、重大訊息及說明記者會規定專區",
    short_title: "TPEx 申報違規",
    url: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap23_O",
    note: "上櫃公司資訊申報與重大訊息違規資料，用於新聞/重大訊息風險評分。"
  },
  {
    id: "tfda_open_data",
    title: "衛生福利部食品藥物管理署：食品藥物開放資料平臺",
    short_title: "TFDA 開放資料",
    url: "https://data.fda.gov.tw/",
    note: "用於追蹤健康食品許可、食品廣告違規、標示與食品安全相關公開資料。此版先建立可接入資料層，端點確認後可由更新腳本自動比對。"
  },
  {
    id: "tfda_health_food",
    title: "衛生福利部食品藥物管理署：健康食品查詢與許可資料",
    short_title: "TFDA 健康食品",
    url: "https://consumer.fda.gov.tw/Food/InfoHealthFood.aspx?nodeID=162",
    note: "用於逐品項查核健康食品許可、核准功效與許可證狀態。"
  },
  {
    id: "tfda_ad_compliance",
    title: "衛生福利部食品藥物管理署：食品廣告與宣稱合規資料",
    short_title: "TFDA 廣告合規",
    url: "https://consumer.fda.gov.tw/",
    note: "用於追蹤食品、健康食品與營養補充品廣告宣稱、裁罰或違規公告。"
  }
];

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function fetchJson(url, retries = 3, timeoutMs = 12000) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          "accept": "application/json,text/plain,*/*",
          "user-agent": "company-research-radar/0.5"
        },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} for ${url}`);
      }
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

export function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value)
    .replace(/,/g, "")
    .replace(/\s/g, "")
    .replace(/^\+/, "");
  if (normalized === "--" || normalized === "X0.00") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function clamp(value, min = 0, max = 100) {
  if (!Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, value));
}

export function rocDateToIso(value) {
  if (!value) return null;
  const parts = String(value).split("/");
  if (parts.length !== 3) return null;
  const year = Number(parts[0]) + 1911;
  const month = parts[1].padStart(2, "0");
  const day = parts[2].padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function rocCompactDateToIso(value) {
  if (!value) return null;
  const text = String(value).replace(/\D/g, "");
  if (text.length !== 7) return null;
  const year = Number(text.slice(0, 3)) + 1911;
  const month = text.slice(3, 5);
  const day = text.slice(5, 7);
  return `${year}-${month}-${day}`;
}

export function rocMonthToIso(value) {
  if (!value || String(value).length < 5) return null;
  const text = String(value);
  const year = Number(text.slice(0, 3)) + 1911;
  const month = text.slice(3, 5);
  return `${year}-${month}`;
}

export function monthStarts(endDate, count) {
  const months = [];
  for (let i = 0; i < count; i += 1) {
    const date = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - i, 1));
    months.push(date);
  }
  return months.reverse();
}

export function twDateParam(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}${month}01`;
}

export function tpexDateParam(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}/${month}/01`;
}

export function average(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

export function scoreByThresholds(value, thresholds, fallback = 50) {
  if (!Number.isFinite(value)) return fallback;
  for (const [min, score] of thresholds) {
    if (value >= min) return score;
  }
  return thresholds[thresholds.length - 1]?.[1] ?? fallback;
}

export function evidenceFromCount(count, high = 120, medium = 60) {
  if (count >= high) return "high";
  if (count >= medium) return "medium";
  if (count > 0) return "low";
  return "none";
}
