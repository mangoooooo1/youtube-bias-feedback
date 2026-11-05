#!/usr/bin/env node
/**
 * 연구 운영 대시보드 지표
 *
 * 알림 기준에 못 미치는 이상(수집이 고르지 않음, 피드백이 열람까지 이어지지 않음, 빈 세션 증가)을
 * 연구 기간 안에 보려고, 어제(KST) 하루치를 매일 Datadog gauge로 보낸다.
 * - 참여자별: 어제 영상 기록 수, 마지막 활동 뒤 경과일. 연구 기간 중인 참여자만(결측 감지와 같은 기준)
 * - 피드백 퍼널: 어제 끝난 실험군 세션 중 피드백 자격이 있던 세션의 생성 → 알림 → 열람 → 확인 수
 * - 세션 품질: 어제 끝난 세션의 영상 수 분포(세션 수, 0개 세션 수, 중앙값, p95, 최댓값)
 *
 * 참여자별 gauge에는 participant 태그로 anonymousId 지문만 붙인다. 참여 코드·집단·카테고리·제목은
 * 보내지 않는다. 허용 목록은 이번 실행에서 계산한 지문으로만 만든다(dogstatsd.js의 허용 목록 원칙 유지).
 * 하루 한 번만 보내므로 커스텀 메트릭 사용량(시간당 시계열 수의 월평균)은 시계열당 약 1/24이다.
 *
 * Healthchecks.io: 실행 여부만 본다. 끝나면 success(인원·세션 수 본문), 실행이 실패하면 /fail.
 *
 * 읽기 전용 — DB를 수정하지 않는다.
 *
 * 사용:
 *   node server/scripts/research-ops-metrics.js
 */
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { fingerprint } = require("./fingerprint");
const { TEST_CODES } = require("../routes/participant-recovery");
const {
  isTodayReviewEligible,
  FEEDBACK_GROUPS,
} = require("../routes/today-reviews-query");
const { kstDateStr } = require("../pipeline/period-boundaries");
const { evaluateParticipantSilence } = require("./participant-silence-report");
const { pingSuccess, pingFail } = require("../monitoring/healthchecks-ping");
const { createDogStatsd } = require("../monitoring/dogstatsd");

const PING_ENV_VAR = "RESEARCH_OPS_PING_URL";
const DAY_MS = 24 * 60 * 60 * 1000;

/** now 기준 어제(KST) 00:00 ~ 오늘 00:00. */
function yesterdayWindow(now) {
  const day = kstDateStr(new Date(now - DAY_MS));
  const startMs = Date.parse(`${day}T00:00:00+09:00`);
  return { day, startMs, endMs: startMs + DAY_MS };
}

/**
 * 참여자별(TEST 제외) 설치일·최근 활동 시각·어제 영상 기록 수.
 * 시각 형식이 섞여 있어 strftime으로 유닉스 초로 맞춘다(participant-silence-report.js와 같은 이유).
 */
function collectParticipantRows(db, { startMs, endMs }) {
  const placeholders = [...TEST_CODES].map(() => "?").join(",");
  return db
    .prepare(
      `
      SELECT
        p.anonymousId,
        p.installDate,
        (SELECT MAX(strftime('%s', ve.watchedAt)) FROM video_events ve
          WHERE ve.anonymousId = p.anonymousId) AS lastVideoTs,
        (SELECT MAX(strftime('%s', s.createdAt)) FROM sessions s
          WHERE s.anonymousId = p.anonymousId) AS lastSessionTs,
        (SELECT COUNT(*) FROM video_events ve
          WHERE ve.anonymousId = p.anonymousId
            AND CAST(strftime('%s', ve.watchedAt) AS INTEGER) >= ?
            AND CAST(strftime('%s', ve.watchedAt) AS INTEGER) < ?) AS dailyVideos
      FROM participants p
      WHERE p.group_code NOT IN (${placeholders})
    `,
    )
    .all(startMs / 1000, endMs / 1000, ...TEST_CODES);
}

/** 연구 기간 중인 참여자만 남겨 지문·어제 기록 수·경과일로 바꾼다. */
function buildParticipantStats(rows, now) {
  const stats = [];
  for (const row of rows) {
    const installDateMs = Date.parse(row.installDate);
    if (!Number.isFinite(installDateMs)) continue;
    const candidates = [row.lastVideoTs, row.lastSessionTs]
      .filter((v) => v != null)
      .map((v) => Number(v) * 1000);
    const lastActivityMs =
      candidates.length > 0 ? Math.max(...candidates) : null;
    const result = evaluateParticipantSilence({
      now,
      installDateMs,
      lastActivityMs,
    });
    if (result.reason === "study_ended") continue;
    stats.push({
      fp: fingerprint(row.anonymousId),
      dailyVideos: row.dailyVideos,
      daysSinceActivity: Math.round(result.daysSinceActivity * 10) / 10,
    });
  }
  return stats;
}

