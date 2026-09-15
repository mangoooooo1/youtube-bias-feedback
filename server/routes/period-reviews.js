const express = require("express");
const { db } = require("../db");
const { success } = require("../middleware/responseHandler");
const { getPeriodReviews } = require("./period-reviews-query");
const { requireParticipant } = require("../middleware/requireParticipant");

const router = express.Router();

// requireParticipant가 anonymousId 존재·형식과(토큰 활성화 시) 소유권까지 확인한다.
// 이게 없으면 다른 참여자의 anonymousId를 아는 것만으로 그 사람의 실제 리뷰 텍스트를
// 조회할 수 있는 IDOR이 된다(코드리뷰 지적).
// requireParticipant가 req.body.anonymousId를 이미 정규화해둔다.
router.post("/", requireParticipant, (req, res) => {
  return success(res, getPeriodReviews(db, req.body.anonymousId));
});

module.exports = router;
