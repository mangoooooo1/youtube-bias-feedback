// 연구 관찰 기간 종료 여부·대조군 판별 —
// installDate로부터 totalDays가 지났으면 연구 관찰 기간이 종료된 것으로 본다.
export function isStudyEnded(installDate, totalDays, now = new Date()) {
  if (!installDate) return false;
  const endMs = new Date(installDate).getTime() + totalDays * 86400000;
  return now.getTime() >= endMs;
}

// 대조군(CON, TEST-CON) 판별
const CONTROL_GROUP_CODES = new Set(["CON", "TEST-CON"]);
export function isConGroup(code) {
  return CONTROL_GROUP_CODES.has(code);
}
