// period_reviews 조회 로직
//
// 실제 암호화 DB 연결에 의존하지 않고 db 인스턴스를 인자로 받는 형태로 분리

const FEEDBACK_GROUPS = new Set(["EXP", "TEST-EXP"]);

const SELECT_COLUMNS = `
  periodIndex, periodStart, periodEnd, isBaseline, sessionCount, videoCount,
  categoryDistribution, entropy, review, reviewTopic, source, promptVersion, generatedAt
`;

/** anonymousId의 완료된 기간 리뷰를 periodIndex 오름차순으로 반환한다. 대조군/미등록 참여자는 빈 배열. */
function getPeriodReviews(db, anonymousId) {
  const participant = db
    .prepare("SELECT group_code FROM participants WHERE anonymousId = ?")
    .get(anonymousId);
  if (!participant || !FEEDBACK_GROUPS.has(participant.group_code)) {
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

module.exports = { getPeriodReviews };
