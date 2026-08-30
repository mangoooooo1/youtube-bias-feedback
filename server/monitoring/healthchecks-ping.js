// Healthchecks.io ping 공유 헬퍼
// 모니터링 스크립트들의 실패 유무를 알리는 유일한 통로.

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_BODY_LENGTH = 10000; // Healthchecks.io ping 본문(로그) 상한

// 네트워크 지연으로 무한 대기하면 뒤이은 크론 작업까지 막힐 수 있어 타임아웃을 건다
// (server/scripts/backup-db.js의 SSH 타임아웃과 동일한 이유).
async function ping(
  envVarName,
  {
    method = "GET",
    suffix = "",
    body,
    fetchImpl = fetch,
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  const url = env[envVarName];
  if (!url) {
    console.warn(
      `[healthchecks] ${envVarName} 환경변수가 없어 ping을 건너뜁니다.`,
    );
    return { skipped: true, ok: false };
  }

  const target = `${url.replace(/\/$/, "")}${suffix}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await fetchImpl(target, { method, body, signal: controller.signal });
    return { skipped: false, ok: true };
  } catch (err) {
    // ping 실패가 모니터링 스크립트 자체를 죽이면 안 된다 — 경고만 남기고 계속 진행.
    console.warn(`[healthchecks] ping 실패(${envVarName}):`, err.message);
    return { skipped: false, ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 정상 완료 신호. */
function pingSuccess(envVarName, opts = {}) {
  return ping(envVarName, { method: "GET", ...opts });
}

/** 실패 신호. detail은 Healthchecks.io에 로그로 남는 본문(최대 10KB로 절단). */
function pingFail(envVarName, detail = "", opts = {}) {
  return ping(envVarName, {
    method: "POST",
    suffix: "/fail",
    body: String(detail).slice(0, MAX_BODY_LENGTH),
    ...opts,
  });
}

module.exports = { ping, pingSuccess, pingFail };
