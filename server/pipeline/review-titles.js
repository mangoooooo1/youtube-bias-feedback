// 리뷰 LLM에 넘길 영상 제목을 카테고리별로 묶는다.
//
// 비중이 큰 카테고리 안에서 무엇을 주로 봤는지 짚으려면 그 카테고리의 제목을 전부 봐야 한다.
// 그래서 일부만 뽑지 않고 유효 시청 영상 제목을 전부 넘기고, 비정상적으로 많은 날만 상한으로 줄인다.
const { isValidWatch, getCategoryName } = require("./category-diversity");
const { cappedWatchSeconds } = require("./viewing-aggregate");
const { MAX_TITLES_PER_REVIEW } = require("./study-constants");

// 카테고리를 못 가져온 유효 영상 묶음 이름. 분포에서는 빠지지만 제목은 넘긴다.
const UNCATEGORIZED_GROUP = "분야 미확인";

function watchedMs(entry) {
  const ms = Date.parse(entry.watchedAt);
  return Number.isFinite(ms) ? ms : -Infinity;
}

/**
 * 같은 제목이 여러 번 나오면(같은 영상을 다시 본 경우 등) 한 줄로 합치고 본 횟수를 센다.
 * 줄 순서는 그 제목을 마지막으로 본 시각이 최근인 것부터. [{ title, count }]
 */
function uniqueTitles(entries) {
  const counts = new Map();
  for (const e of [...entries].sort((a, b) => watchedMs(b) - watchedMs(a))) {
    const title = typeof e.title === "string" ? e.title.trim() : "";
    if (!title) continue;
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return [...counts].map(([title, count]) => ({ title, count }));
}

/**
 * 묶음 크기에 비례해 상한을 나눈다(묶음마다 최소 1개). 남는 자리는 큰 묶음부터 채운다.
 * @returns {number[]} 묶음별로 남길 제목 수
 */
function allocateQuota(sizes, max) {
  const total = sizes.reduce((sum, n) => sum + n, 0);
  if (total <= max) return sizes;
  const quota = sizes.map((n) =>
    Math.min(n, Math.max(1, Math.floor((n * max) / total))),
  );
  const bySize = sizes.map((n, i) => i).sort((a, b) => sizes[b] - sizes[a]);
  let used = quota.reduce((sum, n) => sum + n, 0);
  // 최소 1개 보장 때문에 넘친 만큼 큰 묶음에서 덜어낸다
  for (const i of bySize) {
    while (used > max && quota[i] > 1) {
      quota[i]--;
      used--;
    }
  }
  for (const i of bySize) {
    while (used < max && quota[i] < sizes[i]) {
      quota[i]++;
      used++;
    }
  }
  return quota;
}

/**
 * @param {Array<{title?: string, watchedAt?: string, categoryId: number|null,
 *   watchedSeconds: number|null, durationSeconds: number|null}>} entries 영상 기록
 * @param {{maxTitles?: number}} [options]
 * @returns {Array<{category: string, videoCount: number, titles: Array<{title: string, count: number}>,
 *   omittedCount: number}>} 시청 시간이 많은 카테고리 순, "분야 미확인"은 마지막
 */
function groupTitlesByCategory(
  entries,
  { maxTitles = MAX_TITLES_PER_REVIEW } = {},
) {
  const groups = new Map();
  for (const e of entries.filter(isValidWatch)) {
    const category =
      e.categoryId == null
        ? UNCATEGORIZED_GROUP
        : getCategoryName(e.categoryId);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(e);
  }

  const seconds = (list) =>
    list.reduce(
      (sum, e) =>
        sum + (cappedWatchSeconds(e.watchedSeconds, e.durationSeconds) ?? 0),
      0,
    );
  const ordered = [...groups]
    .map(([category, list]) => ({
      category,
      list,
      seconds: seconds(list),
      titles: uniqueTitles(list),
    }))
    .sort((a, b) => {
      const aLast = a.category === UNCATEGORIZED_GROUP;
      const bLast = b.category === UNCATEGORIZED_GROUP;
      if (aLast !== bLast) return aLast ? 1 : -1;
      return b.seconds - a.seconds || b.list.length - a.list.length;
    });

  const quota = allocateQuota(
    ordered.map((g) => g.titles.length),
    maxTitles,
  );
  return ordered.map((g, i) => ({
    category: g.category,
    videoCount: g.list.length,
    titles: g.titles.slice(0, quota[i]),
    omittedCount: g.titles.length - quota[i],
  }));
}

module.exports = { groupTitlesByCategory, UNCATEGORIZED_GROUP };
