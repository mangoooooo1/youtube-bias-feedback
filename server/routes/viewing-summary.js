const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");
const { getViewingSummary, getDayVideos } = require("./viewing-summary-query");
const { requireParticipant } = require("../middleware/requireParticipant");

const router = express.Router();

// 팝업의 오늘·기간별 그래프가 쓰는 시청 집계 조회 경로.
// today-reviews와 같은 자격 규칙을 쓰고, 자격이 없으면 빈 배열을 반환한다.
// requireParticipant로 소유권을 확인한다(다른 참여자의 시청 기록 조회 방지).
router.post("/", requireParticipant, (req, res) => {
  return success(res, getViewingSummary(db, req.body.anonymousId));
});

/** 실제로 있는 날짜의 "YYYY-MM-DD"인지 */
function isDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value
  );
}

// 날짜 하나에 재생한 영상 목록. 인증·자격은 시청 집계와 같다.
router.post("/videos", requireParticipant, (req, res) => {
  const { date } = req.body;
  if (!isDateKey(date)) {
    return fail(
      res,
      400,
      ERROR_CODES.INVALID_FIELD_VALUE,
      "date 필드가 올바르지 않습니다.",
      "date",
    );
  }
  return success(res, getDayVideos(db, req.body.anonymousId, date));
});

module.exports = router;
