#!/usr/bin/env node
/**
 * 피드백 노출 감사 리포트
 *
 * 피드백(리뷰)이 받아야 할 사람에게, 받아야 할 때만 보였는지 운영 기록으로 확인한다.
 * 화면에서 막는 장치(팝업·서버의 자격 판정)가 실제로 막았는지 보는 사후 점검이다.
 * - 대조군 세션 피드백: 대조군 세션에 알림·열람·확인 시각이 있다(대조군은 세션 피드백 대상이 아니다)
 * - 실험군 기준선 중 세션 피드백: 알림·열람·확인 시각이 기준선 기간 안이다
 * - 자격 밖 팝업 열람: 오늘·기간·지난 날 리뷰를 본 팝업을, 연 시각에 자격이 없었다
 *   (실험군은 기준선 안, 대조군은 연구 종료 코드 검증 전)
 * - 대조군 세션 리뷰 생성: 대조군 세션에 리뷰 문장이 있다
 * - 판정 불가: 리뷰를 본 팝업인데 연 시각이 없다(구버전 확장)
 *
 * 자격 판정은 서버가 리뷰를 내줄 때 쓰는 isTodayReviewEligible과 같은 규칙이다.
 * 기준선 날짜의 리뷰를 기준선이 끝난 뒤 보는 것은 의도된 동작이라, 날짜가 아니라 연 시각으로 판정한다.
 * 대조군의 오늘·기간 리뷰 행은 종료 뒤 공개하려고 미리 만드는 것이라 보지 않는다.
 *
 * 위반 여부는 일어난 시각으로 판정하고, 신규는 서버에 도착한 시각으로 센다.
 * 팝업 기록은 팝업을 다시 열어야 전송돼 며칠 늦게 올 수 있어서다.
 * TEST 그룹은 제외한다. 출력에는 anonymousId 원본 대신 지문만 남긴다.
 *
 * 알림 역할(data-integrity-report.js와 같다):
 * - Healthchecks.io: 감사가 돌았는지만 본다. 위반이 있어도 success(건수 본문), 실행이 실패하면 /fail.
 * - Datadog: 항목별 전체·신규 건수를 gauge(check 태그)로 보내고, Monitor가 알린다.
 * 외부로는 건수만 보내고, 누구인지는 서버 monitoring.log에만 남긴다.
 *
 * 읽기 전용 — DB를 수정하지 않는다.
 *
 * 사용:
 *   node server/scripts/feedback-exposure-report.js
 */
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { fingerprint } = require("./fingerprint");
const { TEST_CODES } = require("../routes/participant-recovery");
const {
  isTodayReviewEligible,
  FEEDBACK_GROUPS,
  CONTROL_GROUPS,
} = require("../routes/today-reviews-query");
const { pingSuccess, pingFail } = require("../monitoring/healthchecks-ping");
const { createDogStatsd } = require("../monitoring/dogstatsd");

const PING_ENV_VAR = "FEEDBACK_EXPOSURE_PING_URL";

// crontab 실행 주기(매일 1회). 신규 판정 창의 폭이다
const RUN_INTERVAL_MS = 86400000;

// 저장 형식이 섞여 있어도(오프셋 포함 ISO, datetime('now')) 같은 기준의 ms로 바꾼다. 읽을 수 없으면 NULL.
// julianday의 소수 오차로 경계 시각(예: 코드 검증과 같은 시각의 열람) 판정이 뒤집히지 않게 정수 ms로 반올림한다
const toMs = (column) =>
  `ROUND((julianday(${column}) - 2440587.5) * 86400000.0)`;

// 세션 피드백 시각 칸과 그 칸이 서버에 도착한 시각. 알림 시각은 세션 저장 때 함께 오고, 열람·확인은 서버가 받은 시각이다
const SESSION_FEEDBACK_COLUMNS = [
  { item: "feedbackNotifiedAt", at: "notifiedMs", arrival: "createdMs" },
  { item: "feedbackViewedAt", at: "viewedMs", arrival: "viewedMs" },
  { item: "feedbackConfirmedAt", at: "confirmedMs", arrival: "confirmedMs" },
];

const POPUP_VIEW_FLAGS = [
  { item: "todayFeedbackViewed", viewed: (p) => p.todayFeedbackViewed === 1 },
  { item: "periodFeedbackViewed", viewed: (p) => p.periodFeedbackViewed === 1 },
  { item: "pastDayReviewViews", viewed: (p) => p.pastDayReviewViews > 0 },
];

/**
 * TEST 그룹을 뺀 참여자와, 피드백 흔적이 있는 세션·팝업 기록을 읽는다. 시각은 ms로 바꿔 둔다.
 * @returns {{participants: Map<string, object>, sessions: object[], popups: object[]}}
 */
