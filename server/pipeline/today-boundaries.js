// "오늘" 탭 누적 리뷰의 근거 데이터 집계
//
// 세션 분포를 병합하지 않고, 오늘 본 영상 기록에서 직접 계산한다.
// 세션을 영상 수로 병합하면 유효 영상 비율이 다른 세션끼리 가중치가 틀어지고
// (예: 50/50이어야 할 분포가 83/17), 세션이 끝난 시각으로 날짜를 정하면 자정을 넘긴 세션의
// 영상이 엉뚱한 날로 간다. 그래서 "오늘"은 영상을 본 시각(watchedAt) 기준이다.
//
// [의도적인 차이 — 참여자의 실제 "오늘"과 이 함수가 계산하는 "오늘"이 다를 수 있음]
// 서버는 참여자 브라우저의 시간대를 알 방법이 없으므로(전달받은 적이 없음), 서버의 다른 모든
// 기간 계산(period-boundaries.js의 kstDateStr, 화면 표시용 dateStr)과 동일하게 KST(Asia/Seoul)
// 고정 기준을 쓴다. 참여자 대부분이 KST권이라 실제 영향은 거의 없을 것으로 보인다.
const { kstDateStr } = require("./period-boundaries");
const { aggregateViewing } = require("./viewing-aggregate");
const { groupTitlesByCategory } = require("./review-titles");

/** 본 시각을 KST 날짜로 바꾼다. 파싱할 수 없으면 null. */
function viewedDate(event) {
  const ms = Date.parse(event.watchedAt);
  return Number.isFinite(ms) ? kstDateStr(new Date(ms)) : null;
}

/**
 * @param {object} params
 * @param {Array}  params.events - 영상 기록(video_events + video_metadata), watchedAt 오름차순
 *   [{ eventId, sessionId, title, watchedAt, watchedSeconds, categoryId, durationSeconds }]
 * @param {Date}   [params.now] - 기준 시각(테스트용 주입, 기본값 현재 시각)
 * @returns {object|null} 오늘 유효 시청 영상이 하나도 없으면 null
 */
function aggregateTodayCumulative({ events, now = new Date() }) {
  const today = kstDateStr(now);
  const dated = events
    .map((e) => ({ ...e, date: viewedDate(e) }))
    .filter((e) => e.date !== null);

  const todayEvents = dated.filter((e) => e.date === today);
  const aggregate = aggregateViewing(todayEvents);
  if (aggregate.validCount === 0) return null;

  // 직전 시청일 = 오늘보다 앞선 날짜 중 유효 시청이 있는 가장 최근 날.
  // "<"로 비교해 단말 시계 오류로 미래 날짜가 찍힌 기록은 제외한다.
  const priorDates = [...new Set(dated.map((e) => e.date))]
    .filter((d) => d < today)
    .sort()
    .reverse();
  let prevEntropy = null;
  for (const date of priorDates) {
    const prev = aggregateViewing(dated.filter((e) => e.date === date));
    if (prev.validCount > 0) {
      prevEntropy = prev.entropy;
      break;
    }
  }

  const sessionIds = [
    ...new Set(todayEvents.map((e) => e.sessionId).filter(Boolean)),
  ];

  return {
    reviewDate: today,
    categoryDistribution: aggregate.analysisDistribution,
    entropy: aggregate.entropy,
    prevEntropy,
    videoCount: todayEvents.length,
    validVideoCount: aggregate.validCount,
    videoTitles: todayEvents.map((e) => e.title).filter(Boolean),
    sessionCount: sessionIds.length,
    sessionIds,
    timeDistribution: aggregate.timeDistribution,
    countDistribution: aggregate.countDistribution,
    chartCount: aggregate.chartCount,
    titleGroups: groupTitlesByCategory(todayEvents),
  };
}

module.exports = { aggregateTodayCumulative };
