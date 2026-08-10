// 실험 첫 2주는 그룹(EXP/CON) 무관하게 전원 동일 처리(피드백·알림 미전달)하는 베이스라인 기간
// 테스트 기간으로 1일로 단축
export const BASELINE_DAYS = 1;

// installDate로부터 now까지 경과일이 BASELINE_DAYS 미만이면 베이스라인 기간(피드백 비활성).
// installDate가 없으면(온보딩 직후 등 비정상 상태) 안전하게 베이스라인으로 취급한다.
export function isBaselinePeriod(installDate, now = new Date()) {
  if (!installDate) return true;
  const elapsedDays =
    (now.getTime() - new Date(installDate).getTime()) / 86400000;
  return elapsedDays < BASELINE_DAYS;
}