function collectRecords(db) {
  const placeholders = [...TEST_CODES].map(() => "?").join(",");
  const participants = new Map(
    db
      .prepare(
        `SELECT anonymousId, group_code, installDate,
                ${toMs("studyEndCodeVerifiedAt")} AS verifiedMs
           FROM participants WHERE group_code NOT IN (${placeholders})`,
      )
      .all(...TEST_CODES)
      .map((p) => [p.anonymousId, p]),
  );
  const sessions = db
    .prepare(
      `SELECT anonymousId, sessionId, ${toMs("createdAt")} AS createdMs,
              ${toMs("feedbackNotifiedAt")} AS notifiedMs,
              ${toMs("feedbackViewedAt")} AS viewedMs,
              ${toMs("feedbackConfirmedAt")} AS confirmedMs,
              review IS NOT NULL AS hasReview
         FROM sessions
        WHERE feedbackNotifiedAt IS NOT NULL OR feedbackViewedAt IS NOT NULL
           OR feedbackConfirmedAt IS NOT NULL OR review IS NOT NULL`,
    )
    .all()
    .filter((s) => participants.has(s.anonymousId));
  const popups = db
    .prepare(
      `SELECT anonymousId, eventId, ${toMs("openedAt")} AS openedMs,
              ${toMs("createdAt")} AS createdMs,
              todayFeedbackViewed, periodFeedbackViewed, pastDayReviewViews
         FROM popup_events
        WHERE todayFeedbackViewed = 1 OR periodFeedbackViewed = 1 OR pastDayReviewViews > 0`,
    )
    .all()
    .filter((p) => participants.has(p.anonymousId));
  return { participants, sessions, popups };
}

/** 그 시각에 이 참여자가 리뷰를 볼 자격이 있었는지. 대조군은 연구 종료 코드 검증 뒤부터다 */
function isEligibleAt(participant, atMs) {
  if (FEEDBACK_GROUPS.has(participant.group_code)) {
    return isTodayReviewEligible(participant, new Date(atMs));
  }
  if (CONTROL_GROUPS.has(participant.group_code)) {
    return (
      Number.isFinite(participant.verifiedMs) && atMs >= participant.verifiedMs
    );
  }
  return false;
}

/** 세션 하나의 피드백 시각 칸들. 시각을 읽을 수 없는 칸은 뺀다 */
function feedbackMarks(session) {
  return SESSION_FEEDBACK_COLUMNS.filter(({ at }) =>
    Number.isFinite(session[at]),
  ).map(({ item, at, arrival }) => ({
    anonymousId: session.anonymousId,
    sessionId: session.sessionId,
    item,
    atMs: session[at],
    arrivalMs: session[arrival],
  }));
}

/** 대조군 세션에 남은 피드백 알림·열람·확인. 시각과 상관없이 모두 위반이다 */
function findControlSessionFeedback(sessions, participants) {
  return sessions
    .filter((s) =>
      CONTROL_GROUPS.has(participants.get(s.anonymousId).group_code),
    )
    .flatMap(feedbackMarks);
}

/** 실험군 세션의 피드백 알림·열람·확인 중 기준선 기간 안의 것 */
function findBaselineSessionFeedback(sessions, participants) {
  return sessions
    .filter((s) =>
      FEEDBACK_GROUPS.has(participants.get(s.anonymousId).group_code),
    )
    .flatMap(feedbackMarks)
    .filter((m) => !isEligibleAt(participants.get(m.anonymousId), m.atMs));
}

/** 대조군 세션에 만들어진 리뷰 문장. 기준·도착 시각은 세션 저장 시각이다 */
function findControlSessionReviews(sessions, participants) {
  return sessions
    .filter(
      (s) =>
        s.hasReview &&
        CONTROL_GROUPS.has(participants.get(s.anonymousId).group_code),
    )
    .map((s) => ({
      anonymousId: s.anonymousId,
      sessionId: s.sessionId,
      item: "review",
      atMs: s.createdMs,
      arrivalMs: s.createdMs,
    }));
}

/**
 * 리뷰를 본 팝업 기록을 연 시각의 자격으로 나눈다.
 * @returns {{ineligible: object[], unjudged: object[]}} 자격 밖 열람, 연 시각이 없어 판정할 수 없는 기록
 */
function classifyPopupViews(popups, participants) {
  const ineligible = [];
  const unjudged = [];
  for (const p of popups) {
    const row = {
      anonymousId: p.anonymousId,
      popupEventId: p.eventId,
      item: POPUP_VIEW_FLAGS.filter((f) => f.viewed(p))
        .map((f) => f.item)
        .join(","),
      atMs: p.openedMs,
      arrivalMs: p.createdMs,
    };
    if (!Number.isFinite(p.openedMs)) unjudged.push(row);
    else if (!isEligibleAt(participants.get(p.anonymousId), p.openedMs)) {
      ineligible.push(row);
    }
  }
  return { ineligible, unjudged };
}

/**
 * 모든 행을 전체로 세고, 직전 실행 이후에 서버에 도착한 행을 신규로 센다.
 * 도착 시각을 읽을 수 없는 행은 전체에만 든다. null >= 숫자는 거짓이라 따로 막지 않아도 된다.
 * @returns {{total: number, newCount: number, newRows: object[]}}
 */
