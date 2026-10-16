// 팝업 화면용 시청 집계 — 날짜별·구간별 카테고리 비중(시청 시간·영상 개수)과 그래프에서 뺀 영상
//
// 집계는 viewing-aggregate.js(유효 시청·영상 길이 상한·도넛 두 개 공통 대상)를 그대로 쓴다.
// 다양성 점수(entropy·weightedEntropy)는 H2 결과 변수라 응답에 넣지 않는다 — 참여자가 점수를
// 맞추려는 반응과 처치 효과가 섞이지 않게 하기 위함(화면 지표 선택 원칙 3, 사전등록 §1).
const {
  aggregateViewing,
  aggregateViewingByDay,
} = require("../pipeline/viewing-aggregate");
const { kstDateStr, dayFromInstall } = require("../pipeline/period-boundaries");
const { TOTAL_DAYS, DAYS_PER_PERIOD } = require("../pipeline/study-constants");
const { isTodayReviewEligible } = require("./today-reviews-query");

/** 화면에 필요한 값만 남긴다(분석용 값 제외). 시청 시간 합이 유한하지 않으면 null. */
function toScreenView(aggregate, { withExcluded }) {
  const view = {
    validCount: aggregate.validCount,
    // 시청 시간이 확인된 유효 영상, 분야 미확인 포함
    confirmedCount: aggregate.confirmedCount,
    // 유효 영상 중 시청 시간이 아직 오지 않은 영상(분야 유무 무관)
    unconfirmedCount: aggregate.validCount - aggregate.confirmedCount,
    shortCount: aggregate.shortCount,
    uncategorizedCount: aggregate.uncategorizedCount,
    pendingTimeCount: aggregate.pendingTimeCount,
    chartCount: aggregate.chartCount,
    chartSeconds: Number.isFinite(aggregate.chartSeconds)
      ? aggregate.chartSeconds
      : null,
    countDistribution: aggregate.countDistribution,
    timeDistribution: aggregate.timeDistribution,
  };
  // 영상별 제외 사유는 날짜별 "시청한 영상" 목록 표시에만 쓰여 구간에는 넣지 않는다
  if (withExcluded) view.excluded = aggregate.excluded;
  return view;
}

/** 설치일 기준으로 이미 시작된 구간 목록(오늘 진행 중인 구간 포함). */
function startedPeriods(installDate, today) {
  const totalPeriods = Math.ceil(TOTAL_DAYS / DAYS_PER_PERIOD);
  const periods = [];
  for (let p = 1; p <= totalPeriods; p++) {
    const start = dayFromInstall(installDate, (p - 1) * DAYS_PER_PERIOD);
    if (start > today) break;
    periods.push({
      periodIndex: p,
      start,
      end: dayFromInstall(installDate, p * DAYS_PER_PERIOD - 1),
    });
  }
  return periods;
}

/**
 * @returns {{days: Array, periods: Array}} 자격이 없으면 빈 배열들(today-reviews와 같은 규칙)
 */
function getViewingSummary(db, anonymousId, now = new Date()) {
  const participant = db
    .prepare(
      "SELECT group_code, installDate, studyEndCodeVerifiedAt FROM participants WHERE anonymousId = ?",
    )
    .get(anonymousId);
  if (!isTodayReviewEligible(participant, now)) {
    return { days: [], periods: [] };
  }

  const events = db
    .prepare(
      `SELECT e.eventId, e.watchedAt, e.watchedSeconds, m.categoryId, m.durationSeconds
       FROM video_events e
       LEFT JOIN video_metadata m ON m.videoId = e.videoId
       WHERE e.anonymousId = ?
       ORDER BY e.watchedAt ASC`,
    )
    .all(anonymousId);

  const days = aggregateViewingByDay(events).map(({ date, ...aggregate }) => ({
    date,
    ...toScreenView(aggregate, { withExcluded: true }),
  }));

  const today = kstDateStr(now);
  const periods = startedPeriods(participant.installDate, today).map((p) => {
    const inPeriod = events.filter((e) => {
      const ms = Date.parse(e.watchedAt);
      if (!Number.isFinite(ms)) return false;
      const date = kstDateStr(new Date(ms));
      return date >= p.start && date <= p.end;
    });
    return {
      ...p,
      ...toScreenView(aggregateViewing(inPeriod), { withExcluded: false }),
    };
  });

  return { days, periods };
}

module.exports = { getViewingSummary };
