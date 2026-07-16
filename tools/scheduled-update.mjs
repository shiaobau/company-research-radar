import { existsSync, statSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { readJson, writeJson } from "./data-sources.mjs";

const root = process.cwd();
const dataDir = path.join(root, "data");
const statusPath = path.join(dataDir, "scheduler_status.json");
const lockPath = path.join(dataDir, ".scheduled-update.lock");
const slot = (process.argv.find((arg) => arg.startsWith("--slot=")) || "--slot=morning").slice(7);
const dryRun = process.argv.includes("--dry-run");

const SCHEDULES = {
  morning: {
    label: "早間完整更新",
    time: "08:15",
    description: "完整更新公開資料、研究資料與 MOPS 歷史事件。"
  },
  evening: {
    label: "晚間完整更新",
    time: "20:30",
    description: "完整更新公開資料、研究資料與 MOPS 歷史事件。"
  }
};

const FULL_UPDATE_STEPS = [
  ["tools/source-cache.mjs", "--refresh"],
  ["tools/update-data.mjs"],
  ["tools/verify-research-data.mjs", "--retry"],
  ["tools/targeted-collector.mjs"]
];
for (const schedule of Object.values(SCHEDULES)) schedule.steps = FULL_UPDATE_STEPS;

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
  const frequency = "weekday";
  const schedules = Object.fromEntries(Object.entries(SCHEDULES).map(([id, config]) => {
    const prior = existing.schedules?.[id] || {};
    const lastRun = prior.last_run ? { ...prior.last_run, label: config.label } : null;
    return [id, { ...defaults.schedules[id], ...prior, label: config.label, description: config.description, last_run: lastRun }];
  }));
  return {
    ...defaults,
    ...existing,
    frequency,
    frequency_label: "平日",
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

function stepLabel(script) {
  if (script.endsWith("source-cache.mjs")) return "刷新公開資料來源";
  if (script.endsWith("update-data.mjs")) return "重建評分資料";
  if (script.endsWith("verify-research-data.mjs")) return "驗證與補抓缺失資料";
  if (script.endsWith("targeted-collector.mjs")) return "整理 MOPS 與官方公告";
  return script;
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
  const run = { slot, label: config.label, status: "running", started_at: startedAt, steps: [], progress_percent: 0, current_step: null };
  status.current_run = run;
  await saveStatus(status);

  try {
    for (const [index, [script, ...args]] of config.steps.entries()) {
      run.current_step = { index: index + 1, total: config.steps.length, label: stepLabel(script) };
      run.progress_percent = Math.round((index / config.steps.length) * 100);
      status.current_run = run;
      await saveStatus(status);
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
    run.progress_percent = 100;
    run.current_step = null;
    run.finished_at = new Date().toISOString();
    const companies = await readJson(path.join(dataDir, "companies.json"));
    run.company_count = (companies.companies || []).length;
    status.schedules[slot].last_run = run;
    status.current_run = null;
    await saveStatus(status);
    console.log(JSON.stringify({ status: run.status, slot, company_count: run.company_count, steps: run.steps.length }, null, 2));
  } catch (error) {
    run.status = "error";
    run.current_step = null;
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
