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
 * 코드와 종료 자격(대조군 + isStudyEndUnlocked)을 확인해 결과를 돌려준다. valid일 때만 시각을 기록한다.
 * 코드가 맞는 대조군인데 아직 공개 시각 전이거나 기간 리뷰가 다 만들어지지 않았으면 not_ready다.
 * @returns {"valid"|"invalid"|"not_ready"}
 */
function verifyAndRecordStudyEndCode(db, anonymousId, inputCode, expectedCode) {
  if (!isValidStudyEndCode(inputCode, expectedCode)) return "invalid";

  const participant = db
    .prepare(
      "SELECT group_code, installDate FROM participants WHERE anonymousId = ?",
    )
    .get(anonymousId);
  if (!participant || !CONTROL_GROUPS.has(participant.group_code))
    return "invalid";
  if (!isStudyEndUnlocked(db, anonymousId, participant.installDate))
    return "not_ready";

  db.prepare(
    "UPDATE participants SET studyEndCodeVerifiedAt = COALESCE(studyEndCodeVerifiedAt, ?) WHERE anonymousId = ?",
  ).run(new Date().toISOString(), anonymousId);
  return "valid";
}

module.exports = { isValidStudyEndCode, verifyAndRecordStudyEndCode };
