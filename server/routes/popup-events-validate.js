// POST /api/popup-events 요청 본문 검증

const { ERROR_CODES } = require("../middleware/responseHandler");

// 값이 있으면 음수 아닌 정수여야 하는 필드 (미전송 시 null)
const COUNT_FIELDS = ["dwellMs", "tabTodayClicks", "tabWeekClicks"];

// 값이 있으면 0 또는 1이어야 하는 필드 (미전송 시 null)
const BOOLEAN_FIELDS = ["todayFeedbackViewed", "periodFeedbackViewed"];

function validatePopupEvent(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "body" };
  }

  const { anonymousId, openedAt } = body;

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
  for (const field of BOOLEAN_FIELDS) {
    const value = body[field];
    if (value !== undefined && value !== null && value !== 0 && value !== 1) {
      return { code: ERROR_CODES.INVALID_FIELD_VALUE, field };
    }
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

module.exports = { validatePopupEvent, COUNT_FIELDS, BOOLEAN_FIELDS };
