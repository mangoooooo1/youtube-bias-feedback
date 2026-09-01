#!/usr/bin/env node
/**
 * 개별 참여자 결측(시청 활동 공백) 리포트
 *
 * "아직 연구 관찰 기간 중인" 참여자 중, 마지막 활동으로부터 임계값(기본 3일) 이상 지난 사람을 찾아 보고한다.
 * 연구 종료 시점(installDate + TOTAL_DAYS)이 지난 참여자는 조용해도 정상이므로 제외한다.
 *
 * 개별 참여자 비활성은 "연구 장애"라기보다 자연스러운 이탈일 수도 있어, 기존 모니터처럼
 * 매번 Healthchecks.io에 실패 신호를 보내지 않는다.
 *
 * 읽기 전용 — DB를 수정하지 않는다.
 *
 * 사용:
 *   node server/scripts/participant-silence-report.js [임계값_일수]
 */
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { fingerprint } = require("./fingerprint");
const { TEST_CODES } = require("../routes/participant-recovery");
const { TOTAL_DAYS } = require("../pipeline/study-constants");
const { pingSuccess, pingFail } = require("../monitoring/healthchecks-ping");

const PING_ENV_VAR = "PARTICIPANT_SILENCE_PING_URL";
const DEFAULT_THRESHOLD_DAYS = 3;

/**
 * 순수 판정 함수(DB 접근 없이 테스트 가능).
 * lastActivityMs: video_events/sessions 중 가장 최근 활동 시각(ms). 활동이 한 번도 없으면 null.
 * @returns {{flagged: boolean, reason?: string, daysSinceActivity?: number, everActive: boolean}}
 */
function evaluateParticipantSilence({
  now,
  installDateMs,
  lastActivityMs,
  totalDays = TOTAL_DAYS,
  thresholdDays = DEFAULT_THRESHOLD_DAYS,
}) {
  const studyEndMs = installDateMs + totalDays * 86400000;
  if (now >= studyEndMs) {
    return {
      flagged: false,
      reason: "study_ended",
      everActive: lastActivityMs != null,
    };
  }

  const everActive = lastActivityMs != null;
  // 활동이 한 번도 없으면 설치일을 기준점으로 삼는다 — "설치 후 계속 조용함"도
  // "활동하다가 조용해짐"과 같은 방식으로 판정한다.
  const referenceMs = everActive ? lastActivityMs : installDateMs;
  const daysSinceActivity = (now - referenceMs) / 86400000;

  if (daysSinceActivity >= thresholdDays) {
    return { flagged: true, daysSinceActivity, everActive };
  }
  return { flagged: false, daysSinceActivity, everActive };
}

/**
 * 참여자별(TEST 그룹 제외) installDate·최근 활동 시각(video_events.watchedAt과
 * sessions.createdAt 중 더 최근인 쪽)을 모은다. 두 컬럼 다 형식이 다를 수 있어
 * (오프셋 포함 ISO 문자열 / SQLite datetime('now') 공백 구분 형식) research-pipeline-monitor.js와
 * 동일한 근거로 SQLite의 시간 함수(strftime)로 정규화해 유닉스 초 단위로 통일한다 —
 * 단순 문자열 비교·최댓값은 형식이 섞이면 순서를 잘못 판단할 수 있다(bug-30/31).
 */
function collectParticipantActivity(db) {
  const placeholders = [...TEST_CODES].map(() => "?").join(",");
  return db
    .prepare(
      `
      SELECT
        p.anonymousId,
        p.participantCode,
        p.group_code AS groupCode,
        p.installDate,
        (SELECT MAX(strftime('%s', ve.watchedAt)) FROM video_events ve
          WHERE ve.anonymousId = p.anonymousId) AS lastVideoTs,
        (SELECT MAX(strftime('%s', s.createdAt)) FROM sessions s
          WHERE s.anonymousId = p.anonymousId) AS lastSessionTs
      FROM participants p
      WHERE p.group_code NOT IN (${placeholders})
    `,
    )
    .all(...TEST_CODES);
}

