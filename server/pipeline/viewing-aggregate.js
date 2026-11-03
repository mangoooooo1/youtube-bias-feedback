// 원본 영상 기록(video_events + video_metadata)을 유효 시청·시청 시간 기준으로 집계한다.
//
// 세션 단위로 이미 계산된 비율을 다시 합치지 않고 영상 기록에서 직접 계산한다.
// 세션 분포를 전체 영상 수로 병합하면 유효 영상 비율이 다른 세션끼리 가중치가 틀어진다
//
// 화면용 값과 분석용 값을 분리한다.
// - 화면(도넛 두 개): 시청 시간을 알고 + 카테고리가 있는 유효 영상만. 두 도넛이 같은 영상
//   묶음을 그려야 시청 시간·영상 개수 비교가 성립한다.
// - 분석(entropy·weightedEntropy): 시청 시간을 모르는 영상도 유효로 세고 (entropy), 시청 시간은 영상 길이로 상한을 둔다(weightedEntropy).
const {
  isValidWatch,
  calculateDistribution,
  calculateWeightedDistribution,
  calculateEntropy,
} = require("./category-diversity");
const { kstDateStr } = require("./period-boundaries");

const EXCLUDED_REASONS = {
  SHORT: "short", // 잠깐 봄
  UNCATEGORIZED: "uncategorized", // 유효 시청이지만 카테고리를 못 가져옴
  PENDING_TIME: "pending_time", // 유효 시청이지만 시청 시간을 아직 모름(대부분 보고 있는 영상)
};

/** 영상 하나의 시청 시간을 그 영상 길이로 자른다. 길이를 모르면 그대로 쓴다. */
function cappedWatchSeconds(watchedSeconds, durationSeconds) {
  if (watchedSeconds == null) return null;
  if (durationSeconds && durationSeconds > 0) {
    return Math.min(watchedSeconds, durationSeconds);
  }
  return watchedSeconds;
}

function watchedAtMs(entry) {
  const ms = Date.parse(entry.watchedAt);
  return Number.isFinite(ms) ? ms : Infinity;
}

/** 이어진 기록 묶음을 맨 앞 기록의 속성을 가진 한 시청으로 만든다. */
function mergeWatchGroup(group) {
  if (group.length === 1) return group[0];
  const ordered = [...group].sort((a, b) => watchedAtMs(a) - watchedAtMs(b));
  const [first] = ordered;
  const known = ordered.filter((e) => e.watchedSeconds != null);
  const flags = ordered.map((e) => e.wasBackgrounded).filter((v) => v != null);
  const rates = ordered.filter((e) => e.playbackRate != null);
  return {
    ...first,
    watchedSeconds:
      known.length > 0
        ? known.reduce((sum, e) => sum + e.watchedSeconds, 0)
        : null,
    wasBackgrounded:
      flags.length > 0 ? (flags.includes(1) ? 1 : 0) : first.wasBackgrounded,
    playbackRate:
      rates.length > 0 ? rates.at(-1).playbackRate : first.playbackRate,
  };
}

/**
 * 같은 목록 안에서 resumedFromEventId로 이어진 기록을 한 시청으로 합친다.
 * 같은 탭에서 10분 넘게 멈췄다가 다시 재생해 나뉜 기록이라 영상 수·유효 시청 판정은 합친 시청 하나로 한다.
 * - 맨 앞 기록의 eventId·본 시각·카테고리·유입 경로를 쓴다
 * - 시청 시간은 아는 값을 더하고, 모두 모르면 null이다
 * - 백그라운드는 하나라도 1이면 1, 배속은 마지막으로 관측된 값이다
 * 앞 기록이 목록에 없으면(다른 날 등) 그 기록부터 따로 센다. 연결이 순환해도 한 묶음으로 끝난다.
 * @param {Array<object>} entries
 * @returns {Array<object>} 묶음의 첫 기록이 나온 순서
 */
function mergeResumedWatches(entries) {
  if (!entries.some((e) => e.resumedFromEventId)) return entries;
  const indexById = new Map();
  entries.forEach((e, i) => {
    if (e.eventId) indexById.set(e.eventId, i);
  });
  const parent = entries.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  entries.forEach((e, i) => {
    const j = e.resumedFromEventId
      ? indexById.get(e.resumedFromEventId)
      : undefined;
    if (j !== undefined) parent[find(i)] = find(j);
  });
  const groups = new Map();
  entries.forEach((e, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(e);
  });
  return [...groups.values()].map(mergeWatchGroup);
}

/**
 * 그래프에서 빠지는 사유. 그래프에 들어가면 null.
 * 카테고리 없음을 시청 시간 모름보다 먼저 본다 — 시청 시간은 나중에 채워지지만 카테고리는 대개 그렇지 않다.
 */