/** 어제 끝난 세션(TEST 제외)과 퍼널 판정에 필요한 참여자 정보. */
function collectEndedSessions(db, { startMs, endMs }) {
  const placeholders = [...TEST_CODES].map(() => "?").join(",");
  return db
    .prepare(
      `
      SELECT
        CAST(strftime('%s', s.endTime) AS INTEGER) AS endTs,
        s.videoCount,
        s.review IS NOT NULL AS reviewed,
        s.feedbackNotifiedAt IS NOT NULL AS notified,
        s.feedbackViewedAt IS NOT NULL AS viewed,
        s.feedbackConfirmedAt IS NOT NULL AS confirmed,
        p.group_code,
        p.installDate,
        p.studyEndCodeVerifiedAt
      FROM sessions s
      JOIN participants p ON p.anonymousId = s.anonymousId
      WHERE CAST(strftime('%s', s.endTime) AS INTEGER) >= ?
        AND CAST(strftime('%s', s.endTime) AS INTEGER) < ?
        AND p.group_code NOT IN (${placeholders})
    `,
    )
    .all(startMs / 1000, endMs / 1000, ...TEST_CODES);
}

/**
 * 실험군 세션 중 끝난 시각에 피드백 자격이 있던 것만 센다. 베이스라인 세션은 처치 대상이 아니다.
 * 열람·확인은 실행 시각(다음 날 오전)까지 일어난 것만 잡힌다.
 */
function summarizeFunnel(sessions) {
  const funnel = {
    sessions: 0,
    reviewed: 0,
    notified: 0,
    viewed: 0,
    confirmed: 0,
  };
  for (const s of sessions) {
    if (!FEEDBACK_GROUPS.has(s.group_code)) continue;
    if (!isTodayReviewEligible(s, new Date(s.endTs * 1000))) continue;
    funnel.sessions += 1;
    if (s.reviewed) funnel.reviewed += 1;
    if (s.notified) funnel.notified += 1;
    if (s.viewed) funnel.viewed += 1;
    if (s.confirmed) funnel.confirmed += 1;
  }
  return funnel;
}

/** 정렬된 배열의 nearest-rank 백분위수. */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** 세션당 영상 수 분포. videoCount가 비어 있으면 0개로 본다. */
function summarizeSessionQuality(sessions) {
  const counts = sessions.map((s) => s.videoCount ?? 0).sort((a, b) => a - b);
  return {
    sessions: counts.length,
    zero: counts.filter((c) => c === 0).length,
    median: percentile(counts, 50),
    p95: percentile(counts, 95),
    max: counts.length > 0 ? counts[counts.length - 1] : 0,
  };
}

function run(db, { now = Date.now() } = {}) {
  const window = yesterdayWindow(now);
  const participants = buildParticipantStats(
    collectParticipantRows(db, window),
    now,
  );
  const sessions = collectEndedSessions(db, window);
  return {
    day: window.day,
    participants,
    funnel: summarizeFunnel(sessions),
    quality: summarizeSessionQuality(sessions),
  };
}

function formatSummary(result) {
  const { participants, funnel, quality } = result;
  const active = participants.filter((p) => p.dailyVideos > 0).length;
  return (
    `${result.day} 참여자 ${participants.length}명(활동 ${active}명) / ` +
    `퍼널 ${funnel.sessions}→${funnel.reviewed}→${funnel.notified}→${funnel.viewed}→${funnel.confirmed} / ` +
    `세션 ${quality.sessions}개(0개 ${quality.zero})`
  );
}

/** 실행 완료를 알린다. 값과 무관하게 success다(이상은 대시보드에서 본다). */
function reportToHealthchecks(result, { ping = { pingSuccess } } = {}) {
  return ping.pingSuccess(PING_ENV_VAR, {
    method: "POST",
    body: formatSummary(result),
  });
}

const GAUGES = {
  dailyVideos: "viewlens.participant.daily_videos",
  daysSinceActivity: "viewlens.participant.days_since_activity",
  funnel: "viewlens.feedback_funnel.",
  quality: "viewlens.session_quality.",
};

/** 참여자 지문만 허용 목록에 넣어 gauge를 보낸다. */
function sendGauges(result, createClient = createDogStatsd) {
  const client = createClient({
    allowedTags: {
      participant: new Set(result.participants.map((p) => p.fp)),
    },
  });
  for (const p of result.participants) {
    const tags = { participant: p.fp };
    client.send(GAUGES.dailyVideos, p.dailyVideos, "g", tags);
    client.send(GAUGES.daysSinceActivity, p.daysSinceActivity, "g", tags);
  }
  for (const [key, value] of Object.entries(result.funnel)) {
    client.send(`${GAUGES.funnel}${key}`, value, "g");
  }
  for (const [key, value] of Object.entries(result.quality)) {
    client.send(`${GAUGES.quality}${key}`, value, "g");
  }
  return client;
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
  console.log(`[research-ops] 완료 — ${formatSummary(result)}.`);
  for (const p of result.participants) {
    console.log(
      `  participant(지문)=${p.fp} 어제 기록 ${p.dailyVideos}건, 마지막 활동 뒤 ${p.daysSinceActivity}일`,
    );
  }

  const client = sendGauges(result);
  await client.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[research-ops] 스크립트 오류:", err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  run,
  yesterdayWindow,
  buildParticipantStats,
  summarizeFunnel,
  summarizeSessionQuality,
  percentile,
  formatSummary,
  reportToHealthchecks,
  sendGauges,
  GAUGES,
  PING_ENV_VAR,
};
