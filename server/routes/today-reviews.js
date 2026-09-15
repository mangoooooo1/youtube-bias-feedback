const express = require("express");
const { db } = require("../db");
const { success } = require("../middleware/responseHandler");
const { getTodayReviews } = require("./today-reviews-query");
const { requireParticipant } = require("../middleware/requireParticipant");

const router = express.Router();

// "오늘 하루 돌아보기" 탭이 로컬 캐시가 없거나(스토리지 clear, 재설치 등) 오래됐을 때
// 다시 받아오는 조회 경로 — period-reviews와 동일하게 자격 없으면 빈 배열을 반환한다.
// requireParticipant로 소유권도 확인한다(period-reviews.js와 동일한 이유, IDOR 지적).

router.post("/", requireParticipant, (req, res) => {
  const anonymousId = req.body.anonymousId.toString().trim();
  return success(res, getTodayReviews(db, anonymousId));
});

module.exports = router;
