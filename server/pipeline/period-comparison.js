// 기간 리뷰의 비교·흐름 입력 계산
//
// 코드가 숫자를 계산하고 Gemini는 그 숫자로 문장만 쓴다.
// 비중은 화면·H2와 같은 시청 시간 기준이고, 변화(%p)는 반올림한 정수 퍼센트끼리 뺀다.
// 프롬프트에 보이는 숫자와 변화 폭이 정확히 맞아야 응답 검증(넘겨준 숫자만 썼는지)이 성립하기 때문이다.
// 저장값이 아니라 원본 영상 기록에서 매번 계산한다(늦게 들어온 시청 시간·카테고리도 화면과 같게 반영).
const {
  aggregateViewing,
  aggregateViewingByDay,
} = require("./viewing-aggregate");
const { groupTitlesByCategory } = require("./review-titles");
const { kstDateStr } = require("./period-boundaries");
const {
  MIN_VALID_VIDEOS_PER_DAY,
  minValidVideosForPeriod,
  maxTitlesForPeriod,
} = require("./study-constants");

// 직전 0% → 이번 이 값 이상이면 "새로 본 분야", 반대면 "보지 않은 분야"
const NEW_CATEGORY_MIN_PERCENT = 5;
// 평소 변화 폭은 이전 구간끼리의 비교가 이만큼 있어야 쓴다
const MIN_PAIRS_FOR_USUAL_CHANGE = 2;

/** 날짜 범위 안의 모든 날짜(YYYY-MM-DD, KST) */
function datesBetween(start, end) {
  const dates = [];
  const startMs = Date.parse(`${start}T00:00:00+09:00`);
  for (let i = 0; ; i++) {
    const date = kstDateStr(new Date(startMs + i * 86400000));
    if (date > end) break;
    dates.push(date);
  }
  return dates;
}

/** 분포 → 정수 퍼센트 [{ category, percent }] (비중 큰 순, 0%는 제외) */
function percentShares(distribution) {
  return Object.entries(distribution ?? {})
    .map(([category, ratio]) => ({
      category,
      percent: Math.round(ratio * 100),
    }))
    .filter((s) => s.percent > 0)
    .sort((a, b) => b.percent - a.percent);
}

/** 두 구간의 분야별 변화(%p). 변화 없는 분야는 빼고 크기 순 */
function changesBetween(previousShares, currentShares) {
  const prev = new Map(previousShares.map((s) => [s.category, s.percent]));
  const cur = new Map(currentShares.map((s) => [s.category, s.percent]));
  return [...new Set([...prev.keys(), ...cur.keys()])]
    .map((category) => {
      const from = prev.get(category) ?? 0;
      const to = cur.get(category) ?? 0;
      return { category, from, to, delta: to - from };
    })
    .filter((c) => c.delta !== 0)
    .sort(
      (a, b) =>
        Math.abs(b.delta) - Math.abs(a.delta) ||
        a.category.localeCompare(b.category),
    );
}

function periodDays({ periodStart, periodEnd }) {
  return datesBetween(periodStart, periodEnd).length;
}

function summarizePeriod(period) {
  const aggregate = aggregateViewing(period.entries);
  return {
    periodIndex: period.periodIndex,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    validVideoCount: aggregate.validCount,
    isFew: aggregate.validCount < minValidVideosForPeriod(periodDays(period)),
    shares: percentShares(aggregate.timeDistribution),
  };
}

/**
 * @param {Array<{periodIndex: number, periodStart: string, periodEnd: string, entries: Array}>} periods
 *   1구간부터 이번 구간까지 오름차순(마지막이 이번 구간). entries는 영상 기록
 *   { title, watchedAt, categoryId, durationSeconds, watchedSeconds }
 * @returns {{
 *   previousPeriods: Array, changeFromPrevious: object|null, usualChange: object|null,
 *   dailyShares: Array, previousTitleGroups: Array|null
 * }}
 */
function buildPeriodComparison(periods) {
  const current = periods[periods.length - 1];
  const previous = periods.slice(0, -1);
  const previousPeriods = previous.map(summarizePeriod);
  const currentSummary = summarizePeriod(current);

  // 직전 구간 대비 변화
  const last = previousPeriods[previousPeriods.length - 1];
  let changeFromPrevious = null;
  if (last) {
    const changes = changesBetween(last.shares, currentSummary.shares);
    changeFromPrevious = {
      previousPeriodIndex: last.periodIndex,
      changes,
      largest: changes[0] ?? null,
      newCategories: changes
        .filter((c) => c.from === 0 && c.to >= NEW_CATEGORY_MIN_PERCENT)
        .map((c) => c.category),
      droppedCategories: changes
        .filter((c) => c.to === 0 && c.from >= NEW_CATEGORY_MIN_PERCENT)
        .map((c) => c.category),
    };
  }

  // 평소 변화 폭: 이전 구간끼리 연속한 쌍마다 "가장 크게 달라진 분야의 %p"의 평균
  const pairDeltas = previousPeriods.slice(1).map((p, i) => {
    const largest = changesBetween(previousPeriods[i].shares, p.shares)[0];
    return largest ? Math.abs(largest.delta) : 0;
  });
  const usualChange =
    pairDeltas.length >= MIN_PAIRS_FOR_USUAL_CHANGE
      ? {
          pairCount: pairDeltas.length,
          averageLargestDelta: Math.round(
            pairDeltas.reduce((sum, d) => sum + d, 0) / pairDeltas.length,
          ),
        }
      : null;

  // 구간 안의 날짜별 비중(화면 꺾은선과 같은 숫자). 기록 없는 날도 넣는다
  const byDate = new Map(
    aggregateViewingByDay(current.entries).map((d) => [d.date, d]),
  );
  const dailyShares = datesBetween(current.periodStart, current.periodEnd).map(
    (date) => {
      const day = byDate.get(date);
      const validVideoCount = day?.validCount ?? 0;
      return {
        date,
        validVideoCount,
        noRecord: validVideoCount === 0,
        isFew:
          validVideoCount > 0 && validVideoCount < MIN_VALID_VIDEOS_PER_DAY,
        shares: percentShares(day?.timeDistribution),
      };
    },
  );

  // 같은 분야 안에서 소재가 바뀐 것을 짚을 수 있게 직전 구간 제목도 넘긴다(직전 하나만)
  const previousPeriod = previous[previous.length - 1];
  const previousTitleGroups = previousPeriod
    ? groupTitlesByCategory(previousPeriod.entries, {
        maxTitles: maxTitlesForPeriod(periodDays(previousPeriod)),
      })
    : null;

  return {
    previousPeriods,
    changeFromPrevious,
    usualChange,
    dailyShares,
    previousTitleGroups,
  };
}

module.exports = {
  buildPeriodComparison,
  NEW_CATEGORY_MIN_PERCENT,
  MIN_PAIRS_FOR_USUAL_CHANGE,
};
