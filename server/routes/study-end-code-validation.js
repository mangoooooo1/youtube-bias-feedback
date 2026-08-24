// 대조군 연구종료 설문 연동 코드 검증 — 대조군 전원 공통 코드 1개와 대조

/**
 * 입력 코드가 서버에 설정된 공통 코드와 일치하는지 확인한다.
 * expectedCode가 비어 있으면(미설정) 항상 거부한다.
 */
function isValidStudyEndCode(inputCode, expectedCode) {
  if (!expectedCode) return false;
  const normalize = (v) => (v ?? "").toString().trim().toUpperCase();
  return normalize(inputCode) === normalize(expectedCode);
}

module.exports = { isValidStudyEndCode };
