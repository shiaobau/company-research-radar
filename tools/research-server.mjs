import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const port = Number(process.argv[3] || 8767);
const nodePath = process.execPath;
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

let task = {
  status: "idle",
  message: "尚未啟動研究流程",
  tickers: [],
  progress_percent: 0,
  current_step: null,
  started_at: null,
  finished_at: null,
  output: ""
};

let collectorTask = {
  status: "idle",
  message: "Targeted collector is idle.",
  tickers: [],
  started_at: null,
  finished_at: null,
  output: ""
};

let schedulerTask = {
  status: "idle",
  message: "Manual update is idle.",
  progress_percent: 0,
  current_step: null,
  started_at: null,
  finished_at: null,
  output: ""
};

function json(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error("Request body too large"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const candidate = path.resolve(root, path.normalize(decoded).replace(/^([/\\])+/, ""));
  return candidate.startsWith(root) ? candidate : root;
}

function runCommand(command, args, onOutput = () => {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      onOutput(output.slice(-8000));
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      onOutput(output.slice(-8000));
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`更新程序逾時（${Math.round(timeoutMs / 1000)} 秒），請稍後再試。`));
        return;
      }
      if (code === 0) resolve(output);
      else reject(new Error(output || `${command} exited with ${code}`));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function startResearch(tickers) {
  task = {
    status: "running",
    message: "準備研究流程",
    tickers,
    progress_percent: 0,
    current_step: { index: 0, total: 5, label: "準備研究流程" },
    started_at: new Date().toISOString(),
    finished_at: null,
    output: ""
  };

  try {
    task.message = "刷新公開資料來源中";
    task.progress_percent = 5;
    task.current_step = { index: 1, total: 5, label: task.message };
    await runCommand(nodePath, ["tools/source-cache.mjs", "--refresh"], (output) => { task.output = output; }, 180000);

    task.message = "建立研究檔中";
    task.progress_percent = 25;
    task.current_step = { index: 2, total: 5, label: task.message };
    await runCommand(nodePath, ["tools/promote-candidates.mjs", `--tickers=${tickers.join(",")}`], (output) => { task.output = output; }, 30000);

    task.message = "更新公開資料中";
    task.progress_percent = 45;
    task.current_step = { index: 3, total: 5, label: task.message };
    await runCommand(nodePath, ["tools/update-data.mjs", `--tickers=${tickers.join(",")}`], (output) => { task.output = output; }, 180000);

    task.message = "驗證評分資料中";
    task.progress_percent = 68;
    task.current_step = { index: 4, total: 5, label: task.message };
    const verificationOutput = await runCommand(nodePath, ["tools/verify-research-data.mjs", `--tickers=${tickers.join(",")}`, "--retry"], (output) => { task.output = output; }, 240000);
    const verification = JSON.parse(verificationOutput);

    task.message = "整理公司公告中";
    task.progress_percent = 88;
    task.current_step = { index: 5, total: 5, label: task.message };
    await runCommand(nodePath, ["tools/targeted-collector.mjs", `--tickers=${tickers.join(",")}`], (output) => { task.output = output; }, 90000);
    task.status = "done";
    task.progress_percent = 100;
    task.current_step = null;
    task.message = verification.incomplete_count
      ? `研究流程已完成；${verification.incomplete_count} 家資料待補。`
      : `完成分析：${tickers.join(", ")}`;
    task.finished_at = new Date().toISOString();
  } catch (error) {
    task.status = "error";
    task.current_step = null;
    task.message = error.message;
    task.finished_at = new Date().toISOString();
  }
}

async function startCollector(tickers) {
  collectorTask = {
    status: "running",
    message: "Collecting official disclosures for research companies...",
    tickers,
    started_at: new Date().toISOString(),
    finished_at: null,
    output: ""
  };
  try {
    await runCommand(nodePath, ["tools/targeted-collector.mjs", `--tickers=${tickers.join(",")}`], (output) => { collectorTask.output = output; });
    collectorTask.status = "done";
    collectorTask.message = `Collected research disclosures for ${tickers.join(", ")}.`;
    collectorTask.finished_at = new Date().toISOString();
  } catch (error) {
    collectorTask.status = "error";
    collectorTask.message = error.message;
    collectorTask.finished_at = new Date().toISOString();
  }
}

async function startManualFullUpdate() {
  schedulerTask = {
    status: "running",
    message: "Running the complete manual update.",
    progress_percent: 1,
    current_step: { label: "Starting complete update" },
    started_at: new Date().toISOString(),
    finished_at: null,
    output: ""
  };
  try {
    await runCommand(nodePath, ["tools/scheduled-update.mjs", "--slot=evening"], (output) => { schedulerTask.output = output; }, 420000);
    schedulerTask.status = "done";
    schedulerTask.message = "Manual full update completed.";
    schedulerTask.progress_percent = 100;
    schedulerTask.current_step = null;
    schedulerTask.finished_at = new Date().toISOString();
  } catch (error) {
    schedulerTask.status = "error";
    schedulerTask.message = error.message;
    schedulerTask.current_step = null;
    schedulerTask.finished_at = new Date().toISOString();
  }
}

