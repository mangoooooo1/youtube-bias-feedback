#!/usr/bin/env node
/**
 * 개별 참여자 결측(시청 활동 공백) 리포트
 *
 * "아직 연구 관찰 기간 중인" 참여자 중, 마지막 활동으로부터 임계값(기본 4일) 이상 지난 사람을 찾아 보고한다.
 * 연구 종료 시점(installDate + TOTAL_DAYS)이 지난 참여자는 조용해도 정상이므로 제외한다.
 *
 * 알림 역할:
 * - Healthchecks.io: 이 감지 자체가 매일 돌았는지만 본다. 실행이 끝나면 결측 유무와 무관하게
 *   success(인원수 본문 포함), 실행이 실패하면 /fail. 참여자가 많으면 결측 의심 1명 이상이 평소
 *   상태라, 결측으로 fail을 보내면 늘 Down이 되어 실행 실패·cron 중단 메일이 오지 않는다.
 * - Datadog: 같은 인원수를 gauge(태그 없음)로 보내고, 신규 결측이 생기면 Monitor가 알린다.
 * 외부로는 인원수만 보내고, 누구인지(지문·그룹·경과일)는 서버 monitoring.log에만 남긴다.
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
const { createDogStatsd } = require("../monitoring/dogstatsd");

const PING_ENV_VAR = "PARTICIPANT_SILENCE_PING_URL";
// 1차 파일럿 활동 간격 분포(참여자별 최대 간격)로 정한 값. 근거는 관측체계 P00·1 기록 문서.
const DEFAULT_THRESHOLD_DAYS = 4;
// crontab 실행 주기(매일 1회). 신규 판정 구간의 폭이다.
const RUN_INTERVAL_DAYS = 1;

/**
 * 순수 판정 함수(DB 접근 없이 테스트 가능).
 * lastActivityMs: video_events/sessions 중 가장 최근 활동 시각(ms). 활동이 한 번도 없으면 null.
 * newlyFlagged: 직전 실행 이후 처음 임계값을 넘었는지. 매일 실행이면 각 결측은 한 번만 신규로 잡혀,
 * 상태 파일 없이 "이미 Down인 동안 생긴 새 결측"을 셀 수 있다.
 * @returns {{flagged: boolean, newlyFlagged?: boolean, reason?: string, daysSinceActivity?: number, everActive: boolean}}
 */
