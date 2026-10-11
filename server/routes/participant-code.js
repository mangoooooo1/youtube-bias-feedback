// 참여 코드 정규화
// 확인(GET /validate)·등록(participants-store.js)·복구(POST /recover)가
// 같은 값으로 명단을 조회하도록 이 함수 하나만 쓴다. anonymous-id.js처럼 db 의존성이 없다.
//
// 문자열만 받는다. JSON 본문의 {"toString":null} 같은 객체에 toString()을 부르면 예외가 나 500이 된다.
function normalizeParticipantCode(code) {
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}

module.exports = { normalizeParticipantCode };
