const encoder = new TextEncoder();

function response(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== env.DASHBOARD_ORIGIN) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    "vary": "Origin"
  };
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function timingSafeEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < left.byteLength; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

async function verifyPassword(password, encodedHash) {
  const [iterationsText, saltText, hashText] = String(encodedHash || "").split(":");
  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < 10000 || iterations > 100000 || !saltText || !hashText) {
    throw new Error("管理密碼設定格式無效。");
  }
  try {
    const salt = base64ToBytes(saltText);
    const expected = base64ToBytes(hashText);
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const derived = new Uint8Array(await crypto.subtle.deriveBits({
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations
    }, key, expected.byteLength * 8));
    return timingSafeEqual(derived, expected);
  } catch (error) {
    throw new Error(`管理密碼驗證無法完成：${error.message || "未知錯誤"}`);
  }
}

async function readJsonBody(request) {
  const text = await request.text();
  if (text.length > 4096) throw new Error("請求內容過大。");
  return JSON.parse(text || "{}");
}

function normalizeTickers(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("股票代碼格式不正確。");
  const tickers = [...new Set(value
    .map((ticker) => String(ticker || "").trim())
    .filter((ticker) => /^\d{4}$/.test(ticker)))].sort();
  if (tickers.length !== value.length || tickers.length > 20) {
    throw new Error("一次最多可研究 20 家公司，且代碼必須為四碼股票代碼。");
  }
  return tickers;
}

async function dispatchGithubWorkflow(env, tickers = [], slot = "manual") {
  const endpoint = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${encodeURIComponent(env.GITHUB_WORKFLOW)}/dispatches`;
  const result = await fetch(endpoint, {
    method: "POST",
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "company-research-radar-update-worker",
      "x-github-api-version": "2022-11-28"
    },
    body: JSON.stringify({
      ref: env.GITHUB_REF,
      inputs: { slot, tickers: tickers.join(",") }
    })
  });
  if (result.status === 204) return new Date().toISOString();
  const detail = await result.text();
  throw new Error(`GitHub 更新工作無法啟動（${result.status}）。${detail.slice(0, 240)}`);
}

function githubHeaders(env) {
  return {
    "accept": "application/vnd.github+json",
    "authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "user-agent": "company-research-radar-update-worker",
    "x-github-api-version": "2022-11-28"
  };
}

function scheduledSlot(cron) {
  if (cron === "15 0 * * 1-5") return "morning";
  if (cron === "20 9 * * 1-5") return "manual";
  if (cron === "30 12 * * 1-5") return "evening";
  return "manual";
}

async function workflowStatus(env, requestedAt) {
  const requestedMs = Date.parse(requestedAt || "");
  if (!Number.isFinite(requestedMs)) throw new Error("Missing update request time.");
  const runsEndpoint = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${encodeURIComponent(env.GITHUB_WORKFLOW)}/runs?event=workflow_dispatch&per_page=10`;
  const runsResponse = await fetch(runsEndpoint, { headers: githubHeaders(env) });
  if (!runsResponse.ok) throw new Error(`GitHub status request failed (${runsResponse.status}).`);
  const runsPayload = await runsResponse.json();
  const run = (runsPayload.workflow_runs || []).find((item) => Date.parse(item.created_at || "") >= requestedMs - 60000);
  if (!run) return { status: "queued", progress_percent: 3, phase: "queued" };
  if (run.status === "completed") {
    const succeeded = run.conclusion === "success";
    return {
      status: succeeded ? "done" : "error",
      progress_percent: succeeded ? 100 : 0,
      phase: succeeded ? "done" : "error",
      conclusion: run.conclusion || "unknown"
    };
  }
  const jobsResponse = await fetch(run.jobs_url, { headers: githubHeaders(env) });
  if (!jobsResponse.ok) return { status: "running", progress_percent: 10, phase: "starting" };
  const jobsPayload = await jobsResponse.json();
  const job = (jobsPayload.jobs || []).find((item) => item.status === "in_progress") || (jobsPayload.jobs || [])[0];
  const steps = job?.steps || [];
  const activeStep = steps.find((step) => step.status === "in_progress" || step.status === "queued");
  const completed = steps.filter((step) => step.status === "completed" && step.conclusion === "success").length;
  return {
    status: "running",
    progress_percent: Math.max(8, Math.min(95, Math.round((completed / Math.max(steps.length, 1)) * 100))),
    phase: activeStep?.name || job?.name || "running"
  };
}

export default {
  async scheduled(controller, env, ctx) {
    const slot = scheduledSlot(controller.cron);
    ctx.waitUntil((async () => {
      console.log(JSON.stringify({ event: "scheduled_update_started", cron: controller.cron, slot }));
      try {
        const requestedAt = await dispatchGithubWorkflow(env, [], slot);
        console.log(JSON.stringify({ event: "scheduled_update_dispatched", cron: controller.cron, slot, requestedAt }));
      } catch (error) {
        console.error(JSON.stringify({
          event: "scheduled_update_failed",
          cron: controller.cron,
          slot,
          message: error instanceof Error ? error.message : String(error)
        }));
        throw error;
      }
    })());
  },

  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (!cors) return response({ status: "error", message: "不允許的來源。" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/manual-update/status") {
      try {
        return response(await workflowStatus(env, url.searchParams.get("requested_at")), 200, cors);
      } catch (error) {
        return response({ status: "error", message: error.message || "Unable to read update status." }, 500, cors);
      }
    }
    if (request.method !== "POST" || url.pathname !== "/manual-update") {
      return response({ status: "error", message: "找不到更新端點。" }, 404, cors);
    }
    if (!env.UPDATE_PASSWORD_HASH) {
      return response({ status: "error", message: "尚未設定管理更新密碼。" }, 503, cors);
    }

    try {
      const payload = await readJsonBody(request);
      const password = typeof payload.password === "string" ? payload.password : "";
      if (!password || password.length > 512 || !(await verifyPassword(password, env.UPDATE_PASSWORD_HASH))) {
        return response({ status: "error", message: "更新密碼不正確。" }, 401, cors);
      }
      const tickers = normalizeTickers(payload.tickers);
      const requestedAt = await dispatchGithubWorkflow(env, tickers);
      const message = tickers.length
        ? `研究已送出：${tickers.join("、")}。GitHub Actions 會建立研究檔、更新資料並完成驗證。`
        : "完整更新已送出，正在等待 GitHub Actions 啟動。";
      return response({ status: "accepted", requested_at: requestedAt, tickers, message }, 202, cors);
    } catch (error) {
      return response({ status: "error", message: error.message || "無法啟動完整更新。" }, 500, cors);
    }
  }
};
