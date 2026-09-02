const express = require("express");
const { db } = require("../db");
const { success, fail } = require("../middleware/responseHandler");
const { validateVideoEvent } = require("./video-events-validate");
const { classifyReferrerType } = require("./video-events-classify");

const router = express.Router();

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO video_events
    (eventId, anonymousId, videoId, title, watchedAt, sessionId, entryHost, entryPath, referrerType, relatedTrigger)
  VALUES
    (@eventId, @anonymousId, @videoId, @title, @watchedAt, @sessionId, @entryHost, @entryPath, @referrerType, @relatedTrigger)
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

  const {
    anonymousId,
    videoId,
    watchedAt,
    title,
    sessionId,
    eventId,
    entryHost,
    entryPath,
    navigationTrigger,
  } = req.body;

  // referrerType/relatedTrigger는 요청 body로 직접 받지 않고,
  // 원시 신호로부터 서버가 매번 다시 계산한다.
  const { referrerType, relatedTrigger } = classifyReferrerType(
    entryHost ?? null,
    entryPath ?? null,
    navigationTrigger ?? null,
  );

  try {
    insertEvent.run({
      eventId: eventId ?? null,
      anonymousId,
      videoId,
      title: title ?? null,
      watchedAt,
      sessionId: sessionId ?? null,
      entryHost: entryHost ?? null,
      entryPath: entryPath ?? null,
      referrerType,
      relatedTrigger,
    });
  } catch (err) {
    return next(err);
  }

  return success(res);
});

module.exports = router;
