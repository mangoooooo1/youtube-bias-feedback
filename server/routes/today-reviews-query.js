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

// extension/study-schedule.js의 isBaselinePeriod와 동일 규칙(위와 같은 이유의 중복).
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

// entropy(다양성 점수)는 분석 결과 변수라 참여자 응답에 넣지 않는다
const SELECT_COLUMNS = `
  reviewDate, sessionCount, videoCount, categoryDistribution,
  review, reviewTopic, source, promptVersion, generatedAt
`;

/**
 * 날짜별로 그 리뷰를 받은 세션을 찾는다. 같은 날(서버 기록 시각, KST) 리뷰 문장이 같은 마지막 세션.
 * 폴백 문장은 날마다 같을 수 있어 날짜까지 맞춘다.
 * @returns {Map<string, {sessionId: string, feedbackConfirmedAt: string|null}>} "날짜\n문장" → 세션
 */
function reviewSessionsByDate(db, anonymousId) {
  const rows = db
    .prepare(
      `SELECT sessionId, review, feedbackConfirmedAt, date(createdAt, '+9 hours') AS kstDate
       FROM sessions WHERE anonymousId = ? AND review IS NOT NULL ORDER BY id ASC`,
    )
    .all(anonymousId);
  return new Map(rows.map((s) => [`${s.kstDate}\n${s.review}`, s]));
}

/**
 * anonymousId의 "오늘 누적 리뷰" 전체 이력을 reviewDate 오름차순으로 반환한다. 자격 없으면 빈 배열.
 * 재설치로 기기에 세션이 없어도 블러를 판정할 수 있게, 그 리뷰를 받은 세션 id와 확인 여부를 함께 싣는다.
 */
function getTodayReviews(db, anonymousId, now = new Date()) {
  const participant = db
    .prepare(
      "SELECT group_code, installDate, studyEndCodeVerifiedAt FROM participants WHERE anonymousId = ?",
    )
    .get(anonymousId);

  if (!isTodayReviewEligible(participant, now)) {
    return [];
  }

  const reviews = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM today_reviews
       WHERE anonymousId = ? ORDER BY reviewDate ASC`,
    )
    .all(anonymousId);
  const sessions = reviewSessionsByDate(db, anonymousId);
  return reviews.map((r) => {
    const s = sessions.get(`${r.reviewDate}\n${r.review}`);
    return {
      ...r,
      reviewSessionId: s?.sessionId ?? null,
      reviewConfirmed: !!s?.feedbackConfirmedAt,
    };
  });
}

module.exports = {
  getTodayReviews,
  isTodayReviewEligible,
  FEEDBACK_GROUPS,
  CONTROL_GROUPS,
};
