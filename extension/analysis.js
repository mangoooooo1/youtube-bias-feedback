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

  if (analyzed.length === 0) return { dates: [], distributions: [], entropies: [] };

  const byDate = {};
  for (const session of analyzed) {
    const date = new Date(session.endTime).toLocaleDateString('sv'); // KST 기준 YYYY-MM-DD
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(session);
  }

  const dates = Object.keys(byDate).sort();
  const distributions = [];
  const entropies = [];

  for (const date of dates) {
    const daySessions = byDate[date];
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
