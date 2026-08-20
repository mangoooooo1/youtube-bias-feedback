#!/usr/bin/env node
/**
 * 참여코드 기반 재설치 복구 배포 전 점검 스크립트
 *
 * `participants.anonymousId`는 UNIQUE지만 `participantCode`는 아니다(server/db.js).
 * 재설치 복구 기능을 배포하기 전, 같은 참여코드로 이미 여러 번 등록된 참여자가 있는지
 * 확인한다. `/recover`가 installDate가 가장 이른 행을 반환하므로, 중복이 있다면
 * 그 행이 실제로 "원래 베이스라인 시작일"이 맞는지 수동으로 판단해야 한다.
 *
 * 읽기 전용 — DB 스키마를 포함해 아무 것도 수정하지 않는다.
 * initializeDB를 호출하지 않음
 * 이미 있는 스키마에 DDL을 실행하거나, 잘못된 DB 경로를 가리켰을 때 빈 테이블을 새로 만들어 "중복 없음"으로 잘못 통과하는 걸 막기 위함.
 *
 * participantCode(사실상의 인증 수단)와 anonymousId(참여자 식별자)는 원본을 로그에 남기지 않고 짧은 일방향 해시(지문)로만 출력한다.
 *
 *   node server/scripts/check-duplicate-participants.js
 */
const path = require("path");
const crypto = require("crypto");

// cron·수동 실행 모두에서 server/.env를 명시적으로 불러온다 (backup-db.js와 동일 이유)
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

function fingerprint(value) {
  if (!value) return "(none)";
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 10);
}

function run(db) {
  const duplicates = db
    .prepare(
      `
      SELECT participantCode,
             COUNT(*) AS count,
             GROUP_CONCAT(anonymousId) AS anonymousIds,
             GROUP_CONCAT(installDate) AS installDates,
             GROUP_CONCAT(group_code) AS groupCodes
      FROM participants
      WHERE participantCode IS NOT NULL
      GROUP BY participantCode
      HAVING count > 1
    `,
    )
    .all();

  if (duplicates.length === 0) {
    console.log("[check-duplicates] 중복 등록 없음 — 배포 전 점검 통과.");
    return;
  }

  console.log(
    `[check-duplicates] 중복 참여코드 ${duplicates.length}건 발견. 아래 값은 원본이 아니라 일방향 해시(지문, 앞 10자)입니다 — ` +
      `해당 지문에 대응하는 실제 코드/anonymousId는 DB를 직접 조회해, installDate/sessions/period_reviews를 확인하고 ` +
      `어느 행이 실제 첫 설치인지 수동 판단하세요.\n`,
  );
  for (const row of duplicates) {
    const anonymousIds = row.anonymousIds.split(",").map(fingerprint);
    const installDates = row.installDates.split(","); // 날짜 자체가 판단 근거라 마스킹하지 않음
    const groupCodes = row.groupCodes.split(",");
    console.log(
      `participantCode(지문)=${fingerprint(row.participantCode)} (${row.count}건)`,
    );
    console.log(`  anonymousId(지문) : ${anonymousIds.join(", ")}`);
    console.log(`  installDate       : ${installDates.join(", ")}`);
    console.log(`  groupCode         : ${groupCodes.join(", ")}`);
    console.log("");
  }
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
  main();
}

module.exports = { run, fingerprint };
