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

// entryPath를 저장해도 되는 referrerType 화이트리스트. 외부 사이트 경로(external)뿐 아니라,
// 채널(/@handle, /channel/UCxxx) 등 식별 정보를 담을 수 있는 유튜브 내부 경로도 4분류 밖이라
// unknown으로 떨어지므로 함께 걸러진다 — "unknown이면 안전하다고 확인되지 않은 것"으로 취급.
const SAFE_ENTRY_PATH_REFERRER_TYPES = new Set([
  "direct_search",
  "home_feed",
  "related",
]);

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

  const storedEntryPath = SAFE_ENTRY_PATH_REFERRER_TYPES.has(referrerType)
    ? (entryPath ?? null)
    : null;

  try {
    insertEvent.run({
      eventId: eventId ?? null,
      anonymousId,
      videoId,
      title: title ?? null,
      watchedAt,
      sessionId: sessionId ?? null,
      entryHost: entryHost ?? null,
      entryPath: storedEntryPath,
      referrerType,
      relatedTrigger,
    });
  } catch (err) {
    return next(err);
  }

  return success(res);
});

module.exports = router;
