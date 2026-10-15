const express = require("express");
const { db } = require("../db");
const { success } = require("../middleware/responseHandler");
const { getViewingSummary } = require("./viewing-summary-query");
const { requireParticipant } = require("../middleware/requireParticipant");

const router = express.Router();

// 팝업의 오늘·기간별 그래프가 쓰는 시청 집계 조회 경로.
// today-reviews와 같은 자격 규칙을 쓰고, 자격이 없으면 빈 배열을 반환한다.
// requireParticipant로 소유권을 확인한다(다른 참여자의 시청 기록 조회 방지).
router.post("/", requireParticipant, (req, res) => {
  return success(res, getViewingSummary(db, req.body.anonymousId));
});

module.exports = router;