function evaluateParticipantSilence({
  now,
  installDateMs,
  lastActivityMs,
  totalDays = TOTAL_DAYS,
  thresholdDays = DEFAULT_THRESHOLD_DAYS,
  runIntervalDays = RUN_INTERVAL_DAYS,
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
    const newlyFlagged = daysSinceActivity < thresholdDays + runIntervalDays;
    return { flagged: true, newlyFlagged, daysSinceActivity, everActive };
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

/**
 * 발급은 됐지만 participants에 행이 없는 코드를 찾는다.
 *
 * 등록 자체에 실패한 참여자는 participants에 없어서 collectParticipantActivity의
 * 검사 대상에서 통째로 빠진다. 게다가 서버에는 어떤 접촉 흔적도 남지 않는다.
 */
function collectUnregisteredCodes(db) {
  const { sql, params } = excludeTestCodes("i");
  return db
    .prepare(
      `
      SELECT i.code, i.group_code AS groupCode
        FROM issued_codes i
        LEFT JOIN participants p ON p.participantCode = i.code
       WHERE p.anonymousId IS NULL
         AND ${sql}
       ORDER BY i.code
    `,
    )
    .all(...params);
}

/**
 * issued_codes에서 TEST를 걸러내는 조건. code와 group_code를 둘 다 본다.
 * @param {string} alias - issued_codes 테이블 별칭
 */
function excludeTestCodes(alias) {
  const placeholders = [...TEST_CODES].map(() => "?").join(",");
  return {
    sql: `${alias}.code NOT IN (${placeholders}) AND ${alias}.group_code NOT IN (${placeholders})`,
    params: [...TEST_CODES, ...TEST_CODES],
  };
}

/**
 * 미등록 발급 코드 섹션을 출력한다. 시드 전(실참여자용 발급 코드가 없는 상태)이면 섹션 자체를 생략한다.
 * @returns {{issuedCount: number, unregisteredCount: number}}
 */
function reportUnregisteredCodes(db) {
  // 미등록 조회와 같은 기준으로 세야 "발급 N개 중 등록 M개(= N - K)" 산수가 맞는다.
  // TEST를 분모에만 넣으면 등록되지 않은 TEST 코드가 "등록됨"으로 집계된다.
  const { sql, params } = excludeTestCodes("issued_codes");
  const issuedCount = db
    .prepare(`SELECT COUNT(*) AS c FROM issued_codes WHERE ${sql}`)
    .get(...params).c;
  if (issuedCount === 0) return { issuedCount: 0, unregisteredCount: 0 };

  const unregistered = collectUnregisteredCodes(db);
  console.log(
    `\n[participant-silence] 발급 코드 ${issuedCount}개 중 등록 ${issuedCount - unregistered.length}개, 미등록 ${unregistered.length}개.`,
  );
  if (unregistered.length === 0) return { issuedCount, unregisteredCount: 0 };

  console.log(
    `  미등록은 "아직 설치 전"일 수도, "등록 요청이 실패한 뒤 복구되지 않은" 상태일 수도 있습니다.\n` +
      `  실제 모집 명단과 대조해 확인하세요.\n`,
  );
  for (const row of unregistered) {
    // 참여코드는 사실상의 인증 수단이라 원본을 로그에 남기지 않는다(결측 섹션과 동일 원칙).
    console.log(
      `  code(지문)=${fingerprint(row.code)} groupCode=${row.groupCode}`,
    );
  }
  console.log("");
  return { issuedCount, unregisteredCount: unregistered.length };
}

function run(
  db,
  { now = Date.now(), thresholdDays = DEFAULT_THRESHOLD_DAYS } = {},
) {
  const rows = collectParticipantActivity(db);

  const flagged = [];
  let checkedCount = 0;
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
    if (result.reason === "study_ended") continue;
    checkedCount += 1;
    if (result.flagged) {
      flagged.push({ row, result });
    }
  }

  if (flagged.length === 0) {
    console.log(
      `[participant-silence] 결측 의심 참여자 없음 — 연구 기간 중인 참여자 ${checkedCount}명 확인, 임계값 ${thresholdDays}일.`,
    );
  } else {
    console.log(
      `[participant-silence] 결측 의심 참여자 ${flagged.length}명 발견(임계값 ${thresholdDays}일 이상 무활동, 연구 기간 중인 참여자 ${checkedCount}명 중). ` +
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
      if (result.newlyFlagged)
        console.log("  신규(이번 실행에서 처음 임계값을 넘음)");
      console.log("");
    }
  }

  // "등록은 됐는데 조용한 참여자"와 "등록 자체가 안 된 코드"는 성격이 다르므로
  // 섹션과 집계를 분리한다. flaggedCount에 섞으면 자연스러운 이탈과 전송 장애가 뭉개진다.
  const codes = reportUnregisteredCodes(db);

  return {
    flaggedCount: flagged.length,
    newCount: flagged.filter(({ result }) => result.newlyFlagged).length,
    checkedCount,
    ...codes,
  };
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

/** Healthchecks.io 본문. 인원수만 담는다(식별자를 받지 않는다). */
function formatSilenceSummary({
  flaggedCount,
  newCount,
  checkedCount,
  unregisteredCount,
}) {
  return `결측 의심 ${flaggedCount}명(신규 ${newCount}명) / 검사 ${checkedCount}명 / 미등록 ${unregisteredCount}개`;
}

/** 실행 완료를 알린다. 결측 의심이 있어도 success다(결측 알림은 Datadog 몫, 파일 상단 참고). */
function reportToHealthchecks(result, { ping = { pingSuccess } } = {}) {
  return ping.pingSuccess(PING_ENV_VAR, {
    method: "POST",
    body: formatSilenceSummary(result),
  });
}

const GAUGES = {
  flaggedCount: "viewlens.participant_silence.flagged",
  newCount: "viewlens.participant_silence.new",
  checkedCount: "viewlens.participant_silence.checked",
  unregisteredCount: "viewlens.participant_silence.unregistered",
};

/** @param {{send: Function}} client */
function sendSilenceGauges(result, client) {
  for (const [key, name] of Object.entries(GAUGES)) {
    client.send(name, result[key], "g");
  }
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
    await pingFail(PING_ENV_VAR, `실행 실패: ${err.message}`);
    throw err;
  } finally {
    db.close();
  }

  await reportToHealthchecks(result);
  console.log(`[participant-silence] 완료 — ${formatSilenceSummary(result)}.`);

  const metrics = createDogStatsd({ allowedTags: {} });
  sendSilenceGauges(result, metrics);
  await metrics.close();
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
  collectUnregisteredCodes,
  parseThresholdArg,
  formatSilenceSummary,
  reportToHealthchecks,
  sendSilenceGauges,
  GAUGES,
  DEFAULT_THRESHOLD_DAYS,
  RUN_INTERVAL_DAYS,
};
