// POST /api/client-errors 요청 본문 검증
// 로그에 남는 값은 전부 여기서 고정 목록·형식으로 걸러진 것뿐이다(시청 콘텐츠가 섞일 여지를 없앤다).

const { ERROR_CODES } = require("../middleware/responseHandler");

// 확장 extension/error-report.js의 목록과 맞춰야 한다
const CLIENT_ERROR_CODES = new Set([
  "RECORD_FAILED",
  "QUEUE_CRASHED",
  "TASK_CRASHED",
  "SYNC_STALLED",
  "POPUP_BOOT_FAILED",
]);

const CLIENT_ERROR_WHERE = new Set([
  "content.recordVideo",
  "background.queue.participants",
  "background.queue.sessions",
  "background.queue.video_events",
  "background.queue.watch_stats",
  "background.serverTasks",
  "background.sessionTimeout",
  "background.persistServerUrl",
  "popup.boot",
]);

const MAX_ERRORS_PER_REQUEST = 20;
const MAX_ANONYMOUS_ID_LENGTH = 100;
const VERSION_PATTERN = /^\d+(\.\d+){0,3}$/;

function invalid(field) {
  return { code: ERROR_CODES.INVALID_FIELD_VALUE, field };
}

function validateErrorEntry(entry, index) {
  const field = (name) => `errors[${index}].${name}`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return invalid(`errors[${index}]`);
  }
  if (!CLIENT_ERROR_CODES.has(entry.code)) return invalid(field("code"));
  if (!CLIENT_ERROR_WHERE.has(entry.where)) return invalid(field("where"));
  if (!Number.isInteger(entry.count) || entry.count < 1) {
    return invalid(field("count"));
  }
  for (const name of ["firstAt", "lastAt"]) {
    if (typeof entry[name] !== "string" || isNaN(Date.parse(entry[name]))) {
      return invalid(field(name));
    }
  }
  return null;
}

function validateClientErrors(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return invalid("body");
  }

  const { anonymousId, version, errors } = body;

  // 등록 전 오류도 받아야 하므로 anonymousId는 선택이다
  if (
    anonymousId !== undefined &&
    anonymousId !== null &&
    (typeof anonymousId !== "string" ||
      !anonymousId.trim() ||
      anonymousId.length > MAX_ANONYMOUS_ID_LENGTH)
  ) {
    return invalid("anonymousId");
  }
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    return { code: ERROR_CODES.MISSING_REQUIRED_FIELD, field: "version" };
  }
  if (
    !Array.isArray(errors) ||
    errors.length === 0 ||
    errors.length > MAX_ERRORS_PER_REQUEST
  ) {
    return invalid("errors");
  }
  for (let i = 0; i < errors.length; i += 1) {
    const error = validateErrorEntry(errors[i], i);
    if (error) return error;
  }

  return null;
}

module.exports = {
  validateClientErrors,
  CLIENT_ERROR_CODES,
  CLIENT_ERROR_WHERE,
  MAX_ERRORS_PER_REQUEST,
};
