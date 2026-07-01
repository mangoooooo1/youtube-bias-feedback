const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");

const router = express.Router();

const insertSession = db.prepare(`
  INSERT INTO sessions (anonymousId, sessionId, startTime, endTime, videoCount, categoryDistribution, entropy, totalMs, youtubeMs, geminiMs, llmStatus, failureReason, httpStatus, timedOut)
  VALUES (@anonymousId, @sessionId, @startTime, @endTime, @videoCount, @categoryDistribution, @entropy, @totalMs, @youtubeMs, @geminiMs, @llmStatus, @failureReason, @httpStatus, @timedOut)
`);

// 10-3 지연시간 필드 — 확장이 측정해 전송. 선택 항목이며, 있으면 음수 아닌 정수여야 한다.
const LATENCY_FIELDS = ["totalMs", "youtubeMs", "geminiMs"];

// 10-4 LLM 폴백 로깅 — 확장의 실패 분류값. server/db.js·llm.js와 1:1 대응.
const LLM_STATUSES = ["success", "fallback"];
const FAILURE_REASONS = ["timeout", "http_error", "empty_response", "parse_error", "network_error"];

function validateSession(body) {
  const { anonymousId, sessionId, startTime, endTime, videoCount, entropy } = body;

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
  if (videoCount !== undefined && (!Number.isInteger(videoCount) || videoCount < 0)) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "videoCount" };
  }
  if (entropy !== undefined && (typeof entropy !== "number" || !Number.isFinite(entropy) || entropy < 0)) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "entropy" };
  }
  for (const field of LATENCY_FIELDS) {
    const value = body[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      return { code: ERROR_CODES.INVALID_FIELD_VALUE, field };
    }
  }

  // 10-4 폴백 로깅 — 값이 있을 때만 분류값·형식 검증 (성공 시 null 허용)
  const { llmStatus, failureReason, httpStatus, timedOut } = body;
  if (llmStatus !== undefined && llmStatus !== null && !LLM_STATUSES.includes(llmStatus)) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "llmStatus" };
  }
  if (failureReason !== undefined && failureReason !== null && !FAILURE_REASONS.includes(failureReason)) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "failureReason" };
  }
  if (httpStatus !== undefined && httpStatus !== null && (!Number.isInteger(httpStatus) || httpStatus < 0)) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "httpStatus" };
  }
  if (timedOut !== undefined && timedOut !== null && timedOut !== 0 && timedOut !== 1) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "timedOut" };
  }

  return null;
}

router.post("/", (req, res, next) => {
  const error = validateSession(req.body);
  if (error) {
    return fail(res, 400, error.code, `${error.field} 필드가 올바르지 않습니다.`, error.field);
  }

  const { anonymousId, sessionId, startTime, endTime, videoCount, categoryDistribution, entropy, totalMs, youtubeMs, geminiMs, llmStatus, failureReason, httpStatus, timedOut } = req.body;

  try {
    insertSession.run({
      anonymousId,
      sessionId,
      startTime,
      endTime,
      videoCount: videoCount ?? null,
      categoryDistribution: categoryDistribution != null ? JSON.stringify(categoryDistribution) : null,
      entropy: entropy ?? null,
      totalMs: totalMs ?? null,
      youtubeMs: youtubeMs ?? null,
      geminiMs: geminiMs ?? null,
      llmStatus: llmStatus ?? null,
      failureReason: failureReason ?? null,
      httpStatus: httpStatus ?? null,
      timedOut: timedOut ?? null,
    });
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return fail(res, 409, ERROR_CODES.DUPLICATE_SESSION, "이미 존재하는 세션입니다.", sessionId);
    }
    return next(err);
  }

  return success(res);
});

module.exports = router;
