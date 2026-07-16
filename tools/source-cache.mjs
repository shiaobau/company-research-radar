import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchJson, readJson } from "./data-sources.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");
const cacheDir = path.join(dataDir, "source_cache");
const catalogPath = path.join(dataDir, "source_catalog.json");
const statusPath = path.join(cacheDir, "_status.json");
let statusWriteQueue = Promise.resolve();

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function isFresh(fetchedAt, ttlHours) {
  const timestamp = Date.parse(fetchedAt || "");
  return Number.isFinite(timestamp) && Date.now() - timestamp <= ttlHours * 60 * 60 * 1000;
}

async function readCacheFile(filePath) {
  try {
    const cached = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(cached?.data) ? cached : null;
  } catch {
    return null;
  }
}

async function readStatus() {
  try {
    return JSON.parse(await readFile(statusPath, "utf8"));
  } catch {
    return { generated_at: null, sources: {} };
  }
}

async function updateStatus(id, value) {
  statusWriteQueue = statusWriteQueue.then(async () => {
    await mkdir(cacheDir, { recursive: true });
    const status = await readStatus();
    status.generated_at = new Date().toISOString();
    status.sources = status.sources || {};
    status.sources[id] = value;
    await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  });
  return statusWriteQueue;
}

async function fetchWithPowerShell(url, outputFile) {
  const command = "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri $env:CODEX_FETCH_URL -UseBasicParsing -TimeoutSec 35 -OutFile $env:CODEX_FETCH_OUT";
  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
      cwd: root,
      env: { ...process.env, CODEX_FETCH_URL: url, CODEX_FETCH_OUT: outputFile },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`PowerShell timeout for ${url}`));
    }, 50000);
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr || `PowerShell exited with ${code}`));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function downloadJson(url, tempFile) {
  try {
    await fetchWithPowerShell(url, tempFile);
    return JSON.parse(await readFile(tempFile, "utf8"));
  } catch (powerShellError) {
    await unlink(tempFile).catch(() => {});
    try {
      const data = await fetchJson(url, 2, 20000);
      await writeFile(tempFile, `${JSON.stringify(data)}\n`, "utf8");
      return data;
    } catch (nodeError) {
      throw new Error(`PowerShell failed: ${powerShellError.message}; Node fetch failed: ${nodeError.message}`);
    }
  }
}

export async function loadSourceCatalog() {
  const catalog = await readJson(catalogPath);
  return catalog.sources || [];
}

export async function getCachedSource(id, options = {}) {
  const catalog = await loadSourceCatalog();
  const source = catalog.find((item) => item.id === id);
  if (!source) throw new Error(`Unknown cached source: ${id}`);

  await mkdir(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, `${id}.json`);
  const cached = await readCacheFile(cacheFile);
  const ttlHours = options.ttlHours ?? source.ttl_hours ?? 12;
  const allowStale = options.allowStale !== false;

  if (cached && !options.force && isFresh(cached.fetched_at, ttlHours)) {
    await updateStatus(id, {
      title: source.title,
      url: source.url,
      status: "fresh",
      fetched_at: cached.fetched_at,
      row_count: cached.data.length,
      ttl_hours: ttlHours
    });
    return { ...cached, cache_status: "fresh" };
  }

  const tempFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    const data = await downloadJson(source.url, tempFile);
    if (!Array.isArray(data)) throw new Error("Expected an array response");
    const payload = {
      source_id: id,
      title: source.title,
      url: source.url,
      fetched_at: new Date().toISOString(),
      row_count: data.length,
      data
    };
    await writeFile(tempFile, `${JSON.stringify(payload)}\n`, "utf8");
    await rename(tempFile, cacheFile);
    await updateStatus(id, {
      title: source.title,
      url: source.url,
      status: "updated",
      fetched_at: payload.fetched_at,
      row_count: payload.row_count,
      ttl_hours: ttlHours
    });
    return { ...payload, cache_status: "updated" };
  } catch (error) {
    await unlink(tempFile).catch(() => {});
    if (cached && allowStale) {
      await updateStatus(id, {
        title: source.title,
        url: source.url,
        status: "stale",
        fetched_at: cached.fetched_at,
        row_count: cached.data.length,
        ttl_hours: ttlHours,
        last_error: error.message
      });
      return { ...cached, cache_status: "stale", last_error: error.message };
    }
    await updateStatus(id, {
      title: source.title,
      url: source.url,
      status: "failed",
      fetched_at: cached?.fetched_at || null,
      row_count: cached?.data?.length || 0,
      ttl_hours: ttlHours,
      last_error: error.message
    });
    throw error;
  }
}

export async function getCachedRows(id, options = {}) {
  return (await getCachedSource(id, options)).data;
}

export async function getCachedRowsFor(ids, options = {}) {
  const rows = {};
  for (const id of ids) rows[id] = await getCachedRows(id, options);
  return rows;
}

async function main() {
  const ids = argValue("ids", "").split(",").map((item) => item.trim()).filter(Boolean);
  const statusOnly = process.argv.includes("--status");
  const force = process.argv.includes("--refresh");
  if (statusOnly) {
    console.log(JSON.stringify(await readStatus(), null, 2));
    return;
  }
  const catalog = await loadSourceCatalog();
  const targets = ids.length ? ids : catalog.map((source) => source.id);
  for (const id of targets) {
    const result = await getCachedSource(id, { force });
    console.log(`${id}: ${result.cache_status}, ${result.row_count} rows, ${result.fetched_at}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
