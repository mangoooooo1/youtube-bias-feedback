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

/**
 * 순수 판정 함수(DB 접근 없이 테스트 가능)
 * events: 최근 (windowMs + compareOffsetMs) 범위 활동 타임스탬프 배열
 * hasParticipants: 등록된 참여자가 한 명이라도 있는지(연구 시작 전이면 항상 정상 취급)
 * hasWeekOldParticipant: 설치 후 compareOffsetMs(기본 7일) 이상 지난 참여자가 있는지
 */
function evaluatePipelineHealth({
  now,
  events,
  hasParticipants,
  hasWeekOldParticipant,
  consecutiveZero = 0,
  windowMs = WINDOW_MS,
  compareOffsetMs = COMPARE_OFFSET_MS,
  requiredConsecutive = REQUIRED_CONSECUTIVE,
}) {
  if (!hasParticipants) {
    return {
      status: "skipped",
      reason: "no_participants",
      consecutiveZero: 0,
    };
  }

  const currentStart = now - windowMs;
  const currentCount = events.filter(
    (ts) => ts >= currentStart && ts < now,
  ).length;

  if (currentCount > 0) {
    return { status: "ok", currentCount, consecutiveZero: 0 };
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
      };
    }
    // 7일 전 같은 시간대도 원래 조용했다 — 그 시간대 자체의 정상적인 저활동으로 간주하고 리셋.
    return { status: "ok", currentCount: 0, consecutiveZero: 0 };
  }

  // 연구 시작 초반이라 비교할 히스토리가 없다 — 직전 윈도우 연속 침묵 횟수로만 판단.
  const nextConsecutive = consecutiveZero + 1;
  if (nextConsecutive >= requiredConsecutive) {
    return {
      status: "alert",
      reason: "flatline_consecutive_windows",
      currentCount: 0,
      consecutiveZero: nextConsecutive,
    };
  }
  return {
    status: "warn_pending",
    currentCount: 0,
    consecutiveZero: nextConsecutive,
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

  // video_events.watchedAt은 클라이언트가 저장한 ISO8601 문자열이라 문자열 비교로 충분하다.
  const videoRows = db
    .prepare("SELECT watchedAt AS ts FROM video_events WHERE watchedAt >= ?")
    .all(cutoffIso);
  // sessions.createdAt은 SQLite datetime('now') 형식(UTC, 'T' 없음)이라 ISO cutoff와
  // 직접 문자열 비교가 안 맞을 수 있어 datetime()으로 양쪽을 정규화해 비교한다.
  const sessionRows = db
    .prepare(
      "SELECT createdAt AS ts FROM sessions WHERE datetime(createdAt) >= datetime(?)",
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

  const state = readState(STATE_NAME, { consecutiveZero: 0 });
  const { hasParticipants, hasWeekOldParticipant, events } =
    collectRecentActivity(db, now, lookbackMs);

  const result = evaluatePipelineHealth({
    now,
    events,
    hasParticipants,
    hasWeekOldParticipant,
    consecutiveZero: state.consecutiveZero,
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

  writeState(STATE_NAME, { consecutiveZero: result.consecutiveZero });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[research-pipeline] 스크립트 오류:", err.message);
    process.exitCode = 1;
  });
}

module.exports = { evaluatePipelineHealth, collectRecentActivity };
