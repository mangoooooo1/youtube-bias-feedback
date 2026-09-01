const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");
const { upsertTodayReview } = require("./today-reviews-upsert");
const { validateTodayReview } = require("./today-reviews-validate");
const { getTodayReviews } = require("./today-reviews-query");

const router = express.Router();

// "오늘 하루 돌아보기" 탭이 로컬 캐시가 없거나(스토리지 clear, 재설치 등) 오래됐을 때
// 다시 받아오는 조회 경로 — period-reviews와 동일하게 자격 없으면 빈 배열을 반환한다.
router.get("/", (req, res) => {
  const anonymousId = (req.query.anonymousId || "").toString().trim();
  if (!anonymousId) {
    return fail(
      res,
      400,
      ERROR_CODES.MISSING_REQUIRED_FIELD,
      "anonymousId 파라미터가 필요합니다.",
      "anonymousId",
    );
  }

  return success(res, getTodayReviews(db, anonymousId));
});

// 오늘 누적 리뷰 최신본 upsert. (anonymousId, reviewDate) 1행만 유지되며,
// 재호출 시 upsertTodayReview가 기존 행을 덮어쓴다.
router.post("/", (req, res, next) => {
  const error = validateTodayReview(req.body);
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
    upsertTodayReview(db, req.body);
  } catch (err) {
    return next(err);
  }

  return success(res);
});

module.exports = router;
