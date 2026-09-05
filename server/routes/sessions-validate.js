// POST /api/sessions 요청 본문 검증

const { ERROR_CODES } = require("../middleware/responseHandler");

//  지연시간 필드: 확장이 측정해 전송. 선택 항목이며, 있으면 음수 아닌 정수여야 한다.
const LATENCY_FIELDS = ["totalMs", "geminiMs"];

//  LLM 폴백 로깅:  확장의 실패 분류값
const LLM_STATUSES = ["success", "fallback"];
const FAILURE_REASONS = [
  "timeout",
  "http_error",
  "empty_response",
  "parse_error",
  "network_error",
  "policy_filtered",
];

// 피드백 텍스트 출처: llm.js generateReview/generateFallbackReview의 source와 1:1 대응
const SOURCES = ["llm", "fallback"];

// videoIds 개수 상한
const MAX_VIDEO_IDS = 500;

function validateSession(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "body" };
  }

  const { startTime, endTime, videoCount, videoIds } = body;

  // 문자열 타입까지 요구
  // 빈 문자열은 허용하지 않는다. (빈 문자열은 Date.parse에서 NaN으로 처리됨)
  const requiredFields = ["anonymousId", "sessionId", "startTime", "endTime"];
  for (const field of requiredFields) {
    const value = body[field];
    if (typeof value !== "string" || value.trim() === "") {
      return { code: ERROR_CODES.MISSING_REQUIRED_FIELD, field };
    }
  }

  const startMs = Date.parse(startTime);
  if (isNaN(startMs)) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "startTime" };
  }
  const endMs = Date.parse(endTime);
  if (isNaN(endMs)) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "endTime" };
  }
  // 세션 기간이 음수가 되는 걸 막는다 — 동시각(0초 세션)은 허용, 역전만 거부.
  if (endMs < startMs) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "endTime" };
  }
  if (
    videoCount !== undefined &&
    (!Number.isInteger(videoCount) || videoCount < 0)
  ) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "videoCount" };
  }
  // categoryId 조회·entropy 계산은 서버가 직접 하므로, 클라이언트는 entropy/categoryDistribution 대신
  // 이 세션에서 시청한 videoId 목록만 보낸다.
  if (!Array.isArray(videoIds)) {
    return { code: ERROR_CODES.MISSING_REQUIRED_FIELD, field: "videoIds" };
  }
  if (videoIds.length > MAX_VIDEO_IDS) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "videoIds" };
  }
  if (videoIds.some((id) => typeof id !== "string" || id.trim() === "")) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "videoIds" };
  }
  for (const field of LATENCY_FIELDS) {
    const value = body[field];
    if (
      value !== undefined &&
      value !== null &&
      (!Number.isInteger(value) || value < 0)
    ) {
      return { code: ERROR_CODES.INVALID_FIELD_VALUE, field };
    }
  }

  //  폴백 로깅: 값이 있을 때만 분류값·형식 검증 (성공 시 null 허용)
  const { llmStatus, failureReason, httpStatus, timedOut } = body;
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
  if (
    httpStatus !== undefined &&
    httpStatus !== null &&
    (!Number.isInteger(httpStatus) || httpStatus < 0)
  ) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "httpStatus" };
  }
  if (
    timedOut !== undefined &&
    timedOut !== null &&
    timedOut !== 0 &&
    timedOut !== 1
  ) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "timedOut" };
  }

  // 피드백 알림 시각: 분석 완료 알림을 표시한 경우에만 확장이 함께 전송
  const { feedbackNotifiedAt } = body;
  if (
    feedbackNotifiedAt !== undefined &&
    feedbackNotifiedAt !== null &&
    isNaN(Date.parse(feedbackNotifiedAt))
  ) {
    return {
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "feedbackNotifiedAt",
    };
  }

  // 생성된 피드백 텍스트: review/reviewTopic은 자유 텍스트, source만 분류값 검증
  const { review, reviewTopic, source, promptVersion } = body;
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

  return null;
}

module.exports = { validateSession };
