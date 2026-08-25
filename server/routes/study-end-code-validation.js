// 대조군 연구종료 설문 연동 코드 검증 — 대조군 전원 공통 코드 1개와 대조

const {
  CONTROL_GROUPS,
  isStudyEndUnlocked,
} = require("./period-reviews-query");

/**
 * 입력 코드가 서버에 설정된 공통 코드와 일치하는지 확인한다.
 * expectedCode가 비어 있으면(미설정) 항상 거부한다.
 */
function isValidStudyEndCode(inputCode, expectedCode) {
  if (!expectedCode) return false;
  const normalize = (v) => (v ?? "").toString().trim().toUpperCase();
  return normalize(inputCode) === normalize(expectedCode);
}

/**
 * 코드가 맞고 anonymousId가 실제로 종료 자격(대조군 + isStudyEndUnlocked)을 갖췄을 때만 true를 반환
 */
function verifyAndRecordStudyEndCode(db, anonymousId, inputCode, expectedCode) {
  if (!isValidStudyEndCode(inputCode, expectedCode)) return false;

  const participant = db
    .prepare(
      "SELECT group_code, installDate FROM participants WHERE anonymousId = ?",
    )
    .get(anonymousId);
  if (!participant || !CONTROL_GROUPS.has(participant.group_code)) return false;
  if (!isStudyEndUnlocked(db, anonymousId, participant.installDate))
    return false;

  db.prepare(
    "UPDATE participants SET studyEndCodeVerifiedAt = COALESCE(studyEndCodeVerifiedAt, ?) WHERE anonymousId = ?",
  ).run(new Date().toISOString(), anonymousId);
  return true;
}

module.exports = { isValidStudyEndCode, verifyAndRecordStudyEndCode };
