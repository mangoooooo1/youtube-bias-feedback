#!/usr/bin/env node
/**
 * 영상 기록·세션 행 정합성 점검 리포트
 *
 * 영상 기록(video_events)과 세션 행(sessions)이 서로 맞는지 확인한다.
 * - 세션 ID 공유: 한 sessionId를 둘 이상의 참여자가 쓴다
 * - 세션 행 누락: 영상 기록은 있는데 세션 행이 없다. 그 뒤 활동이 있으면 누락 의심, 없으면 전송 대기 의심
 * - 분포 미확정: 분포가 비어 있는 세션
 * - 같은 영상 10초 중복: 같은 참여자·같은 영상이 10초 안에 다시 기록됐다
 * - 세션 시청 수 불일치: 세션 영상 수 ≠ 기록 수 − 같은 세션 안에서 앞 기록에 이어진 기록 수
 *
 * 늦게 도착하는 세션·기록을 기다리도록 기준 시각이 하루 지난 것만 센다.
 * 매일 실행하면 각 이상은 "지금 − 2일 ~ 지금 − 1일" 창에서 한 번만 신규로 잡힌다.
 * TEST 그룹은 제외한다. 출력에는 anonymousId 원본 대신 지문만 남긴다.
 *
 * 읽기 전용 — DB를 수정하지 않는다.
 *
 * 사용:
 *   node server/scripts/data-integrity-report.js
 */
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { fingerprint } = require("./fingerprint");
const { TEST_CODES } = require("../routes/participant-recovery");

const DAY_MS = 86400000;
// 이만큼 지난 것만 판정한다. 세션은 마지막 기록 10분 뒤 닫히고, 전송에 실패하면 1분마다 다시 보낸다
const SETTLE_MS = DAY_MS;
// crontab 실행 주기(매일 1회). 신규 판정 창의 폭이다
const RUN_INTERVAL_MS = DAY_MS;
// extension/storage.js의 NEAR_SIMULTANEOUS_MS와 같은 값
const NEAR_DUPLICATE_MS = 10000;

// 저장 형식이 섞여 있어도(오프셋 포함 ISO, datetime('now')) 같은 기준의 ms로 바꾼다. 읽을 수 없으면 NULL
const toMs = (column) => `(julianday(${column}) - 2440587.5) * 86400000.0`;

const sessionKey = (anonymousId, sessionId) => `${anonymousId}\n${sessionId}`;

/**
 * TEST 그룹을 뺀 영상 기록과 세션 행을 읽는다. 시각은 ms로 바꿔 둔다.
 * @returns {{events: object[], sessions: object[]}}
 */
function collectRecords(db) {
  const placeholders = [...TEST_CODES].map(() => "?").join(",");
  const events = db
    .prepare(
      `SELECT e.anonymousId, e.eventId, e.sessionId, e.videoId, e.resumedFromEventId,
              ${toMs("e.watchedAt")} AS watchedMs
         FROM video_events e
         JOIN participants p ON p.anonymousId = e.anonymousId
        WHERE p.group_code NOT IN (${placeholders})`,
    )
    .all(...TEST_CODES)
    .filter((e) => Number.isFinite(e.watchedMs));
  const sessions = db
    .prepare(
      `SELECT s.anonymousId, s.sessionId, s.videoCount,
              s.categoryDistribution IS NULL AS distributionMissing,
              ${toMs("s.endTime")} AS endMs, ${toMs("s.createdAt")} AS createdMs
         FROM sessions s
         JOIN participants p ON p.anonymousId = s.anonymousId
        WHERE p.group_code NOT IN (${placeholders})`,
    )
    .all(...TEST_CODES);
  return { events, sessions };
}

