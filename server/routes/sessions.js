const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");
const { validateSession } = require("./sessions-validate");
const { insertSession, recordFeedbackTimestamp } = require("./sessions-store");
const { generateAndStoreTodayReview } = require("./today-review-generate");
const { isTodayReviewEligible } = require("./today-reviews-query");

const router = express.Router();

router.post("/", async (req, res, next) => {
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

  try {
    insertSession(db, req.body);
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return fail(
        res,
        409,
        ERROR_CODES.DUPLICATE_SESSION,
        "이미 존재하는 세션입니다.",
        req.body.sessionId,
      );
    }
    return next(err);
  }

  // "오늘" 누적 리뷰는 그룹·자격과 무관하게 항상 다시 계산해 저장하고, 지금 이 요청자가 볼 자격이 있을 때만 응답에 싣는다.
  let todayReview = null;
  try {
    const anonymousId = req.body.anonymousId;
    const generated = await generateAndStoreTodayReview(db, {
      anonymousId,
      apiKey: process.env.TODAY_REVIEW_GEMINI_API_KEY,
    });
    if (generated) {
      const participant = db
        .prepare(
          "SELECT group_code, installDate, studyEndCodeVerifiedAt FROM participants WHERE anonymousId = ?",
        )
        .get(anonymousId);
      if (isTodayReviewEligible(participant)) {
        todayReview = generated;
      }
    }
  } catch (err) {
    console.error("[sessions] 오늘 리뷰 생성 오류:", err.message);
  }

  return success(res, { todayReview });
});

// 피드백 열람/확인 시각 갱신 — 세션 생성 POST와 별도 시점에(알림 클릭, 확인 버튼 클릭 등)
// 호출된다. anonymousId로 소유권을 확인해 다른 참여자의 세션을 갱신하지 못하도록 막는다.
// column은 요청 값이 아니라 아래 두 router.patch 호출부에서만 하드코딩으로 주어지므로
// SQL 인젝션 경로가 없다(server/db.js의 addColumn(table, name, type) 패턴과 동일한 근거).
function makeFeedbackTimestampHandler(column) {
  return (req, res, next) => {
    const { sessionId } = req.params;
    // req.body가 null/undefined일 수 있어(본문 없는 요청) 구조 분해 대신 옵셔널 체이닝으로
    // 접근한다 — 구조 분해였다면 여기서 예외가 던져져 아래 400 검증을 건너뛰고 500으로 샜다.
    const anonymousId = req.body?.anonymousId;

    if (typeof anonymousId !== "string" || !anonymousId.trim()) {
      return fail(
        res,
        400,
        ERROR_CODES.MISSING_REQUIRED_FIELD,
        "anonymousId 필드가 올바르지 않습니다.",
        "anonymousId",
      );
    }

    let result;
    try {
      result = recordFeedbackTimestamp(db, column, sessionId, anonymousId);
    } catch (err) {
      return next(err);
    }

    if (result === "not_found") {
      return fail(
        res,
        404,
        ERROR_CODES.NOT_FOUND,
        "세션을 찾을 수 없습니다.",
        sessionId,
      );
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
