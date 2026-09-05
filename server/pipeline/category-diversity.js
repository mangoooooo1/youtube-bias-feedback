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
};
