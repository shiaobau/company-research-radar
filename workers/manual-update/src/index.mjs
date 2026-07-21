const encoder = new TextEncoder();
const ATTEMPT_WINDOW_SECONDS = 10 * 60;
const MAX_FAILED_ATTEMPTS = 5;

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
    "access-control-allow-methods": "POST, OPTIONS",
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
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000 || !saltText || !hashText) return false;
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
  } catch {
    return false;
  }
}

async function attemptKey(request) {
  const address = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(address));
  return `manual-update:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function readAttempts(env, key) {
  if (!env.UPDATE_ATTEMPTS) throw new Error("缺少更新嘗試節流設定。");
  const stored = await env.UPDATE_ATTEMPTS.get(key, "json");
  return stored && Number.isInteger(stored.count) ? stored : { count: 0 };
}

async function isRateLimited(env, key) {
  const attempts = await readAttempts(env, key);
  return attempts.count >= MAX_FAILED_ATTEMPTS;
}

async function recordFailure(env, key) {
  const attempts = await readAttempts(env, key);
  await env.UPDATE_ATTEMPTS.put(key, JSON.stringify({ count: attempts.count + 1 }), { expirationTtl: ATTEMPT_WINDOW_SECONDS });
}

async function clearFailures(env, key) {
  await env.UPDATE_ATTEMPTS.delete(key);
}

async function readJsonBody(request) {
  const text = await request.text();
  if (text.length > 4096) throw new Error("請求內容過大。");
  return JSON.parse(text || "{}");
}

async function dispatchGithubWorkflow(env) {
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
    body: JSON.stringify({ ref: env.GITHUB_REF, inputs: { slot: "manual" } })
  });
  if (result.status === 204) return;
  const detail = await result.text();
  throw new Error(`GitHub 更新工作無法啟動（${result.status}）。${detail.slice(0, 240)}`);
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (!cors) return response({ status: "error", message: "不允許的來源。" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/manual-update") {
      return response({ status: "error", message: "找不到更新端點。" }, 404, cors);
    }

    try {
      const key = await attemptKey(request);
      if (await isRateLimited(env, key)) {
        return response({ status: "error", message: "嘗試次數過多，請 10 分鐘後再試。" }, 429, cors);
      }
      const payload = await readJsonBody(request);
      const password = typeof payload.password === "string" ? payload.password : "";
      if (!password || password.length > 512 || !(await verifyPassword(password, env.UPDATE_PASSWORD_HASH))) {
        await recordFailure(env, key);
        return response({ status: "error", message: "更新密碼不正確。" }, 401, cors);
      }
      await clearFailures(env, key);
      await dispatchGithubWorkflow(env);
      return response({ status: "accepted", message: "完整更新已送出；GitHub Actions 會更新公開資料、官方公告事件與評分。" }, 202, cors);
    } catch (error) {
      return response({ status: "error", message: error.message || "無法啟動完整更新。" }, 500, cors);
    }
  }
};
