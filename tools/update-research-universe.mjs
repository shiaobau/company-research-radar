import path from "node:path";
import { readJson, writeJson } from "./data-sources.mjs";

const root = process.cwd();
const filePath = path.join(root, "data", "research_universes.json");

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : "";
}

function parseTickers(value) {
  return [...new Set(String(value || "")
    .split(/[\s,，、;；]+/)
    .map((ticker) => ticker.trim())
    .filter((ticker) => /^\d{4}$/.test(ticker)))];
}

const universeId = argValue("universe");
const action = argValue("action") || "add";
const tickers = parseTickers(argValue("tickers"));

if (!/^u[1-5]$/.test(universeId)) {
  throw new Error("研究宇宙必須為 u1 至 u5。");
}
if (!["add", "remove"].includes(action)) {
  throw new Error("研究宇宙操作只支援 add 或 remove。");
}
if (!tickers.length) {
  throw new Error("至少需要一個四碼股票代碼。");
}

const payload = await readJson(filePath);
const universe = (payload.universes || []).find((item) => item.id === universeId);
if (!universe) throw new Error(`找不到研究宇宙 ${universeId}。`);

const current = Array.isArray(universe.tickers) ? universe.tickers.map(String) : [];
if (action === "add") {
  universe.tickers = [...new Set([...current, ...tickers])];
} else {
  const removed = new Set(tickers);
  universe.tickers = current.filter((ticker) => !removed.has(ticker));
}

payload.updated_at = new Date().toISOString();
await writeJson(filePath, payload);

console.log(JSON.stringify({
  universe_id: universeId,
  action,
  changed_tickers: tickers,
  total_tickers: universe.tickers.length
}, null, 2));
