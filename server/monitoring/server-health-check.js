#!/usr/bin/env node
/**
 * 서버 헬스체크 모니터
 *
 * 자기 자신의 GET /health를 외부 관찰자처럼 주기적으로 확인해, 프로세스가 응답하지
 * 않거나(서버 다운) DB 접근이 실패한 상태(server/routes/health.js가 db:"fail"로 구분)를
 * Healthchecks.io로 알린다. PM2가 죽은 프로세스를 재시작해도 재시작 자체가 반복되는
 * 상황까지는 PM2만으로 알 수 없으므로 외부에서 주기적으로 찔러보는 이 확인이 필요하다.
 *
 * 사용:
 *   HEALTH_URL=https://viewlens.site/health node server/monitoring/server-health-check.js
 */
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { pingSuccess, pingFail } = require("./healthchecks-ping");

const DEFAULT_TIMEOUT_MS = 10000;
const PING_ENV_VAR = "SERVER_HEALTH_PING_URL";

/** 순수 판정 함수 — fetchImpl을 주입해 네트워크 없이 테스트 가능. */
async function checkHealth({
  healthUrl = process.env.HEALTH_URL || "http://localhost:3000/health",
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(healthUrl, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const body = await res.json();
    if (body?.data?.db !== "ok") {
      return { ok: false, reason: `db=${body?.data?.db ?? "unknown"}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const result = await checkHealth();
  if (result.ok) {
    await pingSuccess(PING_ENV_VAR);
    console.log("[server-health] 정상");
    return;
  }
  await pingFail(PING_ENV_VAR, `헬스체크 실패: ${result.reason}`);
  console.error("[server-health] 실패:", result.reason);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[server-health] 스크립트 오류:", err.message);
    process.exitCode = 1;
  });
}

module.exports = { checkHealth };
