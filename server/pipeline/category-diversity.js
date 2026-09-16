// 카테고리 다양성 계산

const CATEGORY_NAMES = {
  1: "영화 & 애니메이션",
  2: "자동차 & 차량",
  10: "음악",
  15: "애완동물 & 동물",
  17: "스포츠",
  18: "단편 영화",
  19: "여행 & 이벤트",
  20: "게임",
  21: "동영상 블로그",
  22: "인물 & 블로그",
  23: "코미디",
  24: "엔터테인먼트",
  25: "뉴스 & 정치",
  26: "노하우 & 스타일",
  27: "교육",
  28: "과학 & 기술",
  29: "비영리 & 사회운동",
  30: "영화",
  31: "애니메이션/만화",
  32: "액션/어드벤처",
  33: "클래식",
  34: "코미디",
  35: "다큐멘터리",
  36: "드라마",
  37: "가족",
  38: "외국 영화",
  39: "공포",
  40: "공상과학 & 판타지",
  41: "스릴러",
  42: "짧은 영화",
  43: "예고편 & 쇼",
  44: "여행 & 이벤트",
};

function getCategoryName(categoryId) {
  return CATEGORY_NAMES[String(categoryId)] ?? "기타";
}

function calculateDistribution(categoryIds) {
  const validIds = categoryIds.filter((id) => id !== null && id !== undefined);
  if (validIds.length === 0) return {};

  const counts = {};
  for (const id of validIds) {
    const name = getCategoryName(id);
    counts[name] = (counts[name] ?? 0) + 1;
  }

  const total = validIds.length;
  const distribution = {};
  for (const [name, count] of Object.entries(counts)) {
    distribution[name] = Math.round((count / total) * 1000) / 1000;
  }

  return distribution;
}

// 클릭만 하고 바로 이탈한 영상(오클릭)을 다양성 계산에서 걸러내기 위한 판정.
// 절대 기준(30초)과 상대 기준(재생 비율 25%) 어느 한쪽만 넘어도 "실제 시청 선택"으로 인정한다.
// 절대 기준은 긴 영상에서 "일부만 보고 이탈"도 진짜 선택으로 인정하기 위함이고,
// 컷오프 값(30초/25%) 자체는 추후 민감도 분석으로 재검증 가능하도록, 이 함수가 참조하는
// 원시 데이터(watchedSeconds/durationSeconds)는 video_events/video_metadata에 그대로 보존된다.
const MIN_ABSOLUTE_WATCH_SECONDS = 30;
const MIN_RELATIVE_WATCH_RATIO = 0.25;

/**
 * @param {{watchedSeconds: number|null|undefined, durationSeconds: number|null|undefined}} entry
 * @returns {boolean} true면 "실제 시청"으로 인정. watchedSeconds를 모르면(계측 실패·구버전
 *   확장 등) 보수적으로 true를 반환한다. 데이터가 없다고 없는 셈 치면(무효 처리) 기존
 *   집계 방식(모든 영상 포함)보다 오히려 더 많은 영상을 부당하게 탈락시키게 된다.
 */
function isValidWatch({ watchedSeconds, durationSeconds }) {
  if (watchedSeconds === null || watchedSeconds === undefined) return true;
  if (watchedSeconds >= MIN_ABSOLUTE_WATCH_SECONDS) return true;
  if (durationSeconds && durationSeconds > 0) {
    return watchedSeconds / durationSeconds >= MIN_RELATIVE_WATCH_RATIO;
  }
  return false;
}

// 시간 가중 카테고리 분포
// calculateDistribution(영상 개수 가중)과 동일한 출력 형태를 유지하되,
// 가중치를 1(영상 1개)이 아니라 실제 시청 시간(초)으로 준다.
// weight가 없거나 0 이하인 항목은 전체 합에 기여하지 않도록 제외한다.
function calculateWeightedDistribution(entries) {
  const valid = entries.filter(
    (e) =>
      e.categoryId !== null &&
      e.categoryId !== undefined &&
      typeof e.weight === "number" &&
      Number.isFinite(e.weight) &&
      e.weight > 0,
  );
  if (valid.length === 0) return {};

  // 개별 weight가 다 유한해도(입력단 검증 통과) 여러 개를 그대로 더하면 합계 자체가 부동소수점 오버플로로 Infinity가 될 수 있다.
  // 먼저 최대 weight로 나눠 모든 값을 (0, 1] 범위로 정규화한 뒤 더하면, 유한한 입력에서는 합계가 최대
  // valid.length(최대 500)를 넘지 않아 오버플로되지 않는다.
  const maxWeight = Math.max(...valid.map((e) => e.weight));
  const weightByName = {};
  for (const { categoryId, weight } of valid) {
    const name = getCategoryName(categoryId);
    weightByName[name] = (weightByName[name] ?? 0) + weight / maxWeight;
  }
  const totalNormalizedWeight = Object.values(weightByName).reduce(
    (sum, w) => sum + w,
    0,
  );

  const distribution = {};
  for (const [name, weight] of Object.entries(weightByName)) {
    distribution[name] =
      Math.round((weight / totalNormalizedWeight) * 1000) / 1000;
  }
  return distribution;
}

function calculateEntropy(distribution) {
  const proportions = Object.values(distribution);
  if (proportions.length === 0) return 0;

  const H = -proportions.reduce((sum, p) => {
    if (p <= 0) return sum;
    return sum + p * Math.log2(p);
  }, 0);

  return Math.round(H * 100) / 100 || 0;
}

module.exports = {
  getCategoryName,
  calculateDistribution,
  calculateEntropy,
  isValidWatch,
  calculateWeightedDistribution,
};
