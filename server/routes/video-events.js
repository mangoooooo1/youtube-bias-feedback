const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");

const router = express.Router();

const insertEvent = db.prepare(`
  INSERT INTO video_events (anonymousId, videoId, title, watchedAt, sessionId)
  VALUES (@anonymousId, @videoId, @title, @watchedAt, @sessionId)
`);

router.post("/", (req, res, next) => {
  const { anonymousId, videoId, watchedAt, title, sessionId } = req.body;

  for (const field of ["anonymousId", "videoId", "watchedAt"]) {
    const value = req.body[field];
    if (typeof value !== "string" || !value.trim()) {
      return fail(
        res,
        400,
        ERROR_CODES.MISSING_REQUIRED_FIELD,
        `${field} 필드가 올바르지 않습니다.`,
        field,
      );
    }
  }

  if (isNaN(Date.parse(watchedAt))) {
    return fail(
      res,
      400,
      ERROR_CODES.INVALID_FIELD_VALUE,
      "watchedAt 필드가 올바르지 않습니다.",
      "watchedAt",
    );
  }

  // sessions.sessionId와 마찬가지로 이 영상이 속한 세션을 가리키는 값 — 구버전 확장
  // 하위호환으로 미전송(null)은 허용하되, 보냈다면 빈 문자열은 거부한다.
  if (
    sessionId !== undefined &&
    sessionId !== null &&
    (typeof sessionId !== "string" || sessionId.trim() === "")
  ) {
    return fail(
      res,
      400,
      ERROR_CODES.INVALID_FIELD_VALUE,
      "sessionId 필드가 올바르지 않습니다.",
      "sessionId",
    );
  }

  try {
    insertEvent.run({
      anonymousId,
      videoId,
      title: title ?? null,
      watchedAt,
      sessionId: sessionId ?? null,
    });
  } catch (err) {
    return next(err);
  }

  return success(res);
});

module.exports = router;
