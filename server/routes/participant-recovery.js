// 참여코드 기반 재설치 복구 조회 로직

const TEST_CODES = new Set(["TEST-EXP", "TEST-CON"]);

/** code로 이미 등록된 참여자가 있는지 — TEST 코드는 항상 false */
function isPreviouslyRegistered(db, code) {
  if (TEST_CODES.has(code)) return false;
  return !!db
    .prepare("SELECT 1 FROM participants WHERE participantCode = ?")
    .get(code);
}

/** participantCode로 가장 먼저 등록된 참여자 행을 반환한다. */
function findEarliestParticipant(db, participantCode) {
  if (!participantCode || TEST_CODES.has(participantCode)) return null;
  return (
    db
      .prepare(
        `SELECT anonymousId, installDate, group_code FROM participants
         WHERE participantCode = ? ORDER BY installDate ASC LIMIT 1`,
      )
      .get(participantCode) || null
  );
}

module.exports = {
  TEST_CODES,
  isPreviouslyRegistered,
  findEarliestParticipant,
};
