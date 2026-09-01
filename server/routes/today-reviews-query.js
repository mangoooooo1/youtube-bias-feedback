// today_reviews 조회 로직
// "오늘 하루 돌아보기" 탭이 로컬 캐시가 없거나 오래됐을 때 다시 받아오는 경로
// 실험군은 베이스라인 기간(설치 후 BASELINE_DAYS 미만) 여부, 대조군은 "연구종료 코드 검증을 통과했는가"로 판정한다.
const { BASELINE_DAYS } = require("../pipeline/study-constants");

const FEEDBACK_GROUPS = new Set(["EXP", "TEST-EXP"]);
const CONTROL_GROUPS = new Set(["CON", "TEST-CON"]);

// background.js/viewlens-data.js의 isTestGroup과 동일 규칙(모듈 경계로 인한 중복,
// server/test/routes/today-reviews-query.test.js가 동치성을 검증한다).
function isTestGroup(group) {
  return typeof group === "string" && group.startsWith("TEST");
}

// extension/pipeline/baseline.js의 isBaselinePeriod와 동일 규칙(위와 같은 이유의 중복).
function isBaselinePeriod(installDate, now = new Date()) {
  if (!installDate) return true;
  const elapsedDays =
    (now.getTime() - new Date(installDate).getTime()) / 86400000;
  return elapsedDays < BASELINE_DAYS;
}

/** 이 참여자가 지금 "오늘" 리뷰를 열람할 자격이 있는지 판정한다. */
function isTodayReviewEligible(participant, now = new Date()) {
  if (!participant) return false;
  if (FEEDBACK_GROUPS.has(participant.group_code)) {
    return (
      isTestGroup(participant.group_code) ||
      !isBaselinePeriod(participant.installDate, now)
    );
  }
  if (CONTROL_GROUPS.has(participant.group_code)) {
    return !!participant.studyEndCodeVerifiedAt;
  }
  return false;
}

const SELECT_COLUMNS = `
  reviewDate, sessionCount, videoCount, categoryDistribution, entropy,
  review, reviewTopic, source, promptVersion, generatedAt
`;

/** anonymousId의 "오늘 누적 리뷰" 전체 이력을 reviewDate 오름차순으로 반환한다. 자격 없으면 빈 배열. */
function getTodayReviews(db, anonymousId, now = new Date()) {
  const participant = db
    .prepare(
      "SELECT group_code, installDate, studyEndCodeVerifiedAt FROM participants WHERE anonymousId = ?",
    )
    .get(anonymousId);

  if (!isTodayReviewEligible(participant, now)) {
    return [];
  }

  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM today_reviews
       WHERE anonymousId = ? ORDER BY reviewDate ASC`,
    )
    .all(anonymousId);
}

module.exports = {
  getTodayReviews,
  isTodayReviewEligible,
  FEEDBACK_GROUPS,
  CONTROL_GROUPS,
};
