import { existsSync, statSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { readJson, writeJson } from "./data-sources.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");
const statusPath = path.join(dataDir, "scheduler_status.json");
const lockPath = path.join(dataDir, ".scheduled-update.lock");
const slot = (process.argv.find((arg) => arg.startsWith("--slot=")) || "--slot=market_close").slice(7);
const dryRun = process.argv.includes("--dry-run");

const SCHEDULES = {
  morning: {
    label: "早晨公告補漏",
    time: "08:15",
    description: "更新重大訊息快取與研究公司事件。",
    steps: [
      ["tools/source-cache.mjs", "--refresh", "--ids=twse_material_events,tpex_material_events"],
      ["tools/targeted-collector.mjs"]
    ]
  },
  market_close: {
    label: "收盤完整更新",
    time: "14:15",
    description: "更新官方快取、價格與評分，再刷新研究事件。",
    steps: [
      ["tools/source-cache.mjs", "--refresh"],
      ["tools/update-data.mjs"],
      ["tools/targeted-collector.mjs"]
    ]
  },
  evening: {
    label: "晚間公告補更新",
    time: "20:30",
    description: "更新重大訊息、違規與股權資料，再刷新研究事件。",
    steps: [
      [
        "tools/source-cache.mjs",
        "--refresh",
        "--ids=twse_material_events,tpex_material_events,twse_major_shareholders,tpex_major_shareholders,twse_insider_transfer,tpex_insider_transfer,twse_disclosure_violations,tpex_disclosure_violations"
      ],
      ["tools/targeted-collector.mjs"]
    ]
  }
};

// Keep user-facing scheduler labels ASCII-safe in source while emitting UTF-8 JSON.
const WEEKDAY_LABEL = "\u5e73\u65e5";
const DAILY_LABEL = "\u6bcf\u65e5";
Object.assign(SCHEDULES.morning, {
  label: "\u65e9\u9593\u4e8b\u4ef6\u66f4\u65b0",
  description: "\u66f4\u65b0\u91cd\u5927\u8a0a\u606f\u8207\u76ee\u6a19\u5f0f\u8cc7\u6599\u6536\u96c6\u3002"
});
Object.assign(SCHEDULES.market_close, {
  label: "\u6536\u76e4\u8cc7\u6599\u66f4\u65b0",
  description: "\u66f4\u65b0\u516c\u958b\u8cc7\u6599\u3001\u8a55\u5206\u8207\u7814\u7a76\u5feb\u53d6\u3002"
});
Object.assign(SCHEDULES.evening, {
  label: "\u665a\u9593\u6cbb\u7406\u66f4\u65b0",
  description: "\u66f4\u65b0\u91cd\u5927\u8a0a\u606f\u3001\u80a1\u6b0a\u3001\u9055\u898f\u8207\u76ee\u6a19\u5f0f\u6536\u96c6\u3002"
});

function defaultStatus() {
  return {
    version: "1.0.0",
    timezone: "Asia/Taipei",
    frequency: "weekday",
    frequency_label: "平日",
    generated_at: null,
    current_run: null,
    schedules: Object.fromEntries(Object.entries(SCHEDULES).map(([id, config]) => [id, {
      label: config.label,
      time: config.time,
      description: config.description,
      last_run: null
    }]))
  };
}

async function loadStatus() {
  try {
    const existing = await readJson(statusPath);
    return normalizeStatus(existing);
  } catch {
    return normalizeStatus({});
  }
}

function normalizeStatus(existing) {
  const defaults = defaultStatus();
  const frequency = existing.frequency === "daily" ? "daily" : "weekday";
  const schedules = Object.fromEntries(Object.entries(SCHEDULES).map(([id, config]) => {
    const prior = existing.schedules?.[id] || {};
    const lastRun = prior.last_run ? { ...prior.last_run, label: config.label } : null;
    return [id, { ...defaults.schedules[id], ...prior, label: config.label, description: config.description, last_run: lastRun }];
  }));
  return {
    ...defaults,
    ...existing,
    frequency,
    frequency_label: frequency === "daily" ? DAILY_LABEL : WEEKDAY_LABEL,
    schedules
  };
}

async function saveStatus(status) {
  status.generated_at = new Date().toISOString();
  await writeJson(statusPath, status);
}

async function acquireLock() {
  await mkdir(dataDir, { recursive: true });
  if (existsSync(lockPath)) {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (ageMs > 3 * 60 * 60 * 1000) await unlink(lockPath).catch(() => {});
  }
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ slot, started_at: new Date().toISOString(), pid: process.pid }));
    return handle;
  } catch (error) {
    if (error.code === "EEXIST") return null;
    throw error;
  }
}

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(output || `${script} exited with ${code}`));
    });
  });
}

async function main() {
  const status = await loadStatus();
  if (process.argv.includes("--repair-status")) {
    await saveStatus(status);
    console.log(JSON.stringify({ status: "repaired" }));
    return;
  }

  const config = SCHEDULES[slot];
  if (!config) throw new Error(`Unknown schedule slot: ${slot}`);
  const lock = await acquireLock();
  if (!lock) {
    status.schedules[slot].last_run = {
      status: "skipped",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      message: "Another scheduled update is already running."
    };
    await saveStatus(status);
    console.log(JSON.stringify({ status: "skipped", slot, reason: "lock_exists" }));
    return;
  }

  const startedAt = new Date().toISOString();
  const run = { slot, label: config.label, status: "running", started_at: startedAt, steps: [] };
  status.current_run = run;
  await saveStatus(status);

  try {
    for (const [script, ...args] of config.steps) {
      const stepStartedAt = new Date().toISOString();
      const output = dryRun ? "Dry run: command skipped." : await runNode(script, args);
      run.steps.push({
        script,
        args,
        status: "done",
        started_at: stepStartedAt,
        finished_at: new Date().toISOString(),
        output_tail: output.slice(-1200)
      });
      status.current_run = run;
      await saveStatus(status);
    }
    run.status = dryRun ? "dry_run" : "done";
    run.finished_at = new Date().toISOString();
    const companies = await readJson(path.join(dataDir, "companies.json"));
    run.company_count = (companies.companies || []).length;
    status.schedules[slot].last_run = run;
    status.current_run = null;
    await saveStatus(status);
    console.log(JSON.stringify({ status: run.status, slot, company_count: run.company_count, steps: run.steps.length }, null, 2));
  } catch (error) {
    run.status = "error";
    run.finished_at = new Date().toISOString();
    run.error = error.message;
    status.schedules[slot].last_run = run;
    status.current_run = null;
    await saveStatus(status);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

await main();
