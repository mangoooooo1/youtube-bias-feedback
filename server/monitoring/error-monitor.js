#!/usr/bin/env node
/**
 * PM2 에러 로그 무음 실패 감시 (cron 실행용)
 *
 * - Tier 1(즉시): [Error] (errorHandler) + [sessions] 오늘 리뷰 생성 오류
 *   이미 안쪽에 fallback/방어 로직이 있는데도 뚫고 올라온 구조적 실패라 1건만 나와도 알린다.
 * - Tier 2(임계값): [youtube] API 오류:/[youtube] 네트워크 오류/[today-review-llm] API error body
 *   이미 fallback 경로가 있는 외부 API 호출 실패라, 1건은 일시적 네트워크 blip일 수 있어 노이즈가 된다.
 *   같은 실행 주기(30분) 안에서 같은 지문이 TIER2_MIN_OCCURRENCES회 이상 나올 때만 알린다.
 *
 * 매번 로그 전체를 다시 읽지 않고 마지막 확인 지점 이후만 읽는다.
 * 같은 에러가 반복돼도 이메일이 반복 발송되지 않도록 지문(fingerprint) + 쿨다운으로
 * 중복 알림을 억제하되, 쿨다운이 지나 다시 발생하면 그 사이 누적 횟수와 함께 재알림한다.
 *
 * 사용:
 *   ERROR_LOG_PATH=/home/ubuntu/.pm2/logs/youtube-bias-server-error.log \
 *     node server/monitoring/error-monitor.js
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { readState, writeState } = require("./state");
const {
  pingSuccess,
  pingFail,
  shouldPersistState,
} = require("./healthchecks-ping");

const PING_ENV_VAR = "ERROR_MONITOR_PING_URL";
const STATE_NAME = "error-monitor";
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

// Tier 1: 구조적 실패 — 1건만 나와도 즉시 알린다.
const TIER1_PREFIXES = [
  "[Error] ",
  "[sessions] 오늘 리뷰 생성 오류:",
  "[access] ",
];

// Tier 2: 이미 fallback 경로가 있는 외부 API 호출 실패
// 같은 실행 주기(30분) 안에서 같은 지문이 TIER2_MIN_OCCURRENCES회 이상 나올 때만 알린다.
// 실제 YouTube API 사고는 29시간 동안 4017건이 쌓일 정도로 사고성 패턴은 이 임계값을 훌쩍 넘긴다.
const TIER2_PREFIXES = [
  "[youtube] API 오류:",
  "[youtube] 네트워크 오류:",
  "[today-review-llm] API error body:",
];
const TIER2_MIN_OCCURRENCES = 5;

const ALL_PREFIXES = [...TIER1_PREFIXES, ...TIER2_PREFIXES];

/** 로그 텍스트 중 Tier 1·Tier 2 접두사에 해당하는 라인만 추출한다. */
function extractErrorLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => ALL_PREFIXES.some((prefix) => line.startsWith(prefix)));
}

/**
 * 라인의 접두사로 Tier를 판정한다. 알려지지 않은 접두사는 방어적으로 1(즉시)로 취급한다.
 * 무음 실패를 만드느니 과알림이 낫다.
 */
function classifyTier(message) {
  if (TIER1_PREFIXES.some((prefix) => message.startsWith(prefix))) return 1;
  if (TIER2_PREFIXES.some((prefix) => message.startsWith(prefix))) return 2;
  return 1;
}

// sessionId·videoId 같은 숫자·UUID를 지우면, 같은 종류의 에러는 매번 같은 문자열로 정규화된다.
function normalizeMessage(message) {
  return message
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "#",
    )
    .replace(/\d+/g, "#");
}

function fingerprint(message) {
  return crypto
    .createHash("sha256")
    .update(normalizeMessage(message))
    .digest("hex")
    .slice(0, 10);
}

/**
 * 새로 추가된 로그 바이트만 읽는다. 파일이 로테이션됐으면(inode 변경 또는 저장된
 * offset보다 파일이 작아짐) 커서를 0으로 리셋해 새 파일 전체를 새로 읽는다.
 * fsImpl을 주입해 파일시스템 없이 테스트 가능.
 *
 * ok:false(파일 없음·읽기 실패)와 "파일은 읽었지만 새 내용이 없음"을 반드시 구분해서
 * 반환한다 — 둘 다 text:""로 합쳐버리면, ERROR_LOG_PATH가 잘못됐을 때도 "새 에러 없음"으로
 * 오인해 매번 성공 ping을 보내는 무음 실패가 된다(감시 대상을 실제로는 하나도 못 읽고
 * 있는데 계속 "정상"으로 보고하는, 이 스크립트가 막으려는 문제를 스스로 재현하는 셈).
 */
