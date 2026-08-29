const express = require("express");
const { db } = require("../db");
const { success, fail } = require("../middleware/responseHandler");
const { validateVideoEvent } = require("./video-events-validate");

const router = express.Router();

const insertEvent = db.prepare(`
  INSERT INTO video_events (anonymousId, videoId, title, watchedAt, sessionId)
  VALUES (@anonymousId, @videoId, @title, @watchedAt, @sessionId)
`);

router.post("/", (req, res, next) => {
  const error = validateVideoEvent(req.body);
  if (error) {
    return fail(
      res,
      400,
      error.code,
      `${error.field} 필드가 올바르지 않습니다.`,
      error.field,
    );
  }

  const { anonymousId, videoId, watchedAt, title, sessionId } = req.body;

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
