// 기간(일차·주차) 경계 계산 + 세션 분포 병합

const KST_TZ = "Asia/Seoul";

function kstDateStr(date) {
  return date.toLocaleDateString("sv", { timeZone: KST_TZ });
}

/** installDate로부터 offsetDays만큼 지난 날짜를 KST 기준 YYYY-MM-DD로 반환 */
function dayFromInstall(installDate, offsetDays) {
  const ms = new Date(installDate).getTime() + offsetDays * 86400000;
  return kstDateStr(new Date(ms));
}

function calculateEntropy(distribution) {
  const proportions = Object.values(distribution);
  if (proportions.length === 0) return 0;
  const H = -proportions.reduce(
    (sum, p) => (p > 0 ? sum + p * Math.log2(p) : sum),
    0,
  );
  return Math.round(H * 100) / 100 || 0;
}

// extension/popup/viewlens-popup.js의 mergeDist와 동일한 가중 병합(videoCount 가중) + 정규화.
function mergeSessionDistributions(sessions) {
  const totalVideos = sessions.reduce((sum, s) => sum + (s.videoCount ?? 1), 0);
  if (totalVideos === 0) {
    return { categoryDistribution: {}, entropy: 0, videoCount: 0 };
  }

  const merged = {};
  for (const session of sessions) {
    const weight = (session.videoCount ?? 1) / totalVideos;
    for (const [cat, ratio] of Object.entries(
      session.categoryDistribution ?? {},
    )) {
      merged[cat] = (merged[cat] ?? 0) + ratio * weight;
    }
  }
  // 부동소수점 드리프트 보정 — 합이 1이 되도록 정규화
  const sum = Object.values(merged).reduce((a, b) => a + b, 0);
  if (sum > 0) {
    for (const cat of Object.keys(merged)) merged[cat] = merged[cat] / sum;
  }

  return {
    categoryDistribution: merged,
    entropy: calculateEntropy(merged),
    videoCount: totalVideos,
  };
}

/**
 * 아직 period_reviews가 없는, 완료된(오늘 KST 이전에 끝난) 기간을 오름차순으로 반환.
 * daysPerPeriod/baselineDays/totalDays는 클라이언트(viewlens-data.js)와 반드시 같은 값을
 * 유지해야 한다 — 어긋나면 서버가 "기간이 끝났다"고 판단하는 시점과 팝업 화면이 어긋난다
 */
function pendingCompletedPeriods({
  installDate,
  existingIndexes,
  totalDays,
  daysPerPeriod,
  baselineDays,
  now = new Date(),
}) {
  const totalPeriods = Math.ceil(totalDays / daysPerPeriod);
  const todayKst = kstDateStr(now);
  const periods = [];

  for (let p = 1; p <= totalPeriods; p++) {
    const startOffset = (p - 1) * daysPerPeriod;
    const endOffset = p * daysPerPeriod - 1;
    const periodEnd = dayFromInstall(installDate, endOffset);

    // 기간을 순서대로 보므로, 아직 안 끝난 기간을 만나면 이후 기간도 전부 미완료다.
    if (periodEnd >= todayKst) break;

    if (!existingIndexes.has(p)) {
      periods.push({
        periodIndex: p,
        periodStart: dayFromInstall(installDate, startOffset),
        periodEnd,
        isBaseline: startOffset < baselineDays ? 1 : 0,
      });
    }
  }

  return periods;
}

module.exports = {
  kstDateStr,
  dayFromInstall,
  calculateEntropy,
  mergeSessionDistributions,
  pendingCompletedPeriods,
};
