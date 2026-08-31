// GET /health가 반환할 상태를 계산하는 순수 함수
// Express 핸들러에서 분리해 단위 테스트가 가능하게 한다.
// "서버 프로세스가 살아있다"와 "DB에 실제로 접근 가능하다"는 다른 상태이므로 함께 확인해 구분해서 반환한다.
// 후자가 죽어도 서버 자체는 응답할 수 있어 200으로 응답하되 db 필드로 구분한다.
function buildHealthPayload(db, now = Date.now) {
  let dbOk = true;
  try {
    db.prepare("SELECT 1").get();
  } catch {
    dbOk = false;
  }
  return {
    status: dbOk ? "healthy" : "degraded",
    db: dbOk ? "ok" : "fail",
    timestamp: now(),
  };
}

module.exports = { buildHealthPayload };