function excludedReason(entry, minRelativeRatio) {
  if (!isValidWatch(entry, { minRelativeRatio })) return EXCLUDED_REASONS.SHORT;
  if (entry.categoryId == null) return EXCLUDED_REASONS.UNCATEGORIZED;
  if (entry.watchedSeconds == null) return EXCLUDED_REASONS.PENDING_TIME;
  return null;
}

/**
 * @param {Array<{eventId?: string, categoryId: number|null, durationSeconds: number|null,
 *   watchedSeconds: number|null, watchedAt?: string, resumedFromEventId?: string|null}>} entries
 *   - 영상 기록(재시청은 별도 항목, 멈췄다 이어 본 기록은 mergeResumedWatches로 합친다)
 * @param {{capWatchSeconds?: boolean, minRelativeRatio?: number}} [options] - 민감도 분석용.
 *   시청 시간 상한 적용 여부(기본 true)와 유효 시청 상대 기준(기본 isValidWatch 값). 화면·리뷰는 넘기지 않는다
 * @returns {object} 집계 결과 — 필드 설명은 본문 주석 참고
 */
function aggregateViewing(
  entries,
  { capWatchSeconds = true, minRelativeRatio } = {},
) {
  const withReason = mergeResumedWatches(entries).map((e) => ({
    ...e,
    reason: excludedReason(e, minRelativeRatio),
  }));
  const valid = withReason.filter((e) => e.reason !== EXCLUDED_REASONS.SHORT);
  const chart = withReason.filter((e) => e.reason === null);
  const countOf = (reason) =>
    withReason.filter((e) => e.reason === reason).length;

  const capped = (e) =>
    capWatchSeconds
      ? cappedWatchSeconds(e.watchedSeconds, e.durationSeconds)
      : e.watchedSeconds;
  const chartSeconds = chart.reduce((sum, e) => sum + capped(e), 0);

  // 분석용: 사전등록 정의. 상한 적용한 시청 시간이 양수인 영상이 없으면 null(기존 동작과 같음).
  const analysisWeighted = valid
    .filter((e) => e.categoryId != null && capped(e) > 0)
    .map((e) => ({ categoryId: e.categoryId, weight: capped(e) }));
  const weightedDistribution =
    analysisWeighted.length > 0
      ? calculateWeightedDistribution(analysisWeighted)
      : null;
  // 시청 시간을 모르는 유효 영상도 포함(화면용 countDistribution과 다름)
  const analysisDistribution = calculateDistribution(
    valid.map((e) => e.categoryId),
  );

  return {
    // 유효 시청 영상 수(카테고리 없는 영상, 시청 시간을 아직 모르는 영상 포함)
    validCount: valid.length,
    // 시청 시간이 확인된 유효 영상 수(카테고리 없는 영상 포함)
    confirmedCount: valid.filter((e) => e.watchedSeconds != null).length,
    shortCount: countOf(EXCLUDED_REASONS.SHORT),
    uncategorizedCount: countOf(EXCLUDED_REASONS.UNCATEGORIZED),
    pendingTimeCount: countOf(EXCLUDED_REASONS.PENDING_TIME),
    // 도넛 두 개가 함께 쓰는 대상
    chartCount: chart.length,
    chartSeconds,
    countDistribution: calculateDistribution(chart.map((e) => e.categoryId)),
    timeDistribution: calculateWeightedDistribution(
      chart.map((e) => ({ categoryId: e.categoryId, weight: capped(e) })),
    ),
    // 분석·저장용. 엔트로피는 반올림 전 비율로 계산한다
    analysisDistribution,
    entropy: calculateEntropy(
      calculateDistribution(
        valid.map((e) => e.categoryId),
        { round: false },
      ),
    ),
    weightedDistribution,
    weightedEntropy:
      weightedDistribution != null
        ? calculateEntropy(
            calculateWeightedDistribution(analysisWeighted, { round: false }),
          )
        : null,
    // 화면의 "오늘 시청한 영상" 목록 표시용
    excluded: withReason
      .filter((e) => e.reason !== null)
      .map((e) => ({ eventId: e.eventId ?? null, reason: e.reason })),
  };
}

/**
 * 영상을 본 시각(KST 날짜) 기준으로 나눠 날짜별로 aggregateViewing을 계산한다.
 * @returns {Array<object>} 날짜 오름차순, 각 항목은 { date, ...aggregateViewing }
 */
function aggregateViewingByDay(entries) {
  const byDate = new Map();
  for (const e of entries) {
    // 빈 값·파싱할 수 없는 값은 날짜를 정할 수 없어 뺀다.
    const ms = Date.parse(e.watchedAt);
    if (!Number.isFinite(ms)) continue;
    const date = kstDateStr(new Date(ms));
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(e);
  }
  return [...byDate.keys()]
    .sort()
    .map((date) => ({ date, ...aggregateViewing(byDate.get(date)) }));
}

module.exports = {
  EXCLUDED_REASONS,
  cappedWatchSeconds,
  mergeResumedWatches,
  aggregateViewing,
  aggregateViewingByDay,
};
