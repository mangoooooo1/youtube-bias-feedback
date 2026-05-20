import { getCategoryName } from './categories.js';

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
    (s) => s.endTime && s.categoryDistribution && Object.keys(s.categoryDistribution).length > 0
  );

  const byDate = {};
  for (const session of analyzed) {
    const date = new Date(session.endTime).toLocaleDateString('sv'); // KST 기준 YYYY-MM-DD
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(session);
  }

  // 오늘 기준 최근 7일을 고정 생성 (오름차순)
  const dates = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.toLocaleDateString('sv'));
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

    const totalVideos = daySessions.reduce((sum, s) => sum + (s.videoCount ?? 1), 0);
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
