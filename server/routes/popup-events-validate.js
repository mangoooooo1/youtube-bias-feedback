// POST /api/popup-events 요청 본문 검증

const { ERROR_CODES } = require("../middleware/responseHandler");

// 값이 있으면 음수 아닌 정수여야 하는 필드 (미전송 시 null)
const COUNT_FIELDS = ["dwellMs", "tabTodayClicks", "tabWeekClicks"];

function validatePopupEvent(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "body" };
  }

  const { anonymousId, feedbackViewed, openedAt } = body;

  if (typeof anonymousId !== "string" || !anonymousId.trim()) {
    return { code: ERROR_CODES.MISSING_REQUIRED_FIELD, field: "anonymousId" };
  }
  for (const field of COUNT_FIELDS) {
    const value = body[field];
    if (
      value !== undefined &&
      value !== null &&
      (!Number.isInteger(value) || value < 0)
    ) {
      return { code: ERROR_CODES.INVALID_FIELD_VALUE, field };
    }
  }
  if (
    feedbackViewed !== undefined &&
    feedbackViewed !== null &&
    feedbackViewed !== 0 &&
    feedbackViewed !== 1
  ) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "feedbackViewed" };
  }
  if (
    openedAt !== undefined &&
    openedAt !== null &&
    isNaN(Date.parse(openedAt))
  ) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "openedAt" };
  }

  return null;
}

module.exports = { validatePopupEvent, COUNT_FIELDS };
