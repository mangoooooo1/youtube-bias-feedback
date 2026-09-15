/**
 * anonymousId가 실제로 등록된 참여자인지 확인한다.
 * 등록 없이 임의의 anonymousId로 날조된 참여자를 만들어내는 걸 막는 최소 방어선이다.
 * @param {import("better-sqlite3-multiple-ciphers").Database} db - DB 커넥션
 * @param {string} anonymousId - 확인할 참여자 anonymousId
 * @returns {boolean} 등록된 참여자면 true
 */
function participantExists(db, anonymousId) {
  return !!db
    .prepare("SELECT 1 FROM participants WHERE anonymousId = ?")
    .get(anonymousId);
}

module.exports = { participantExists };