/** sessionId가 있는 영상 기록을 (참여자, 세션)별로 묶는다. */
function groupBySession(events) {
  const groups = new Map();
  for (const e of events) {
    if (e.sessionId == null) continue;
    const key = sessionKey(e.anonymousId, e.sessionId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return groups;
}

/** 한 sessionId를 둘 이상의 참여자가 쓴 경우. 기준 시각은 그 세션의 첫 기록이다. */
function findSharedSessionIds(events) {
  const bySessionId = new Map();
  for (const e of events) {
    if (e.sessionId == null) continue;
    const entry = bySessionId.get(e.sessionId) ?? {
      owners: new Set(),
      refMs: Infinity,
    };
    entry.owners.add(e.anonymousId);
    entry.refMs = Math.min(entry.refMs, e.watchedMs);
    bySessionId.set(e.sessionId, entry);
  }
  return [...bySessionId]
    .filter(([, entry]) => entry.owners.size > 1)
    .map(([sessionId, { owners, refMs }]) => ({
      sessionId,
      ownerCount: owners.size,
      refMs,
    }));
}

/**
 * 영상 기록은 있는데 같은 참여자의 세션 행이 없는 세션. 기준 시각은 그 세션의 마지막 기록이다.
 * 그 뒤 같은 참여자의 기록·세션이 있으면 확장이 돌았는데도 빠진 것이라 laterActivity로 표시한다.
 */
function findMissingSessions(events, sessions) {
  const recorded = new Set(
    sessions.map((s) => sessionKey(s.anonymousId, s.sessionId)),
  );
  const latestActivity = new Map();
  const touch = (anonymousId, ms) => {
    if (!Number.isFinite(ms)) return;
    latestActivity.set(
      anonymousId,
      Math.max(latestActivity.get(anonymousId) ?? -Infinity, ms),
    );
  };
  for (const e of events) touch(e.anonymousId, e.watchedMs);
  for (const s of sessions) touch(s.anonymousId, s.createdMs);

  const missing = [];
  for (const [key, group] of groupBySession(events)) {
    if (recorded.has(key)) continue;
    const { anonymousId, sessionId } = group[0];
    const refMs = Math.max(...group.map((e) => e.watchedMs));
    missing.push({
      anonymousId,
      sessionId,
      videoCount: group.length,
      refMs,
      laterActivity: latestActivity.get(anonymousId) > refMs,
    });
  }
  return missing;
}

/** 분포가 비어 있는 세션. 기준 시각은 세션 종료 시각이다. */
function findUndeterminedSessions(sessions) {
  return sessions
    .filter((s) => s.distributionMissing)
    .map((s) => ({
      anonymousId: s.anonymousId,
      sessionId: s.sessionId,
      refMs: s.endMs,
    }));
}

/** 같은 참여자·같은 영상의 바로 앞 기록과 10초 안인 기록. 기준 시각은 뒤 기록이다. */
function findNearDuplicates(events) {
  const byVideo = new Map();
  for (const e of events) {
    const key = `${e.anonymousId}\n${e.videoId}`;
    if (!byVideo.has(key)) byVideo.set(key, []);
    byVideo.get(key).push(e);
  }
  const duplicates = [];
  for (const list of byVideo.values()) {
    list.sort((a, b) => a.watchedMs - b.watchedMs);
    for (let i = 1; i < list.length; i++) {
      const gapMs = list[i].watchedMs - list[i - 1].watchedMs;
      if (gapMs > NEAR_DUPLICATE_MS) continue;
      duplicates.push({
        anonymousId: list[i].anonymousId,
        sessionId: list[i].sessionId,
        gapMs,
        refMs: list[i].watchedMs,
      });
    }
  }
  return duplicates;
}

/**
 * 세션 영상 수가 (기록 수 − 같은 세션 안에서 앞 기록에 이어진 기록 수)와 다른 세션. 기준 시각은 세션 종료 시각이다.
 * 확장은 같은 세션 안에서 이어 본 기록을 하나로 세서 보낸다.
 */
function findSessionCountMismatches(events, sessions) {
  const groups = groupBySession(events);
  const mismatches = [];
  for (const s of sessions) {
    if (s.videoCount == null) continue;
    const group = groups.get(sessionKey(s.anonymousId, s.sessionId)) ?? [];
    const ids = new Set(group.map((e) => e.eventId).filter(Boolean));
    const continued = group.filter(
      (e) => e.resumedFromEventId && ids.has(e.resumedFromEventId),
    ).length;
    const watches = group.length - continued;
    if (watches === s.videoCount) continue;
    mismatches.push({
      anonymousId: s.anonymousId,
      sessionId: s.sessionId,
      videoCount: s.videoCount,
      watches,
      refMs: s.endMs,
    });
  }
  return mismatches;
}

/**
 * 기준 시각이 SETTLE_MS 넘게 지난 것만 세고, 그중 직전 실행 이후 창에 든 것을 신규로 센다.
 * @returns {{total: number, newCount: number, newRows: object[]}}
 */
function classify(rows, now) {
  const settledBefore = now - SETTLE_MS;
  const settled = rows.filter((r) => r.refMs < settledBefore);
  const newRows = settled.filter(
    (r) => r.refMs >= settledBefore - RUN_INTERVAL_MS,
  );
  return { total: settled.length, newCount: newRows.length, newRows };
}

const CHECK_LABELS = {
  sharedSessionIds: "세션 ID 공유",
  missingSuspected: "세션 행 누락 의심(이후 활동 있음)",
  missingPending: "세션 행 전송 대기 의심(이후 활동 없음)",
  undeterminedDistribution: "분포 미확정 세션",
  nearDuplicates: "같은 영상 10초 중복",
  sessionCountMismatches: "세션 시청 수 불일치",
};

/** 신규 항목 한 줄. 참여자는 지문으로만 적는다. */
function describeRow(name, row) {
  const at = new Date(row.refMs).toISOString();
  if (name === "sharedSessionIds") {
    return `sessionId=${row.sessionId} 참여자 ${row.ownerCount}명 기준시각=${at}`;
  }
  const who = `anonymousId(지문)=${fingerprint(row.anonymousId)} sessionId=${row.sessionId ?? "(none)"}`;
  if (name === "nearDuplicates") {
    return `${who} 간격=${(row.gapMs / 1000).toFixed(1)}초 기준시각=${at}`;
  }
  if (name === "sessionCountMismatches") {
    return `${who} 세션 영상 수=${row.videoCount} 기록 기준 시청 수=${row.watches} 기준시각=${at}`;
  }
  if (name.startsWith("missing")) {
    return `${who} 영상 ${row.videoCount}건 기준시각=${at}`;
  }
  return `${who} 기준시각=${at}`;
}

function printReport(result) {
  for (const [name, label] of Object.entries(CHECK_LABELS)) {
    const { total, newCount, newRows } = result[name];
    console.log(
      `[data-integrity] ${label}: 전체 ${total}건, 신규 ${newCount}건`,
    );
    for (const row of newRows) console.log(`  ${describeRow(name, row)}`);
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{now?: number}} [options]
 * @returns {Record<keyof CHECK_LABELS, {total: number, newCount: number, newRows: object[]}>}
 */
function run(db, { now = Date.now() } = {}) {
  const { events, sessions } = collectRecords(db);
  const missing = findMissingSessions(events, sessions);
  const checks = {
    sharedSessionIds: findSharedSessionIds(events),
    missingSuspected: missing.filter((m) => m.laterActivity),
    missingPending: missing.filter((m) => !m.laterActivity),
    undeterminedDistribution: findUndeterminedSessions(sessions),
    nearDuplicates: findNearDuplicates(events),
    sessionCountMismatches: findSessionCountMismatches(events, sessions),
  };
  const result = Object.fromEntries(
    Object.entries(checks).map(([name, rows]) => [name, classify(rows, now)]),
  );
  printReport(result);
  return result;
}

function main() {
  const { db } = require("../db");
  try {
    run(db);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("[data-integrity] 스크립트 오류:", err.message);
    process.exitCode = 1;
  }
}

module.exports = {
  run,
  collectRecords,
  findSharedSessionIds,
  findMissingSessions,
  findUndeterminedSessions,
  findNearDuplicates,
  findSessionCountMismatches,
  classify,
  CHECK_LABELS,
  SETTLE_MS,
  RUN_INTERVAL_MS,
  NEAR_DUPLICATE_MS,
};
