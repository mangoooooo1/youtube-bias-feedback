// 대조군 종료 안내 모달 노출 / 6주 누적 리뷰 열람 이벤트 기록 (Story 10-10)
//
// 실제 DB 연결에 의존하지 않고 db 인스턴스를 인자로 받는 형태로 분리

const {
  isStudyEndUnlocked,
  CONTROL_GROUPS,
} = require("./period-reviews-query");

const EVENT_COLUMNS = {
  modal_shown: "studyEndModalShownAt",
  review_viewed: "studyEndReviewViewedAt",
};

/**
 * anonymousId의 event(모달 노출/리뷰 열람)를 기록한다
 *
 * @returns {"recorded"|"not_found"|"not_eligible"}
 */
function recordStudyEndReviewEvent(db, anonymousId, event) {
  const participant = db
    .prepare(
      "SELECT group_code, installDate FROM participants WHERE anonymousId = ?",
    )
    .get(anonymousId);
  if (!participant) {
    return "not_found";
  }
  if (
    !CONTROL_GROUPS.has(participant.group_code) ||
    !isStudyEndUnlocked(db, anonymousId, participant.installDate)
  ) {
    return "not_eligible";
  }

  const column = EVENT_COLUMNS[event];
  db.prepare(
    `UPDATE participants SET ${column} = COALESCE(${column}, ?) WHERE anonymousId = ?`,
  ).run(new Date().toISOString(), anonymousId);
  return "recorded";
}

module.exports = { recordStudyEndReviewEvent, EVENT_COLUMNS };
