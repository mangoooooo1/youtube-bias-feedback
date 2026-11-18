// 테스트 날짜·기간 수를 일정 상수로 계산한다.
// 상수가 바뀌어도 "종료 후", "기준선 뒤", "2구간" 같은 뜻이 그대로 유지되게 한다.
import { TOTAL_DAYS, DAYS_PER_PERIOD } from "../pipeline/study-constants.js";

const DAY_MS = 86400000;

export const TOTAL_PERIODS = Math.ceil(TOTAL_DAYS / DAYS_PER_PERIOD);

/** 1부터 count까지의 periodIndex */
export function periodIndexes(count = TOTAL_PERIODS) {
  return Array.from({ length: count }, (_, i) => i + 1);
}

/** base(Date 또는 날짜 문자열)에서 days일 옮긴 날의 KST 날짜(YYYY-MM-DD) */
export function kstDay(base, days) {
  const ms = new Date(base).getTime() + days * DAY_MS;
  return new Date(ms).toLocaleDateString("sv", { timeZone: "Asia/Seoul" });
}

/** kstDay가 가리키는 날의 00:00 KST(ISO 문자열) */
export function kstMidnight(base, days) {
  return `${kstDay(base, days)}T00:00:00+09:00`;
}

/** now 기준 연구가 끝난 설치일 — 마지막 기간이 now보다 4일 전에 끝난다 */
export function endedInstallDate(now) {
  return kstMidnight(now, -(TOTAL_DAYS + 4));
}

/** now 기준 아직 진행 중인 설치일 — 2일 전 설치 */
export function notEndedInstallDate(now) {
  return kstMidnight(now, -2);
}
