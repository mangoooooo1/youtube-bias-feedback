const express = require("express");
const { db } = require("../db");
const { success, fail } = require("../middleware/responseHandler");
const { validatePopupEvent } = require("./popup-events-validate");
const { requireParticipant } = require("../middleware/requireParticipant");

const router = express.Router();

// 팝업 상호작용 마이크로 로그
// 세션과 무관, 확장이 팝업 종료 시점 스냅샷을 전송
// OR IGNORE: eventId(멱등 키) 중복 시 조용히 건너뜀 → 재전송돼도 한 행만 남는다.
// eventId가 없는 구버전 확장 요청은 NULL로 저장되어 dedup만 생략된다(하위호환).
const insertPopupEvent = db.prepare(`
  INSERT OR IGNORE INTO popup_events (eventId, anonymousId, dwellMs, tabTodayClicks, tabWeekClicks, todayFeedbackViewed, periodFeedbackViewed, openedAt)
  VALUES (@eventId, @anonymousId, @dwellMs, @tabTodayClicks, @tabWeekClicks, @todayFeedbackViewed, @periodFeedbackViewed, @openedAt)
`);

// 클라이언트의 pendingPopupEvents 큐가 실패한 항목을 그대로 남겨 다음 팝업 open 때
// 재전송하므로, requireParticipant가 이 요청을 거부해도 유실되지 않는다.
router.post("/", requireParticipant, (req, res, next) => {
  const error = validatePopupEvent(req.body);
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
    eventId,
    anonymousId,
    dwellMs,
    tabTodayClicks,
    tabWeekClicks,
    todayFeedbackViewed,
    periodFeedbackViewed,
    openedAt,
  } = req.body;

  try {
    insertPopupEvent.run({
      eventId: eventId ?? null,
      anonymousId,
      dwellMs: dwellMs ?? null,
      tabTodayClicks: tabTodayClicks ?? null,
      tabWeekClicks: tabWeekClicks ?? null,
      todayFeedbackViewed: todayFeedbackViewed ?? null,
      periodFeedbackViewed: periodFeedbackViewed ?? null,
      openedAt: openedAt ?? null,
    });
  } catch (err) {
    return next(err);
  }

  return success(res);
});

module.exports = router;
