#!/usr/bin/env node
/**
 * PM2 에러 로그 무음 실패 감시 (cron 실행용)
 *
 * server/middleware/responseHandler.js의 errorHandler가 남기는 `[Error] ...` 라인만
 * 감시 대상으로 삼는다. 이 접두사는 "예상 못 한 서버 예외"에만 붙으므로, 검증 실패 같은
 * 정상적인 4xx 응답은 fail()에서 바로 반환돼 애초에 여기 걸리지 않는다.
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
const { pingSuccess, pingFail } = require("./healthchecks-ping");

const PING_ENV_VAR = "ERROR_MONITOR_PING_URL";
const STATE_NAME = "error-monitor";
const ERROR_PREFIX = "[Error] ";
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

/** 로그 텍스트 중 errorHandler가 남긴 에러 라인만 추출한다. */
function extractErrorLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(ERROR_PREFIX));
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
 */
function readNewText(filePath, cursor = {}, fsImpl = fs) {
  if (!fsImpl.existsSync(filePath)) {
    return { text: "", cursor: { inode: null, offset: 0 } };
  }
  const stat = fsImpl.statSync(filePath);
  const rotated =
    (cursor.inode != null && cursor.inode !== stat.ino) ||
    (cursor.offset ?? 0) > stat.size;
  const startOffset = rotated ? 0 : (cursor.offset ?? 0);

  const length = stat.size - startOffset;
  if (length <= 0) {
    return { text: "", cursor: { inode: stat.ino, offset: stat.size } };
  }

  const fd = fsImpl.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fsImpl.readSync(fd, buffer, 0, length, startOffset);
    return {
      text: buffer.toString("utf8"),
      cursor: { inode: stat.ino, offset: stat.size },
    };
  } finally {
    fsImpl.closeSync(fd);
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
  const { text, cursor } = readNewText(logPath, state.cursor);
  const errorLines = extractErrorLines(text);
  const { alerts, fingerprints } = decideAlerts(errorLines, state.fingerprints);

  writeState(STATE_NAME, { cursor, fingerprints });

  if (alerts.length === 0) {
    await pingSuccess(PING_ENV_VAR);
    console.log(
      `[error-monitor] 새 에러 없음 (신규 라인 ${errorLines.length}줄 검사)`,
    );
    return;
  }

  const detail = alerts
    .map((a) => `[${a.isNew ? "신규" : "재발"} x${a.count}] ${a.message}`)
    .join("\n");
  await pingFail(PING_ENV_VAR, detail);
  console.error(
    `[error-monitor] 알림 대상 에러 ${alerts.length}건:\n${detail}`,
  );
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
};
