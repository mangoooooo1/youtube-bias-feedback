const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");
const {
  validateVideoEvent,
  validateWatchStats,
} = require("./video-events-validate");
const { classifyReferrerType } = require("./video-events-classify");
const { requireParticipant } = require("../middleware/requireParticipant");

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

// background.js의 retryUnsentVideoEvents(1분 주기 알람)가 실패한 이벤트를 sent=false로
// 남겨 재시도하므로, requireParticipant가 이 요청을 거부해도(등록이 아직 반영 전 등)
// 유실되지 않는다.
router.post("/", requireParticipant, (req, res, next) => {
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

// 시청시간 원시 데이터 확정
// 확장이 이 영상을 "떠날 때"(다음 영상으로 전환, 또는 탭 종료 시 최선노력 전송)에야 알 수 있는 값이라
// POST 시점(시청 시작)과 분리된 별도 호출로 온다. sessions.js의 feedback-viewed/confirmed PATCH와 동일한
// 소유권 검증 패턴. eventId가 이 anonymousId의 것이 아니면 갱신하지 않는다.
router.patch("/:eventId", requireParticipant, (req, res, next) => {
  const error = validateWatchStats(req.body);
  if (error) {
    return fail(
      res,
      400,
      error.code,
      `${error.field} 필드가 올바르지 않습니다.`,
      error.field,
    );
  }

  const { eventId } = req.params;
  const { anonymousId, watchedSeconds, playbackRate, wasBackgrounded } =
    req.body;

  let result;
  try {
    result = db
      .prepare(
        `UPDATE video_events SET watchedSeconds = @watchedSeconds,
           playbackRate = @playbackRate, wasBackgrounded = @wasBackgrounded
         WHERE eventId = @eventId AND anonymousId = @anonymousId`,
      )
      .run({
        eventId,
        anonymousId,
        watchedSeconds: watchedSeconds ?? null,
        playbackRate: playbackRate ?? null,
        wasBackgrounded: wasBackgrounded === undefined ? null : wasBackgrounded,
      });
  } catch (err) {
    return next(err);
  }

  if (result.changes === 0) {
    return fail(
      res,
      404,
      ERROR_CODES.NOT_FOUND,
      "영상 이벤트를 찾을 수 없습니다.",
      eventId,
    );
  }

  return success(res);
});

module.exports = router;
