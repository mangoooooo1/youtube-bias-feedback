const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");

const router = express.Router();

const insertSession = db.prepare(`
  INSERT INTO sessions (anonymousId, sessionId, startTime, endTime, videoCount, categoryDistribution, entropy, totalMs, youtubeMs, geminiMs)
  VALUES (@anonymousId, @sessionId, @startTime, @endTime, @videoCount, @categoryDistribution, @entropy, @totalMs, @youtubeMs, @geminiMs)
`);

// 10-3 지연시간 필드 — 확장이 측정해 전송. 선택 항목이며, 있으면 음수 아닌 정수여야 한다.
const LATENCY_FIELDS = ["totalMs", "youtubeMs", "geminiMs"];

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

  return null;
}

router.post("/", (req, res, next) => {
  const error = validateSession(req.body);
  if (error) {
    return fail(res, 400, error.code, `${error.field} 필드가 올바르지 않습니다.`, error.field);
  }

  const { anonymousId, sessionId, startTime, endTime, videoCount, categoryDistribution, entropy, totalMs, youtubeMs, geminiMs } = req.body;

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
