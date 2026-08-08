const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");

const router = express.Router();

const insertSession = db.prepare(`
  INSERT INTO sessions (anonymousId, sessionId, startTime, endTime, videoCount, categoryDistribution, entropy, totalMs, youtubeMs, geminiMs, llmStatus, failureReason, httpStatus, timedOut, feedbackNotifiedAt, review, reviewTopic, source, promptVersion, topicDistribution, topicEntropy)
  VALUES (@anonymousId, @sessionId, @startTime, @endTime, @videoCount, @categoryDistribution, @entropy, @totalMs, @youtubeMs, @geminiMs, @llmStatus, @failureReason, @httpStatus, @timedOut, @feedbackNotifiedAt, @review, @reviewTopic, @source, @promptVersion, @topicDistribution, @topicEntropy)
`);

//  지연시간 필드 — 확장이 측정해 전송. 선택 항목이며, 있으면 음수 아닌 정수여야 한다.
const LATENCY_FIELDS = ["totalMs", "youtubeMs", "geminiMs"];

// entropy 형태 필드 — 선택 항목이며, 있으면 음수 아닌 유한수여야 한다.
// topicEntropy는 세밀 다양성 신호(Story 10-7), entropy(카테고리)와 동일 검증.
const ENTROPY_FIELDS = ["entropy", "topicEntropy"];

//  LLM 폴백 로깅 — 확장의 실패 분류값. server/db.js·llm.js와 1:1 대응.
const LLM_STATUSES = ["success", "fallback"];
const FAILURE_REASONS = [
  "timeout",
  "http_error",
  "empty_response",
  "parse_error",
  "network_error",
  "policy_filtered",
];

// 피드백 텍스트 출처 (Story 10-11) — llm.js generateReview/generateFallbackReview의 source와 1:1 대응.
const SOURCES = ["llm", "fallback"];

function validateSession(body) {
  const { startTime, endTime, videoCount } = body;

  const requiredFields = ["anonymousId", "sessionId", "startTime", "endTime"];
  for (const field of requiredFields) {
    const value = body[field];
    if (value === undefined || value === null || String(value).trim() === "") {
      return { code: ERROR_CODES.MISSING_REQUIRED_FIELD, field };
    }
  }

  if (isNaN(Date.parse(startTime))) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "startTime" };
  }
  if (isNaN(Date.parse(endTime))) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "endTime" };
  }
  if (
    videoCount !== undefined &&
    (!Number.isInteger(videoCount) || videoCount < 0)
  ) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "videoCount" };
  }
  for (const field of ENTROPY_FIELDS) {
    const value = body[field];
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    ) {
      return { code: ERROR_CODES.INVALID_FIELD_VALUE, field };
    }
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

  //  폴백 로깅 — 값이 있을 때만 분류값·형식 검증 (성공 시 null 허용)
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

  // 피드백 알림 시각 () — 분석 완료 알림을 표시한 경우에만 확장이 함께 전송
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

  // 생성된 피드백 텍스트 (Story 10-11) — review/reviewTopic은 자유 텍스트, source만 분류값 검증.
  // 셋 다 "보내지 않으면 null(구버전 확장 하위호환)"은 허용하되, 보냈다면 공백 문자열은
  // 거부한다 — llm.js가 이제 topic/feedback/promptVersion을 항상 비어있지 않은 문자열로만
  // 반환하므로(generateReview/generateFallbackReview), 빈 문자열은 클라이언트 쪽 결함 신호다.
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

router.post("/", (req, res, next) => {
  const error = validateSession(req.body);
  if (error) {
    return fail(
      res,
      400,
      error.code,
      `${error.field} 필드가 올바르지 않습니다.`,
      error.field,
    );
  }

  const {
    anonymousId,
    sessionId,
    startTime,
    endTime,
    videoCount,
    categoryDistribution,
    entropy,
    totalMs,
    youtubeMs,
    geminiMs,
    llmStatus,
    failureReason,
    httpStatus,
    timedOut,
    feedbackNotifiedAt,
    review,
    reviewTopic,
    source,
    promptVersion,
    topicDistribution,
    topicEntropy,
  } = req.body;

  try {
    insertSession.run({
      anonymousId,
      sessionId,
      startTime,
      endTime,
      videoCount: videoCount ?? null,
      categoryDistribution:
        categoryDistribution != null
          ? JSON.stringify(categoryDistribution)
          : null,
      entropy: entropy ?? null,
      totalMs: totalMs ?? null,
      youtubeMs: youtubeMs ?? null,
      geminiMs: geminiMs ?? null,
      llmStatus: llmStatus ?? null,
      failureReason: failureReason ?? null,
      httpStatus: httpStatus ?? null,
      timedOut: timedOut ?? null,
      feedbackNotifiedAt: feedbackNotifiedAt ?? null,
      review: review ?? null,
      reviewTopic: reviewTopic ?? null,
      source: source ?? null,
      promptVersion: promptVersion ?? null,
      topicDistribution:
        topicDistribution != null ? JSON.stringify(topicDistribution) : null,
      topicEntropy: topicEntropy ?? null,
    });
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return fail(
        res,
        409,
        ERROR_CODES.DUPLICATE_SESSION,
        "이미 존재하는 세션입니다.",
        sessionId,
      );
    }
    return next(err);
  }

  return success(res);
});

// 피드백 열람/확인 시각 갱신 () — 세션 생성 POST와 별도 시점에(알림 클릭, 확인 버튼 클릭 등)
// 호출된다. anonymousId로 소유권을 확인해 다른 참여자의 세션을 갱신하지 못하도록 막는다.
// column은 요청 값이 아니라 아래 두 router.patch 호출부에서만 하드코딩으로 주어지므로
// SQL 인젝션 경로가 없다(server/db.js의 addColumn(table, name, type) 패턴과 동일한 근거).
function makeFeedbackTimestampHandler(column) {
  const update = db.prepare(
    `UPDATE sessions SET ${column} = @value WHERE sessionId = @sessionId AND anonymousId = @anonymousId`,
  );
  return (req, res, next) => {
    const { sessionId } = req.params;
    const { anonymousId } = req.body;

    if (typeof anonymousId !== "string" || !anonymousId.trim()) {
      return fail(
        res,
        400,
        ERROR_CODES.MISSING_REQUIRED_FIELD,
        "anonymousId 필드가 올바르지 않습니다.",
        "anonymousId",
      );
    }

    try {
      const result = update.run({
        sessionId,
        anonymousId,
        value: new Date().toISOString(),
      });
      if (result.changes === 0) {
        return fail(
          res,
          404,
          ERROR_CODES.NOT_FOUND,
          "세션을 찾을 수 없습니다.",
          sessionId,
        );
      }
    } catch (err) {
      return next(err);
    }

    return success(res);
  };
}

// 알림 클릭 기준 — background.js가 호출 (느슨한 신호)
router.patch(
  "/:sessionId/feedback-viewed",
  makeFeedbackTimestampHandler("feedbackViewedAt"),
);
// "피드백 확인하기" 블러 해제 버튼 클릭 기준 — popup.js가 호출 (가장 엄격한 신호)
router.patch(
  "/:sessionId/feedback-confirmed",
  makeFeedbackTimestampHandler("feedbackConfirmedAt"),
);

module.exports = router;
