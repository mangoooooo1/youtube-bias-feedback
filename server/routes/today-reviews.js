const express = require("express");
const { db } = require("../db");
const { success, fail } = require("../middleware/responseHandler");
const { upsertTodayReview } = require("./today-reviews-upsert");
const { validateTodayReview } = require("./today-reviews-validate");

const router = express.Router();

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