async function handleApi(request, response) {
  if (request.method === "GET" && request.url.startsWith("/api/research-cache")) {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const ticker = String(url.searchParams.get("ticker") || "").trim();
    if (!/^\d{4}$/.test(ticker)) {
      json(response, 400, { status: "error", message: "A four-digit ticker is required." });
      return;
    }
    const cachePath = path.join(root, "data", "research_cache", `${ticker}.json`);
    if (!existsSync(cachePath)) {
      json(response, 404, { status: "missing", ticker, message: "No targeted research cache exists for this company." });
      return;
    }
    json(response, 200, JSON.parse(await readFile(cachePath, "utf8")));
    return;
  }

  if (request.method === "GET" && request.url.startsWith("/api/collector/status")) {
    json(response, 200, collectorTask);
    return;
  }

  if (request.method === "GET" && request.url.startsWith("/api/research/status")) {
    json(response, 200, task);
    return;
  }

  if (request.method === "GET" && request.url.startsWith("/api/scheduler/status")) {
    let persisted = null;
    try {
      persisted = JSON.parse(await readFile(path.join(root, "data", "scheduler_status.json"), "utf8")).current_run;
    } catch {
      // The in-memory task still provides a useful status when the file is temporarily unavailable.
    }
    json(response, 200, persisted && schedulerTask.status === "running"
      ? { ...schedulerTask, ...persisted, message: persisted.current_step?.label || schedulerTask.message }
      : schedulerTask);
    return;
  }

  if (request.method === "POST" && request.url.startsWith("/api/scheduler/manual")) {
    if (task.status === "running" || collectorTask.status === "running" || schedulerTask.status === "running") {
      json(response, 409, task.status === "running" ? task : collectorTask.status === "running" ? collectorTask : schedulerTask);
      return;
    }
    startManualFullUpdate();
    json(response, 202, { status: "running", message: "Manual full update started." });
    return;
  }

  if (request.method === "POST" && request.url.startsWith("/api/collector")) {
    if (task.status === "running" || collectorTask.status === "running") {
      json(response, 409, collectorTask.status === "running" ? collectorTask : task);
      return;
    }
    const payload = JSON.parse(await readBody(request) || "{}");
    const tickers = [...new Set((payload.tickers || [])
      .map((ticker) => String(ticker).trim())
      .filter((ticker) => /^\d{4}$/.test(ticker)))];
    if (!tickers.length) {
      json(response, 400, { status: "error", message: "At least one four-digit ticker is required." });
      return;
    }
    startCollector(tickers);
    json(response, 202, { status: "running", message: "Targeted collection started.", tickers });
    return;
  }

  if (request.method === "POST" && request.url.startsWith("/api/research")) {
    if (task.status === "running") {
      json(response, 409, task);
      return;
    }
    const payload = JSON.parse(await readBody(request) || "{}");
    const tickers = [...new Set((payload.tickers || [])
      .map((ticker) => String(ticker).trim())
      .filter((ticker) => /^\d{4}$/.test(ticker)))]
      .sort((a, b) => a.localeCompare(b, "zh-Hant-TW"));

    if (!tickers.length) {
      json(response, 400, { status: "error", message: "請提供股票代號" });
      return;
    }

    startResearch(tickers);
    json(response, 202, {
      status: "running",
      message: "研究流程已啟動",
      tickers
    });
    return;
  }

  if (request.method === "DELETE" && request.url.startsWith("/api/company")) {
    if (task.status === "running" || collectorTask.status === "running" || schedulerTask.status === "running") {
      json(response, 409, task.status === "running" ? task : collectorTask.status === "running" ? collectorTask : schedulerTask);
      return;
    }
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const tickers = [...new Set(String(url.searchParams.get("tickers") || url.searchParams.get("ticker") || "")
      .split(",")
      .map((ticker) => ticker.trim())
      .filter((ticker) => /^\d{4}$/.test(ticker)))];
    if (!tickers.length) {
      json(response, 400, { status: "error", message: "請提供至少一個四碼股票代號" });
      return;
    }
    try {
      const output = await runCommand(nodePath, ["tools/remove-company.mjs", `--tickers=${tickers.join(",")}`]);
      json(response, 200, { status: "done", message: `已刪除 ${tickers.length} 家公司`, tickers, output });
    } catch (error) {
      json(response, 500, { status: "error", message: error.message });
    }
    return;
  }

  json(response, 404, { status: "error", message: "API not found" });
}

createServer(async (request, response) => {
  try {
    if (request.url.startsWith("/api/")) {
      await handleApi(request, response);
      return;
    }

    let filePath = safePath(request.url || "/");
    if (!existsSync(filePath)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    if (statSync(filePath).isDirectory()) filePath = path.join(filePath, "index.html");
    response.writeHead(200, {
      "content-type": types[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    json(response, 500, { status: "error", message: error.message });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Research server listening on http://127.0.0.1:${port}/`);
});
