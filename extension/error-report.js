// 확장 오류 원격 보고
// 같은 (code, where)는 storage에 횟수·처음·마지막 시각으로 모았다가 background 알람 틱에 묶어 보낸다.
// 원본 에러 메시지·스택·시청 콘텐츠는 받지도 저장하지도 않는다. 보고 자체의 실패는 절대 throw하지 않는다.

// server/routes/client-errors-validate.js의 목록과 맞춰야 한다
export const CLIENT_ERROR_CODES = new Set([
  "RECORD_FAILED",
  "QUEUE_CRASHED",
  "TASK_CRASHED",
  "SYNC_STALLED",
  "POPUP_BOOT_FAILED",
]);

export const CLIENT_ERROR_WHERE = new Set([
  "content.recordVideo",
  "background.queue.participants",
  "background.queue.sessions",
  "background.queue.video_events",
  "background.queue.watch_stats",
  "background.serverTasks",
  "background.sessionTimeout",
  "background.persistServerUrl",
  "popup.boot",
]);

const BUFFER_KEY = "pendingClientErrors";
const LAST_FLUSH_KEY = "clientErrorsLastFlushAt";
export const MIN_FLUSH_INTERVAL_MS = 15 * 60 * 1000;
export const MAX_ERRORS_PER_REQUEST = 20;

// 모으기와 보내기가 같은 버퍼를 읽고 쓰므로 한 줄로 세운다
let chain = Promise.resolve();
function serialize(run) {
  const next = chain.then(run);
  chain = next.catch(() => {});
  return next;
}

/**
 * 오류 1건을 버퍼에 더한다. 목록에 없는 code·where는 버린다.
 * @param {string} code
 * @param {string} where
 * @param {Date} [now]
 * @returns {Promise<void>}
 */
export function reportClientError(code, where, now = new Date()) {
  if (!CLIENT_ERROR_CODES.has(code) || !CLIENT_ERROR_WHERE.has(where)) {
    console.warn(`[error-report] 알 수 없는 오류 보고 무시: ${code} ${where}`);
    return Promise.resolve();
  }
  return serialize(async () => {
    const { [BUFFER_KEY]: buffer = {} } =
      await chrome.storage.local.get(BUFFER_KEY);
    const key = `${code}|${where}`;
    const at = now.toISOString();
    const prev = buffer[key];
    buffer[key] = prev
      ? { ...prev, count: prev.count + 1, lastAt: at }
      : { code, where, count: 1, firstAt: at, lastAt: at };
    await chrome.storage.local.set({ [BUFFER_KEY]: buffer });
  }).catch((error) =>
    console.warn(`[error-report] 오류 보고 저장 실패: ${error?.message}`),
  );
}

/**
 * 서버로 보낼 본문. 허용 목록 필드만 새로 골라 담는다.
 * @param {object[]} entries
 * @param {string|null} anonymousId
 * @param {string} version
 */
export function buildClientErrorPayload(entries, anonymousId, version) {
  return {
    anonymousId: anonymousId ?? null,
    version,
    errors: entries.map(({ code, where, count, firstAt, lastAt }) => ({
      code,
      where,
      count,
      firstAt,
      lastAt,
    })),
  };
}

/**
 * 모인 오류를 최소 간격을 지켜 서버로 보낸다.
 * 400(서버가 영원히 거부)이면 버리고, 그 외 실패는 남겨 다음 틱에 다시 보낸다.
 * @param {(path: string, method: string, body: object) => Promise<{ok: boolean, kind: string, code: string|null}>} send - background의 sendToServer
 * @param {string|null} anonymousId
 * @param {Date} [now]
 * @returns {Promise<void>}
 */