function run(
  db,
  { now = Date.now(), thresholdDays = DEFAULT_THRESHOLD_DAYS } = {},
) {
  const rows = collectParticipantActivity(db);

  const flagged = [];
  for (const row of rows) {
    const installDateMs = Date.parse(row.installDate);
    if (!Number.isFinite(installDateMs)) continue; // 손상된 값 — 이 리포트가 아니라 별도로 다룰 문제

    const lastVideoMs =
      row.lastVideoTs != null ? Number(row.lastVideoTs) * 1000 : null;
    const lastSessionMs =
      row.lastSessionTs != null ? Number(row.lastSessionTs) * 1000 : null;
    const candidates = [lastVideoMs, lastSessionMs].filter((v) => v != null);
    const lastActivityMs =
      candidates.length > 0 ? Math.max(...candidates) : null;

    const result = evaluateParticipantSilence({
      now,
      installDateMs,
      lastActivityMs,
      thresholdDays,
    });
    if (result.flagged) {
      flagged.push({ row, result });
    }
  }

  if (flagged.length === 0) {
    console.log(
      `[participant-silence] 결측 의심 참여자 없음 — 연구 기간 중인 참여자 ${rows.length}명 확인, 임계값 ${thresholdDays}일.`,
    );
    return { flaggedCount: 0, checkedCount: rows.length };
  }

  console.log(
    `[participant-silence] 결측 의심 참여자 ${flagged.length}명 발견(임계값 ${thresholdDays}일 이상 무활동, 연구 기간 중인 참여자 ${rows.length}명 중). ` +
      `아래 값은 원본이 아니라 일방향 해시(지문, 앞 10자)입니다 — 해당 지문에 대응하는 실제 참여자는 DB를 직접 조회해 확인하세요.\n`,
  );
  for (const { row, result } of flagged) {
    console.log(
      `participantCode(지문)=${fingerprint(row.participantCode)} groupCode=${row.groupCode}`,
    );
    console.log(`  anonymousId(지문) : ${fingerprint(row.anonymousId)}`);
    console.log(`  installDate       : ${row.installDate}`);
    console.log(
      result.everActive
        ? `  마지막 활동으로부터 : ${result.daysSinceActivity.toFixed(1)}일 경과`
        : `  활동 기록 자체가 없음(설치 후 ${result.daysSinceActivity.toFixed(1)}일 경과)`,
    );
    console.log("");
  }
  return { flaggedCount: flagged.length, checkedCount: rows.length };
}

/**
 * 인수가 없으면 기본값을 쓰고, 있으면 0보다 큰 유한수인지 검증한다.
 * 빈 문자열은 Number("") === 0이라 Number.isFinite만으로는 걸러지지 않아 별도로 막는다.
 */
function parseThresholdArg(rawArg) {
  if (rawArg === undefined) return DEFAULT_THRESHOLD_DAYS;
  const parsed = Number(rawArg);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`임계값_일수는 0보다 큰 숫자여야 합니다: "${rawArg}"`);
  }
  return parsed;
}

async function main() {
  let thresholdDays;
  try {
    thresholdDays = parseThresholdArg(process.argv[2]);
  } catch (err) {
    console.error(`[participant-silence] ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const { db } = require("../db");
  let result;
  try {
    result = run(db, { thresholdDays });
  } catch (err) {
    // 결측 참여자 유무와 무관하게, 스크립트 실행 자체가 실패했다는 것과는 구분해서 알린다.
    await pingFail(
      PING_ENV_VAR,
      `participant-silence-report 실행 실패: ${err.message}`,
    );
    throw err;
  } finally {
    db.close();
  }

  // 개별 참여자 결측은 "연구 장애"가 아니라 정기적으로 사람이 검토할 참고 정보라, 결측 유무와
  // 무관하게 "스크립트 자체가 정상 실행됐는지"만 ping한다(파일 상단 설명 참고).
  await pingSuccess(PING_ENV_VAR);
  console.log(
    `[participant-silence] 완료 — 결측 의심 ${result.flaggedCount}명 / 검사 대상 ${result.checkedCount}명.`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[participant-silence] 스크립트 오류:", err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  run,
  evaluateParticipantSilence,
  collectParticipantActivity,
  parseThresholdArg,
  DEFAULT_THRESHOLD_DAYS,
};
