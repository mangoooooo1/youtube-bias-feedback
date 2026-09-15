// anonymousId 정규화 — 등록(participants-store.js)·토큰 발급·토큰 검증(requireParticipant.js)
// 세 지점이 전부 이 함수로만 정규화해야 한다(코드리뷰로 발견된 버그: 한 곳이라도 원본 값을
// 쓰면 DB 저장값과 HMAC 입력이 어긋나 not_found/invalid_token으로 이어짐).
//
// db 등 다른 의존성이 전혀 없는 독립 모듈로 분리한 이유 — requireParticipant.js는 최상단에서
// server/db.js를 require해 모듈 로드 시점에 실제 암호화 DB 커넥션을 연다. participants-store.js가
// 이 함수 하나만 쓰려고 requireParticipant.js를 require하면 그 부작용까지 함께 끌려와,
// DB_ENCRYPTION_KEY 없이 participants-store.js만 불러오는 테스트가 전부 깨진다.
function normalizeAnonymousId(anonymousId) {
  return (anonymousId || "").toString().trim();
}

module.exports = { normalizeAnonymousId };
