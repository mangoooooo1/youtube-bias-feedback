// period_reviews 조회 로직
//
// 실제 암호화 DB 연결에 의존하지 않고 db 인스턴스를 인자로 받는 형태로 분리

const { TOTAL_DAYS, DAYS_PER_PERIOD } = require("../pipeline/study-constants");

const FEEDBACK_GROUPS = new Set(["EXP", "TEST-EXP"]);
// 대조군(CON, TEST-CON) — 개입 기간 중에는 계속 차단하되, 연구 종료 + 전체 기간 리뷰 생성
const CONTROL_GROUPS = new Set(["CON", "TEST-CON"]);
const TOTAL_PERIODS = Math.ceil(TOTAL_DAYS / DAYS_PER_PERIOD);

const SELECT_COLUMNS = `
  periodIndex, periodStart, periodEnd, isBaseline, sessionCount, videoCount,
  categoryDistribution, entropy, review, reviewTopic, source, promptVersion, generatedAt
`;

/** installDate로부터 TOTAL_DAYS가 지났으면 연구 관찰 기간이 종료된 것으로 본다. */
function isStudyEnded(installDate, now = new Date()) {
  const endMs = new Date(installDate).getTime() + TOTAL_DAYS * 86400000;
  return now.getTime() >= endMs;
}

/** 대조군에게 기간 리뷰 열람을 허용할지 판단한다 */
function isStudyEndUnlocked(db, anonymousId, installDate) {
  if (!isStudyEnded(installDate)) return false;
  const { count } = db
    .prepare(
      "SELECT COUNT(*) AS count FROM period_reviews WHERE anonymousId = ?",
    )
    .get(anonymousId);
  return count >= TOTAL_PERIODS;
}

/** anonymousId의 완료된 기간 리뷰를 periodIndex 오름차순으로 반환한다. 대상이 아니면 빈 배열. */
function getPeriodReviews(db, anonymousId) {
  const participant = db
    .prepare(
      "SELECT group_code, installDate FROM participants WHERE anonymousId = ?",
    )
    .get(anonymousId);
  if (!participant) {
    return [];
  }

  const allowed =
    FEEDBACK_GROUPS.has(participant.group_code) ||
    (CONTROL_GROUPS.has(participant.group_code) &&
      isStudyEndUnlocked(db, anonymousId, participant.installDate));
  if (!allowed) {
    return [];
  }

  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM period_reviews WHERE anonymousId = ? ORDER BY periodIndex ASC`,
    )
    .all(anonymousId);

  // categoryDistribution은 sessions 테이블과 동일하게 JSON 문자열 그대로 반환
  return rows.map((row) => ({ ...row, isBaseline: !!row.isBaseline }));
}

module.exports = {
  getPeriodReviews,
  isStudyEndUnlocked,
  isStudyEnded,
  CONTROL_GROUPS,
};
