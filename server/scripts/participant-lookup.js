#!/usr/bin/env node
/**
 * 참여자 상태 조회 (읽기 전용)
 *
 * 결측·오류 알림을 받은 뒤 지문(monitoring.log)·anonymousId·참여 코드 중 하나로 참여자를 찾아
 * 등록 정보, 최근 활동, 리뷰 생성 상태를 한 번에 본다. 참여 코드로 찾으면 Datadog 검색에 쓸
 * anonymousId도 함께 나온다.
 *
 * 출력에는 원본 식별자가 들어 있다. 서버 터미널에서만 보고, 파일로 저장하거나 밖으로 보내지 않는다.
 *
 * 사용:
 *   node server/scripts/participant-lookup.js <지문 10자 | anonymousId | 참여 코드>
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { fingerprint } = require("./fingerprint");
const { TEST_CODES } = require("../routes/participant-recovery");
const { isStudyEnded } = require("../routes/period-reviews-query");
const { kstDateStr, dayFromInstall } = require("../pipeline/period-boundaries");
const { TOTAL_DAYS } = require("../pipeline/study-constants");

const DAY_MS = 86400000;
const RECENT_DAYS = 7;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{10}$/i;
const DEFAULT_DB_PATH = path.join(__dirname, "..", "youtube_bias.db");

/**
 * 입력이 무엇인지 판별한다. 참여 코드는 등록 때처럼 trim·대문자로 정규화한다.
 * @returns {{type: "anonymousId"|"fingerprint"|"participantCode", value: string}}
 */
function classifyInput(raw) {
  const value = String(raw ?? "").trim();
  if (UUID_PATTERN.test(value)) return { type: "anonymousId", value };
  if (FINGERPRINT_PATTERN.test(value))
    return { type: "fingerprint", value: value.toLowerCase() };
  return { type: "participantCode", value: value.toUpperCase() };
}

function findParticipants(db, { type, value }) {
  const select =
    "SELECT anonymousId, participantCode, group_code AS groupCode, installDate, " +
    "studyEndModalShownAt, studyEndReviewViewedAt, studyEndCodeVerifiedAt FROM participants";
  if (type === "anonymousId") {
    return db
      .prepare(`${select} WHERE lower(anonymousId) = lower(?)`)
      .all(value);
  }
  if (type === "participantCode") {
    return db.prepare(`${select} WHERE participantCode = ?`).all(value);
  }
  // 지문은 일방향 해시라 전체를 계산해 대조한다(참여자 수가 적어 비용은 무시할 수준)
  return db
    .prepare(select)
    .all()
    .filter(
      (p) =>
        fingerprint(p.anonymousId) === value ||
        fingerprint(p.participantCode) === value,
    );
}

function hasTable(db, name) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

/** 시각 형식이 섞여 있어(bug-30/31) strftime으로 정규화한 뒤 ISO로 돌려준다. */
function latestIso(db, sql, anonymousId) {
  const ts = db.prepare(sql).get(anonymousId)?.ts;
  return ts != null ? new Date(Number(ts) * 1000).toISOString() : null;
}

/** 최근 RECENT_DAYS일(KST) 날짜별 개수. 활동 없는 날도 0으로 채운다. */
function countByKstDate(db, table, column, anonymousId, now) {
  const rows = db
    .prepare(
      `SELECT date(strftime('%s', ${column}), 'unixepoch', '+9 hours') AS d, COUNT(*) AS c
         FROM ${table} WHERE anonymousId = ? GROUP BY d`,
    )
    .all(anonymousId);
  const byDate = new Map(rows.map((r) => [r.d, r.c]));
  const days = [];
  for (let i = RECENT_DAYS - 1; i >= 0; i--) {
    const d = kstDateStr(new Date(now.getTime() - i * DAY_MS));
    days.push({ date: d, count: byDate.get(d) ?? 0 });
  }
  return days;
}

function collectDetail(db, p, now) {
  const id = p.anonymousId;
  const installKst = dayFromInstall(p.installDate, 0);
  const studyDay =
    Math.round(
      (Date.parse(kstDateStr(now)) - Date.parse(installKst)) / DAY_MS,
    ) + 1;

  const videoByDate = countByKstDate(db, "video_events", "watchedAt", id, now);
  const sessionByDate = countByKstDate(db, "sessions", "createdAt", id, now);

  const versionCounts = hasTable(db, "period_review_versions")
    ? new Map(
        db
          .prepare(
            "SELECT periodIndex, COUNT(*) AS c FROM period_review_versions WHERE anonymousId = ? GROUP BY periodIndex",
          )
          .all(id)
          .map((r) => [r.periodIndex, r.c]),
      )
    : null;

  return {
    ...p,
    isTest: TEST_CODES.has(p.groupCode),
    studyDay,
    totalDays: TOTAL_DAYS,
    studyEnded: isStudyEnded(p.installDate, now),
    lastVideoAt: latestIso(
      db,
      "SELECT MAX(strftime('%s', watchedAt)) AS ts FROM video_events WHERE anonymousId = ?",
      id,
    ),
    lastSessionAt: latestIso(
      db,
      "SELECT MAX(strftime('%s', createdAt)) AS ts FROM sessions WHERE anonymousId = ?",
      id,
    ),
    recentDays: videoByDate.map((v, i) => ({
      date: v.date,
      videos: v.count,
      sessions: sessionByDate[i].count,
    })),
    latestTodayReview:
      db
        .prepare(
          "SELECT reviewDate, llmStatus, source, generatedAt FROM today_reviews WHERE anonymousId = ? ORDER BY reviewDate DESC LIMIT 1",
        )
        .get(id) ?? null,
    periodReviews: db
      .prepare(
        "SELECT periodIndex, periodStart, periodEnd, llmStatus, generatedAt FROM period_reviews WHERE anonymousId = ? ORDER BY periodIndex",
      )
      .all(id)
      .map((r) => ({
        ...r,
        versions: versionCounts
          ? (versionCounts.get(r.periodIndex) ?? 0)
          : null,
      })),
    popup: db
      .prepare(
        "SELECT COUNT(*) AS opens, MAX(openedAt) AS lastOpenedAt FROM popup_events WHERE anonymousId = ?",
      )
      .get(id),
  };
}

