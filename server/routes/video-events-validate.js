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

  return null;
}

module.exports = { validateVideoEvent };
