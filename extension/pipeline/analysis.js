import { getCategoryName } from "./categories.js";

export function calculateDistribution(categoryIds) {
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

export function calculateEntropy(distribution) {
  const proportions = Object.values(distribution);
  if (proportions.length === 0) return 0;

  const H = -proportions.reduce((sum, p) => {
    if (p <= 0) return sum;
    return sum + p * Math.log2(p);
  }, 0);

  return Math.round(H * 100) / 100 || 0;
}

export function aggregateDailyData(sessions) {
  const analyzed = sessions.filter(
    (s) =>
      s.endTime &&
      s.categoryDistribution &&
      Object.keys(s.categoryDistribution).length > 0,
  );

  const byDate = {};
  for (const session of analyzed) {
    const date = new Date(session.endTime).toLocaleDateString("sv"); // 로컬 시간대 기준 YYYY-MM-DD
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(session);
  }

  // 오늘 기준 최근 7일을 고정 생성 (오름차순)
  const dates = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.toLocaleDateString("sv"));
  }

  const distributions = [];
  const entropies = [];

  for (const date of dates) {
    const daySessions = byDate[date];
    if (!daySessions) {
      distributions.push(null);
      entropies.push(null);
      continue;
    }

    const totalVideos = daySessions.reduce(
      (sum, s) => sum + (s.videoCount ?? 1),
      0,
    );
    const merged = {};
    for (const session of daySessions) {
      const weight = (session.videoCount ?? 1) / totalVideos;
      for (const [cat, ratio] of Object.entries(session.categoryDistribution)) {
        merged[cat] = (merged[cat] ?? 0) + ratio * weight;
      }
    }
    for (const cat of Object.keys(merged)) {
      merged[cat] = Math.round(merged[cat] * 1000) / 1000;
    }

    distributions.push(merged);
    entropies.push(calculateEntropy(merged));
  }

  return { dates, distributions, entropies };
}

// videoCount 가중 평균으로 여러 세션의 categoryDistribution을 하나로 합친다.
// aggregateDailyData와 동일한 가중 병합 공식(세션 규모만큼 비중을 둠)을 오늘 하루 범위에도 적용한다.
function mergeCategoryDistribution(sessions) {
  const totalVideos = sessions.reduce((sum, s) => sum + (s.videoCount ?? 1), 0);
  if (totalVideos === 0) return {};

  const merged = {};
  for (const session of sessions) {
    const weight = (session.videoCount ?? 1) / totalVideos;
    for (const [cat, ratio] of Object.entries(session.categoryDistribution)) {
      merged[cat] = (merged[cat] ?? 0) + ratio * weight;
    }
  }
  for (const cat of Object.keys(merged)) {
    merged[cat] = Math.round(merged[cat] * 1000) / 1000;
  }
  return merged;
}

// "오늘" 탭 누적 리뷰의 근거 데이터를 집계
// 오늘 세션 전체 병합, "가장 최근에 데이터가 있었던 이전 날짜"의 entropy를 prevEntropy로 계산
export function aggregateTodayCumulative(sessions) {
  const today = new Date().toLocaleDateString("sv");

  const analyzed = sessions.filter(
    (s) =>
      s.endTime &&
      s.categoryDistribution &&
      Object.keys(s.categoryDistribution).length > 0,
  );

  const todaySessions = analyzed.filter(
    (s) => new Date(s.endTime).toLocaleDateString("sv") === today,
  );
  if (todaySessions.length === 0) return null;

  const categoryDistribution = mergeCategoryDistribution(todaySessions);
  const entropy = calculateEntropy(categoryDistribution);
  const videoCount = todaySessions.reduce(
    (sum, s) => sum + (s.videoCount ?? s.videos?.length ?? 1),
    0,
  );
  const videoTitles = todaySessions
    .flatMap((s) => (s.videos || []).map((v) => v.title))
    .filter(Boolean);
  const sessionIds = todaySessions.map((s) => s.sessionId);

  const priorSessions = analyzed
    .filter((s) => new Date(s.endTime).toLocaleDateString("sv") !== today)
    .sort((a, b) => new Date(b.endTime) - new Date(a.endTime));

  let prevEntropy = null;
  if (priorSessions.length > 0) {
    const prevDate = new Date(priorSessions[0].endTime).toLocaleDateString(
      "sv",
    );
    const prevDaySessions = priorSessions.filter(
      (s) => new Date(s.endTime).toLocaleDateString("sv") === prevDate,
    );
    prevEntropy = calculateEntropy(mergeCategoryDistribution(prevDaySessions));
  }

  return {
    reviewDate: today,
    categoryDistribution,
    entropy,
    prevEntropy,
    videoCount,
    videoTitles,
    sessionCount: todaySessions.length,
    sessionIds,
  };
}
