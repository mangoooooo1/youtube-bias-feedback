// POST /api/video-events 요청 본문 검증

const { ERROR_CODES } = require("../middleware/responseHandler");

function validateVideoEvent(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "body" };
  }

  for (const field of ["anonymousId", "videoId", "watchedAt"]) {
    const value = body[field];
    if (typeof value !== "string" || !value.trim()) {
      return { code: ERROR_CODES.MISSING_REQUIRED_FIELD, field };
    }
  }

  if (isNaN(Date.parse(body.watchedAt))) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "watchedAt" };
  }

  // sessions.sessionId와 마찬가지로 이 영상이 속한 세션을 가리키는 값 — 구버전 확장
  // 하위호환으로 미전송(null)은 허용하되, 보냈다면 빈 문자열은 거부한다.
  const { sessionId } = body;
  if (
    sessionId !== undefined &&
    sessionId !== null &&
    (typeof sessionId !== "string" || sessionId.trim() === "")
  ) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "sessionId" };
  }

  // 재시도 큐(background.js)가 같은 영상을 다시 보낼 때 서버가 OR IGNORE로 걸러낼 수
  // 있게 하는 멱등 키 — sessionId와 마찬가지로 구버전 확장 하위호환으로 미전송(null)은
  // 허용한다. 문자열이 아닌 값(boolean·object 등)을 그대로 better-sqlite3에 바인딩하면
  // TypeError가 나 500으로 새므로 여기서 미리 걸러낸다.
  const { eventId } = body;
  if (
    eventId !== undefined &&
    eventId !== null &&
    (typeof eventId !== "string" || eventId.trim() === "")
  ) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "eventId" };
  }

  return null;
}

module.exports = { validateVideoEvent };
