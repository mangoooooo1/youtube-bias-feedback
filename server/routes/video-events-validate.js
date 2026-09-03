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

  // 유입 경로 판별용 원시 신호
  // 확장 쪽에서 이전 URL을 못 구했을 수도 있어 sessionId/eventId와 마찬가지로 미전송(null)을 허용한다.
  const { entryHost } = body;
  if (
    entryHost !== undefined &&
    entryHost !== null &&
    (typeof entryHost !== "string" || entryHost.trim() === "")
  ) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "entryHost" };
  }

  const { entryPath } = body;
  if (
    entryPath !== undefined &&
    entryPath !== null &&
    (typeof entryPath !== "string" || entryPath.trim() === "")
  ) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "entryPath" };
  }

  // 자동재생/사용자 조작 구분 신호 — content.js가 판단 못 하면 null(알 수 없음)로 보낸다.
  // 자유 문자열이 아니라 정해진 값만 허용해, 서버의 분류 로직이 처리 못 할 값이 들어오는 걸 막는다.
  const { navigationTrigger } = body;
  if (
    navigationTrigger !== undefined &&
    navigationTrigger !== null &&
    !["ended", "interaction"].includes(navigationTrigger)
  ) {
    return {
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "navigationTrigger",
    };
  }

  return null;
}

module.exports = { validateVideoEvent };
