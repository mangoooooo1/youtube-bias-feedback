// POST /api/today-reviews 요청 본문 검증
//
// today-reviews-upsert.js와 마찬가지로, 실제 DB 연결 없이 순수 함수로 분리해 단위 테스트가
// 가능하게 한다.

const { ERROR_CODES } = require("../middleware/responseHandler");

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// LLM 폴백 로깅 — 확장의 실패 분류값. server/db.js·llm.js와 1:1 대응 (sessions.js와 동일 목록).
const LLM_STATUSES = ["success", "fallback"];
const FAILURE_REASONS = [
  "timeout",
  "http_error",
  "empty_response",
  "parse_error",
  "network_error",
  "policy_filtered",
];

// 리뷰 텍스트 출처 — llm.js generateReview/generateFallbackReview의 source와 1:1 대응.
const SOURCES = ["llm", "fallback"];

function validateTodayReview(body) {
  const requiredFields = [
    "anonymousId",
    "reviewDate",
    "generatedAt",
    "sessionCount",
    "videoCount",
    "categoryDistribution",
    "entropy",
    "review",
    "reviewTopic",
    "source",
    "promptVersion",
    "llmStatus",
    "geminiMs",
    "genCount",
  ];
  for (const field of requiredFields) {
    const value = body[field];
    if (value === undefined || value === null || String(value).trim() === "") {
      return { code: ERROR_CODES.MISSING_REQUIRED_FIELD, field };
    }
  }

  if (!DATE_PATTERN.test(body.reviewDate)) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "reviewDate" };
  }
  if (isNaN(Date.parse(body.generatedAt))) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "generatedAt" };
  }

  const { sessionCount, videoCount, geminiMs, genCount } = body;
  for (const [field, value] of [
    ["sessionCount", sessionCount],
    ["videoCount", videoCount],
    ["geminiMs", geminiMs],
    ["genCount", genCount],
  ]) {
    if (
      value !== undefined &&
      value !== null &&
      (!Number.isInteger(value) || value < 0)
    ) {
      return { code: ERROR_CODES.INVALID_FIELD_VALUE, field };
    }
  }

  const { entropy } = body;
  if (
    entropy !== undefined &&
    entropy !== null &&
    (typeof entropy !== "number" || !Number.isFinite(entropy) || entropy < 0)
  ) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "entropy" };
  }

  // review/reviewTopic/promptVersion은 자유 텍스트, source만 분류값 검증 (sessions.js와 동일 근거 —
  // llm.js가 topic/feedback/promptVersion을 항상 비어있지 않은 문자열로 반환하므로 빈 문자열은 결함 신호).
  const {
    review,
    reviewTopic,
    source,
    promptVersion,
    llmStatus,
    failureReason,
  } = body;
  for (const [field, value] of [
    ["review", review],
    ["reviewTopic", reviewTopic],
    ["promptVersion", promptVersion],
  ]) {
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "string" || value.trim() === "")
    ) {
      return { code: ERROR_CODES.INVALID_FIELD_VALUE, field };
    }
  }
  if (source !== undefined && source !== null && !SOURCES.includes(source)) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "source" };
  }
  if (
    llmStatus !== undefined &&
    llmStatus !== null &&
    !LLM_STATUSES.includes(llmStatus)
  ) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "llmStatus" };
  }
  if (
    failureReason !== undefined &&
    failureReason !== null &&
    !FAILURE_REASONS.includes(failureReason)
  ) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "failureReason" };
  }

  return null;
}

module.exports = { validateTodayReview };