export function flushClientErrors(send, anonymousId, now = new Date()) {
  return serialize(async () => {
    const { [BUFFER_KEY]: buffer = {}, [LAST_FLUSH_KEY]: lastFlushAt } =
      await chrome.storage.local.get([BUFFER_KEY, LAST_FLUSH_KEY]);
    const keys = Object.keys(buffer);
    if (keys.length === 0) return;
    if (lastFlushAt && now.getTime() - lastFlushAt < MIN_FLUSH_INTERVAL_MS) {
      return;
    }

    const sentKeys = keys.slice(0, MAX_ERRORS_PER_REQUEST);
    const result = await send(
      "/api/client-errors",
      "POST",
      buildClientErrorPayload(
        sentKeys.map((key) => buffer[key]),
        anonymousId,
        chrome.runtime.getManifest().version,
      ),
    );
    // config.js 미설정 환경은 요청이 나가지 않았으니 간격도 소비하지 않는다
    if (result.code === "no_server_url") return;

    // 전송 대기 중에 들어온 보고는 이 줄 뒤에 서므로 여기서 읽은 buffer가 최신이다
    if (result.ok || result.kind === "item") {
      for (const key of sentKeys) delete buffer[key];
    } else {
      console.warn(
        `[error-report] 오류 보고 전송 실패: status=${result.status} code=${result.code}`,
      );
    }
    await chrome.storage.local.set({
      [BUFFER_KEY]: buffer,
      [LAST_FLUSH_KEY]: now.getTime(),
    });
  }).catch((error) =>
    console.warn(`[error-report] 오류 보고 전송 중 예외: ${error?.message}`),
  );
}

const STALL_KEY = "syncStalls";
export const STALL_MIN_MS = 6 * 60 * 60 * 1000;
// 오프라인으로 잠든 PC가 깨어난 직후 한 번 실패한 것만으로 6시간이 찬 것처럼 보이지 않게, 실제 실패 횟수도 본다
export const STALL_MIN_FAILURES = 30;
// 재시도 큐 오류가 아니라 이 기기 설정·온보딩 상태라 전송 정체로 세지 않는다
const NOT_A_STALL_CODES = new Set(["no_server_url", "no_anonymous_id"]);

// 여러 큐가 같은 틱에 나란히 결과를 남기므로 따로 줄 세운다
let stallChain = Promise.resolve();

/**
 * 재시도 큐 한 틱의 결과를 남기고, 실패가 STALL_MIN_MS·STALL_MIN_FAILURES를 모두 넘기면
 * 연속 실패 구간마다 SYNC_STALLED를 한 번만 보고한다. 성공하면 구간을 끝낸다.
 * @param {string} queue - withQueueLock의 큐 이름
 * @param {{ok: boolean, code?: string|null}} outcome
 * @param {Date} [now]
 * @returns {Promise<void>}
 */
export function recordSyncOutcome(queue, outcome, now = new Date()) {
  if (!outcome.ok && NOT_A_STALL_CODES.has(outcome.code)) {
    return Promise.resolve();
  }
  const next = stallChain.then(async () => {
    const { [STALL_KEY]: stalls = {} } =
      await chrome.storage.local.get(STALL_KEY);
    const prev = stalls[queue];
    if (outcome.ok) {
      if (!prev) return;
      delete stalls[queue];
      await chrome.storage.local.set({ [STALL_KEY]: stalls });
      return;
    }

    const stall = prev
      ? { ...prev, failures: prev.failures + 1 }
      : { since: now.getTime(), failures: 1, reported: false };
    const due =
      !stall.reported &&
      now.getTime() - stall.since >= STALL_MIN_MS &&
      stall.failures >= STALL_MIN_FAILURES;
    if (due) stall.reported = true;
    stalls[queue] = stall;
    await chrome.storage.local.set({ [STALL_KEY]: stalls });
    if (due) {
      await reportClientError("SYNC_STALLED", `background.queue.${queue}`, now);
    }
  });
  stallChain = next.catch(() => {});
  return next.catch((error) =>
    console.warn(`[error-report] 전송 정체 기록 실패: ${error?.message}`),
  );
}
