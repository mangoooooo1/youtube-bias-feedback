#!/usr/bin/env node
/**
 * 연구 데이터 수집 파이프라인 침묵 장애 감시
 *
 * 이 스크립트는 전체 참여자의 시청 활동이 과거 대비 갑자기 끊겼는지를 감시한다.
 *
 * 참여자 수 변경을 대비하여 절대 참여자 수 임계값을 쓰지 않는다.
 * 대신 "정확히 7일 전 같은 시간대"와 비교해, 그때는 활동이 있었는데 지금 6시간 동안
 * 전혀 없으면 전체 중단으로 판단한다. 연구 시작 후 7일이 안 지나 비교 데이터가 없으면
 * 직전 6시간 윈도우와 비교하되 연속 2회(12시간) 침묵이어야 알린다(새벽 자연 저활동 구간의
 * 오탐 방지). 개별 참여자 한둘이 조용한 것은 정상적인 비활성일 수 있어 대상이 아니다 —
 * 전체가 동시에 조용해질 때만 이상으로 본다.
 *
 * 사용:
 *   node server/monitoring/research-pipeline-monitor.js
 */
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { readState, writeState } = require("./state");
const {
  pingSuccess,
  pingFail,
  shouldPersistState,
} = require("./healthchecks-ping");

const PING_ENV_VAR = "RESEARCH_PIPELINE_PING_URL";
const STATE_NAME = "research-pipeline";

const WINDOW_MS = 6 * 60 * 60 * 1000;
const COMPARE_OFFSET_MS = 7 * 24 * 60 * 60 * 1000;
const REQUIRED_CONSECUTIVE = 2;
const MIN_ADJACENT_WINDOW_MS = WINDOW_MS / 2;

/**
 * 순수 판정 함수(DB 접근 없이 테스트 가능)
 * events: 최근 (windowMs + compareOffsetMs) 범위 활동 타임스탬프 배열
 * hasParticipants: 등록된 참여자가 한 명이라도 있는지(연구 시작 전이면 항상 정상 취급)
 * hasWeekOldParticipant: 설치 후 compareOffsetMs(기본 7일) 이상 지난 참여자가 있는지
 * lastEvaluatedAt: 직전 실행 시각(epoch ms). 처음 실행이면 null.
 */
function evaluatePipelineHealth({
  now,
  events,
  hasParticipants,
  hasWeekOldParticipant,
  consecutiveZero = 0,
  lastEvaluatedAt = null,
  windowMs = WINDOW_MS,
  compareOffsetMs = COMPARE_OFFSET_MS,
  requiredConsecutive = REQUIRED_CONSECUTIVE,
  minAdjacentWindowMs = MIN_ADJACENT_WINDOW_MS,
}) {
  if (!hasParticipants) {
    return {
      status: "skipped",
      reason: "no_participants",
      consecutiveZero: 0,
      lastEvaluatedAt: now,
    };
  }

  const currentStart = now - windowMs;
  const currentCount = events.filter(
    (ts) => ts >= currentStart && ts < now,
  ).length;

  if (currentCount > 0) {
    return {
      status: "ok",
      currentCount,
      consecutiveZero: 0,
      lastEvaluatedAt: now,
    };
  }

  if (hasWeekOldParticipant) {
    const compareStart = currentStart - compareOffsetMs;
    const compareEnd = now - compareOffsetMs;
    const compareCount = events.filter(
      (ts) => ts >= compareStart && ts < compareEnd,
    ).length;
    if (compareCount > 0) {
      return {
        status: "alert",
        reason: "flatline_vs_7_days_ago",
        currentCount: 0,
        compareCount,
        consecutiveZero: 0,
        lastEvaluatedAt: now,
      };
    }
    // 7일 전 같은 시간대도 원래 조용했다 — 그 시간대 자체의 정상적인 저활동으로 간주하고 리셋.
    return {
      status: "ok",
      currentCount: 0,
      consecutiveZero: 0,
      lastEvaluatedAt: now,
    };
  }

  // 연구 시작 초반이라 비교할 히스토리가 없다 — 직전 윈도우 연속 침묵 횟수로만 판단.
  const isAdjacentWindow =
    lastEvaluatedAt == null || now - lastEvaluatedAt >= minAdjacentWindowMs;
  const nextConsecutive = isAdjacentWindow
    ? consecutiveZero + 1
    : consecutiveZero;

  if (nextConsecutive >= requiredConsecutive) {
    return {
      status: "alert",
      reason: "flatline_consecutive_windows",
      currentCount: 0,
      consecutiveZero: nextConsecutive,
      lastEvaluatedAt: now,
    };
  }
  return {
    status: "warn_pending",
    currentCount: 0,
    consecutiveZero: nextConsecutive,
    lastEvaluatedAt: now,
  };
}

