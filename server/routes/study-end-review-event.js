// 대조군 종료 안내 모달 노출 / 6주 누적 리뷰 열람 이벤트 기록

const EVENT_COLUMNS = {
  modal_shown: "studyEndModalShownAt",
  review_viewed: "studyEndReviewViewedAt",
};

/**
 * anonymousId의 event(모달 노출/리뷰 열람)를 최초 1회만 기록한다 — 이미 값이 있으면
 * 덮어쓰지 않는다("처음 본 시각"이라는 연구 측정 의미를 재호출로부터 보존).
 */
function recordStudyEndReviewEvent(db, anonymousId, event) {
  const column = EVENT_COLUMNS[event];
  db.prepare(
    `UPDATE participants SET ${column} = COALESCE(${column}, ?) WHERE anonymousId = ?`,
  ).run(new Date().toISOString(), anonymousId);
}

module.exports = { recordStudyEndReviewEvent, EVENT_COLUMNS };