function readNewText(filePath, cursor = {}, fsImpl = fs) {
  let stat;
  try {
    if (!fsImpl.existsSync(filePath)) {
      return {
        text: "",
        cursor: { inode: null, offset: 0 },
        ok: false,
        reason: `파일 없음: ${filePath}`,
      };
    }
    stat = fsImpl.statSync(filePath);
  } catch (err) {
    return {
      text: "",
      cursor: { inode: null, offset: 0 },
      ok: false,
      reason: err.message,
    };
  }

  const rotated =
    (cursor.inode != null && cursor.inode !== stat.ino) ||
    (cursor.offset ?? 0) > stat.size;
  const startOffset = rotated ? 0 : (cursor.offset ?? 0);

  const length = stat.size - startOffset;
  if (length <= 0) {
    return {
      text: "",
      cursor: { inode: stat.ino, offset: stat.size },
      ok: true,
    };
  }

  try {
    const fd = fsImpl.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      fsImpl.readSync(fd, buffer, 0, length, startOffset);
      return {
        text: buffer.toString("utf8"),
        cursor: { inode: stat.ino, offset: stat.size },
        ok: true,
      };
    } finally {
      fsImpl.closeSync(fd);
    }
  } catch (err) {
    // 권한 문제 등으로 열기/읽기 자체가 실패한 경우 — 커서는 건드리지 않고 실패로 보고한다.
    return { text: "", cursor, ok: false, reason: err.message };
  }
}

/**
 * 새로 발견된 에러 라인들과 기존 지문 상태를 비교해 알림 대상을 정한다.
 * 순수 함수 — 파일시스템/네트워크 없이 테스트 가능.
 */
function decideAlerts(
  errorLines,
  fingerprints = {},
  now = Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
  tier2MinOccurrences = TIER2_MIN_OCCURRENCES,
) {
  const updated = { ...fingerprints };
  const alerts = [];

  // 같은 지문이 이번 실행에서 여러 번 나와도(짧은 시간에 반복 발생) 하나의 알림으로 묶는다.
  const grouped = new Map();
  for (const line of errorLines) {
    const fp = fingerprint(line);
    if (!grouped.has(fp)) grouped.set(fp, { message: line, count: 0 });
    grouped.get(fp).count += 1;
  }

  for (const [fp, { message, count }] of grouped) {
    // Tier 2는 이번 실행에서 새로 읽은 구간 안의 발생 횟수가 임계값을 넘을 때만
    // 알림 대상으로 취급한다. 미달이면 이번 실행에서는 조용히 건너뛰고
    // 다음 실행에서 새로 집계한다. 여러 실행에 걸쳐 조금씩 나뉘어 쌓이는 패턴은
    // 이 설계로는 못 잡는다는 점은 의도적으로 감수한 단순화다.
    if (classifyTier(message) === 2 && count < tier2MinOccurrences) continue;

    const prev = updated[fp];
    if (!prev) {
      updated[fp] = { firstSeenAt: now, lastAlertedAt: now, count };
      alerts.push({ fingerprint: fp, message, count, isNew: true });
      continue;
    }
    const totalCount = prev.count + count;
    if (now - prev.lastAlertedAt >= cooldownMs) {
      updated[fp] = { ...prev, lastAlertedAt: now, count: totalCount };
      alerts.push({
        fingerprint: fp,
        message,
        count: totalCount,
        isNew: false,
      });
    } else {
      // 쿨다운 안이면 알리지 않되, 누적 횟수는 계속 세어 다음 알림 때 정확한 횟수를 알린다.
      updated[fp] = { ...prev, count: totalCount };
    }
  }

  return { alerts, fingerprints: updated };
}

async function main() {
  const logPath = process.env.ERROR_LOG_PATH;
  if (!logPath) {
    console.error("[error-monitor] ERROR_LOG_PATH 환경변수가 필요합니다.");
    await pingFail(
      PING_ENV_VAR,
      "ERROR_LOG_PATH 환경변수 누락 — 설정 확인 필요",
    );
    process.exitCode = 1;
    return;
  }

  const state = readState(STATE_NAME, { cursor: {}, fingerprints: {} });
  const { text, cursor, ok, reason } = readNewText(logPath, state.cursor);

  if (!ok) {
    // 커서는 갱신하지 않는다 — 경로가 고쳐지면 다음 실행이 정상적으로 이어받아야 한다.
    await pingFail(
      PING_ENV_VAR,
      `ERROR_LOG_PATH를 읽을 수 없습니다(${logPath}): ${reason}`,
    );
    console.error(`[error-monitor] 로그 읽기 실패(${logPath}):`, reason);
    process.exitCode = 1;
    return;
  }

  const errorLines = extractErrorLines(text);
  const { alerts, fingerprints } = decideAlerts(errorLines, state.fingerprints);

  let pingResult;
  if (alerts.length === 0) {
    pingResult = await pingSuccess(PING_ENV_VAR);
    console.log(
      `[error-monitor] 새 에러 없음 (신규 라인 ${errorLines.length}줄 검사)`,
    );
  } else {
    const detail = alerts
      .map((a) => `[${a.isNew ? "신규" : "재발"} x${a.count}] ${a.message}`)
      .join("\n");
    pingResult = await pingFail(PING_ENV_VAR, detail);
    console.error(
      `[error-monitor] 알림 대상 에러 ${alerts.length}건:\n${detail}`,
    );
  }

  if (!shouldPersistState(pingResult)) {
    console.error(
      "[error-monitor] Healthchecks.io 전송 실패 — 상태 저장을 보류하고 다음 실행에서 처음부터 재시도합니다.",
    );
    process.exitCode = 1;
    return;
  }

  writeState(STATE_NAME, { cursor, fingerprints });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[error-monitor] 스크립트 오류:", err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  extractErrorLines,
  normalizeMessage,
  fingerprint,
  readNewText,
  decideAlerts,
  shouldPersistState,
  classifyTier,
};