/**
 * DB에서 참여자 존재 여부·"설치 후 7일 이상 지난 참여자 존재 여부"·최근 활동
 * 타임스탬프(video_events ∪ sessions)를 모은다.
 */
function collectRecentActivity(
  db,
  now,
  lookbackMs,
  compareOffsetMs = COMPARE_OFFSET_MS,
) {
  const cutoffIso = new Date(now - lookbackMs).toISOString();

  const hasParticipants =
    db.prepare("SELECT COUNT(*) AS c FROM participants").get().c > 0;

  // installDate(등록 시 Date.parse로 검증된 문자열, participants-store.js)가
  // compareOffsetMs 이상 지난 참여자가 있어야 "N일 전 같은 시간대" 비교가 의미를 가진다.
  const earliestInstall = db
    .prepare("SELECT MIN(installDate) AS earliest FROM participants")
    .get().earliest;
  const earliestInstallMs = earliestInstall ? Date.parse(earliestInstall) : NaN;
  const hasWeekOldParticipant =
    Number.isFinite(earliestInstallMs) &&
    earliestInstallMs <= now - compareOffsetMs;

  // video_events.watchedAt은 클라이언트가 저장한 ISO8601 문자열인데, 서버가 형식을
  // UTC('Z')로 강제하지 않아 오프셋 표기(예: +09:00)가 섞여 들어올 수 있다. 단순 문자열
  // 비교는 오프셋이 다르면 실제 시간 순서와 어긋날 수 있어(예: "14:00+09:00"이 실제로는
  // "06:00Z"보다 이른데도 문자열로는 더 크게 비교됨) julianday()로 정규화해 비교한다.
  const videoRows = db
    .prepare(
      "SELECT watchedAt AS ts FROM video_events WHERE julianday(watchedAt) >= julianday(?)",
    )
    .all(cutoffIso);
  // sessions.createdAt은 SQLite datetime('now') 형식(UTC 값이지만 공백 구분, 'Z' 없음).
  // WHERE 절은 datetime()으로 정규화해 비교하지만, SELECT로 꺼낸 원본 문자열을 그대로
  // JS Date.parse에 넘기면 위험하다.
  // 이 저장소 개발 환경(Asia/Seoul)에서 직접 재현: "2026-08-30 12:00:00"이 로컬로 해석되면 실제로는
  // "2026-08-30T12:00:00Z"인데 "2026-08-30T03:00:00Z"로 9시간 밀려서 파싱된다. 서버가
  // UTC가 아닌 시간대로 설정되면 6시간 윈도우 판정이 통째로 틀어질 수 있으므로, SQL에서
  // 'T'+'Z'가 붙은 명확한 UTC ISO 문자열로 바꿔 반환한다.
  const sessionRows = db
    .prepare(
      `SELECT replace(createdAt, ' ', 'T') || 'Z' AS ts FROM sessions
       WHERE datetime(createdAt) >= datetime(?)`,
    )
    .all(cutoffIso);

  const events = [...videoRows, ...sessionRows]
    .map((r) => Date.parse(r.ts))
    .filter((ts) => Number.isFinite(ts));

  return { hasParticipants, hasWeekOldParticipant, events };
}

async function main() {
  const { db } = require("../db");
  const now = Date.now();
  const lookbackMs = WINDOW_MS + COMPARE_OFFSET_MS;

  const state = readState(STATE_NAME, {
    consecutiveZero: 0,
    lastEvaluatedAt: null,
  });
  const { hasParticipants, hasWeekOldParticipant, events } =
    collectRecentActivity(db, now, lookbackMs);

  const result = evaluatePipelineHealth({
    now,
    events,
    hasParticipants,
    hasWeekOldParticipant,
    consecutiveZero: state.consecutiveZero,
    lastEvaluatedAt: state.lastEvaluatedAt,
  });

  let pingResult;
  if (result.status === "alert") {
    pingResult = await pingFail(
      PING_ENV_VAR,
      `연구 데이터 수집 파이프라인 침묵 의심 (${result.reason}, 최근 6시간 이벤트 0건)`,
    );
    console.error("[research-pipeline] 침묵 의심:", result);
  } else {
    pingResult = await pingSuccess(PING_ENV_VAR);
    console.log("[research-pipeline] 정상:", result);
  }

  // ping이 실제로 실패했으면(네트워크 오류·HTTP 에러 등) 상태를 저장하지 않는다.
  if (!shouldPersistState(pingResult)) {
    console.error(
      "[research-pipeline] Healthchecks.io 전송 실패 — 상태 저장을 보류하고 다음 실행에서 재시도합니다.",
    );
    process.exitCode = 1;
    return;
  }

  writeState(STATE_NAME, {
    consecutiveZero: result.consecutiveZero,
    lastEvaluatedAt: result.lastEvaluatedAt,
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[research-pipeline] 스크립트 오류:", err.message);
    process.exitCode = 1;
  });
}

module.exports = { evaluatePipelineHealth, collectRecentActivity };
