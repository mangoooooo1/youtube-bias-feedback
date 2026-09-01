const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");
const { getTodayReviews } = require("./today-reviews-query");

const router = express.Router();

// "오늘 하루 돌아보기" 탭이 로컬 캐시가 없거나(스토리지 clear, 재설치 등) 오래됐을 때
// 다시 받아오는 조회 경로 — period-reviews와 동일하게 자격 없으면 빈 배열을 반환한다.
//
// POST /api/today-reviews는 제거했다

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

module.exports = router;
