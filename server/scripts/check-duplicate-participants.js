#!/usr/bin/env node
/**
 * 참여코드 기반 재설치 복구 배포 전 점검 스크립트
 *
 * `participants.anonymousId`는 UNIQUE지만 `participantCode`는 아니다(server/db.js).
 * 재설치 복구 기능을 배포하기 전, 같은 참여코드로 이미 여러 번 등록된 참여자가 있는지
 * 확인한다. `/recover`가 installDate가 가장 이른 행을 반환하므로, 중복이 있다면
 * 그 행이 실제로 "원래 베이스라인 시작일"이 맞는지 수동으로 판단해야 한다.
 *
 * 읽기 전용 — 아무 것도 수정하지 않는다.
 *
 * 사용:
 *   node server/scripts/check-duplicate-participants.js
 */
const path = require("path");

// cron·수동 실행 모두에서 server/.env를 명시적으로 불러온다 (backup-db.js와 동일 이유)
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

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
    `[check-duplicates] 중복 참여코드 ${duplicates.length}건 발견 — 아래 각 코드의 anonymousId별 installDate/sessions/period_reviews를 확인해 어느 행이 실제 첫 설치인지 수동 판단이 필요합니다.\n`,
  );
  for (const row of duplicates) {
    console.log(`participantCode=${row.participantCode} (${row.count}건)`);
    console.log(`  anonymousIds : ${row.anonymousIds}`);
    console.log(`  installDates : ${row.installDates}`);
    console.log(`  groupCodes   : ${row.groupCodes}`);
    console.log("");
  }
}

function main() {
  const { db, initializeDB } = require("../db");
  initializeDB();
  try {
    run(db);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { run };