/**
 * @param {import("better-sqlite3").Database} db - 읽기 전용 연결
 * @param {string} raw - 지문·anonymousId·참여 코드
 */
function lookup(db, raw, { now = new Date() } = {}) {
  const input = classifyInput(raw);
  const participants = findParticipants(db, input);
  return {
    input,
    matches: participants.map((p) => collectDetail(db, p, now)),
  };
}

function formatDetail(d) {
  const lines = [
    `anonymousId   : ${d.anonymousId}`,
    `참여 코드     : ${d.participantCode ?? "(없음)"}`,
    `그룹          : ${d.groupCode}${d.isTest ? " (TEST — 분석·감시 대상 아님)" : ""}`,
    `installDate   : ${d.installDate}`,
    `연구 일차     : ${d.studyDay}일차 / ${d.totalDays}일${d.studyEnded ? " (연구 종료)" : ""}`,
    `마지막 영상   : ${d.lastVideoAt ?? "(기록 없음)"}`,
    `마지막 세션   : ${d.lastSessionAt ?? "(기록 없음)"}`,
    `최근 ${d.recentDays.length}일(KST) 영상/세션:`,
    ...d.recentDays.map((r) => `  ${r.date}  ${r.videos} / ${r.sessions}`),
    `오늘 리뷰(최근): ${
      d.latestTodayReview
        ? `${d.latestTodayReview.reviewDate} ${d.latestTodayReview.llmStatus} (${d.latestTodayReview.source}) ${d.latestTodayReview.generatedAt}`
        : "(없음)"
    }`,
    "기간 리뷰:",
    ...(d.periodReviews.length > 0
      ? d.periodReviews.map(
          (r) =>
            `  ${r.periodIndex}구간 ${r.periodStart}~${r.periodEnd} ${r.llmStatus} ${r.generatedAt}` +
            (r.versions != null ? ` (생성 ${r.versions}회)` : ""),
        )
      : ["  (없음)"]),
    `팝업          : ${d.popup.opens}회 열람, 마지막 ${d.popup.lastOpenedAt ?? "(없음)"}`,
    "",
    "같은 참여자의 서버 로그:",
    `  grep -h 'anonymousId="${d.anonymousId}"' ~/.pm2/logs/youtube-bias-server-*.log | tail -50`,
  ];
  return lines.join("\n");
}

function printResult({ input, matches }) {
  if (matches.length === 0) {
    console.log(`[participant-lookup] ${input.type}로 찾은 참여자가 없습니다.`);
    return;
  }
  if (matches.length > 1) {
    console.log(
      `[participant-lookup] ${matches.length}명이 매칭됐습니다${input.type === "fingerprint" ? "(지문 충돌 가능)" : ""}.`,
    );
  }
  matches.forEach((d, i) => {
    if (i > 0) console.log("\n" + "-".repeat(40));
    console.log(formatDetail(d));
  });
}

function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error(
      "사용: node server/scripts/participant-lookup.js <지문 10자 | anonymousId | 참여 코드>",
    );
    process.exitCode = 1;
    return;
  }
  const key = process.env.DB_ENCRYPTION_KEY;
  if (!key) {
    console.error(
      "[participant-lookup] DB_ENCRYPTION_KEY 환경변수가 필요합니다.",
    );
    process.exitCode = 1;
    return;
  }
  const dbPath = process.env.SOURCE_DB_PATH || DEFAULT_DB_PATH;
  if (!fs.existsSync(dbPath)) {
    console.error(`[participant-lookup] DB 파일이 없습니다: ${dbPath}`);
    process.exitCode = 1;
    return;
  }

  // server/db.js는 쓰기 연결이라 쓰지 않고 읽기 전용으로 따로 연다
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("cipher = 'sqlcipher'");
    db.key(Buffer.from(key));
    printResult(lookup(db, raw));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("[participant-lookup] 스크립트 오류:", err.message);
    process.exitCode = 1;
  }
}

module.exports = { classifyInput, findParticipants, lookup, formatDetail };