function classify(rows, now) {
  const newRows = rows.filter(
    (r) =>
      Number.isFinite(r.arrivalMs) &&
      r.arrivalMs >= now - RUN_INTERVAL_MS &&
      r.arrivalMs < now,
  );
  return { total: rows.length, newCount: newRows.length, newRows };
}

const CHECK_LABELS = {
  controlSessionFeedback: "대조군 세션 피드백 알림·열람",
  baselineSessionFeedback: "실험군 기준선 중 세션 피드백",
  ineligiblePopupViews: "자격 밖 팝업 리뷰 열람",
  controlSessionReviews: "대조군 세션 리뷰 생성",
  unjudgedPopupViews: "연 시각 없는 리뷰 열람 팝업(판정 불가)",
};

/** 신규 항목 한 줄. 참여자는 지문으로만 적는다. */
function describeRow(row, participants) {
  const group = participants.get(row.anonymousId)?.group_code;
  const where = row.popupEventId
    ? `popupEventId=${row.popupEventId}`
    : `sessionId=${row.sessionId}`;
  const at = Number.isFinite(row.atMs)
    ? new Date(row.atMs).toISOString()
    : "(없음)";
  return `anonymousId(지문)=${fingerprint(row.anonymousId)} 그룹=${group} ${where} 항목=${row.item} 시각=${at}`;
}

function printReport(result, participants) {
  for (const [name, label] of Object.entries(CHECK_LABELS)) {
    const { total, newCount, newRows } = result[name];
    console.log(
      `[feedback-exposure] ${label}: 전체 ${total}건, 신규 ${newCount}건`,
    );
    for (const row of newRows) {
      console.log(`  ${describeRow(row, participants)}`);
    }
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{now?: number}} [options]
 * @returns {Record<keyof CHECK_LABELS, {total: number, newCount: number, newRows: object[]}>}
 */
function run(db, { now = Date.now() } = {}) {
  const { participants, sessions, popups } = collectRecords(db);
  const popupViews = classifyPopupViews(popups, participants);
  const checks = {
    controlSessionFeedback: findControlSessionFeedback(sessions, participants),
    baselineSessionFeedback: findBaselineSessionFeedback(
      sessions,
      participants,
    ),
    ineligiblePopupViews: popupViews.ineligible,
    controlSessionReviews: findControlSessionReviews(sessions, participants),
    unjudgedPopupViews: popupViews.unjudged,
  };
  const result = Object.fromEntries(
    Object.entries(checks).map(([name, rows]) => [name, classify(rows, now)]),
  );
  printReport(result, participants);
  return result;
}

/** Healthchecks.io 본문. 건수만 담는다(식별자를 받지 않는다). */
function formatExposureSummary(result) {
  return Object.entries(CHECK_LABELS)
    .map(
      ([name, label]) =>
        `${label} ${result[name].total}(신규 ${result[name].newCount})`,
    )
    .join(" / ");
}

/** 실행 완료를 알린다. 위반이 있어도 success다(위반 알림은 Datadog 몫, 파일 상단 참고). */
function reportToHealthchecks(result, { ping = { pingSuccess } } = {}) {
  return ping.pingSuccess(PING_ENV_VAR, {
    method: "POST",
    body: formatExposureSummary(result),
  });
}

// check 태그값. Monitor가 이 값으로 알림 대상 항목을 고른다
const CHECK_TAGS = {
  controlSessionFeedback: "control_session_feedback",
  baselineSessionFeedback: "baseline_session_feedback",
  ineligiblePopupViews: "ineligible_popup_views",
  controlSessionReviews: "control_session_reviews",
  unjudgedPopupViews: "unjudged_popup_views",
};
const ALLOWED_TAGS = { check: new Set(Object.values(CHECK_TAGS)) };
const GAUGES = {
  total: "viewlens.feedback_exposure.total",
  newCount: "viewlens.feedback_exposure.new",
};

/** @param {{send: Function}} client */
function sendExposureGauges(result, client) {
  for (const [name, check] of Object.entries(CHECK_TAGS)) {
    for (const [key, metric] of Object.entries(GAUGES)) {
      client.send(metric, result[name][key], "g", { check });
    }
  }
}

async function main() {
  const { db } = require("../db");
  let result;
  try {
    result = run(db);
  } catch (err) {
    await pingFail(PING_ENV_VAR, `실행 실패: ${err.message}`);
    throw err;
  } finally {
    db.close();
  }

  await reportToHealthchecks(result);
  console.log(`[feedback-exposure] 완료 — ${formatExposureSummary(result)}.`);

  const metrics = createDogStatsd({ allowedTags: ALLOWED_TAGS });
  sendExposureGauges(result, metrics);
  await metrics.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[feedback-exposure] 스크립트 오류:", err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  run,
  formatExposureSummary,
  reportToHealthchecks,
  sendExposureGauges,
  CHECK_TAGS,
  ALLOWED_TAGS,
  GAUGES,
  collectRecords,
  isEligibleAt,
  findControlSessionFeedback,
  findBaselineSessionFeedback,
  findControlSessionReviews,
  classifyPopupViews,
  classify,
  CHECK_LABELS,
  RUN_INTERVAL_MS,
};
