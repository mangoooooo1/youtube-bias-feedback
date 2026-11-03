import { describe, it, expect } from "vitest";
import {
  countPastDayViews,
  pearson,
} from "../../scripts/compute-feedback-engagement-correlation.js";

describe("countPastDayViews — 지난 날 리뷰 열람 날짜 수", () => {
  it("결과 측정 구간이 끝난 날(KST, 그날 포함)까지 연 팝업의 값만 더한다", () => {
    const events = [
      { openedAt: "2026-11-10T03:00:00.000Z", pastDayReviewViews: 2 },
      // KST 11/15 23:30 — 구간 마지막 날이라 센다
      { openedAt: "2026-11-15T14:30:00.000Z", pastDayReviewViews: 1 },
      // KST 11/16 00:30 — 구간이 끝난 뒤라 세지 않는다
      { openedAt: "2026-11-15T15:30:00.000Z", pastDayReviewViews: 5 },
    ];
    expect(countPastDayViews(events, "2026-11-15")).toBe(3);
  });

  it("값이 없는 행(구버전 확장)과 openedAt이 없는 행은 세지 않는다", () => {
    const events = [
      { openedAt: "2026-11-10T03:00:00.000Z", pastDayReviewViews: null },
      { openedAt: null, pastDayReviewViews: 4 },
      { openedAt: "2026-11-10T03:00:00.000Z", pastDayReviewViews: 0 },
    ];
    expect(countPastDayViews(events, "2026-11-15")).toBe(0);
  });
});

describe("pearson", () => {
  it("표본이 2개 미만이거나 한쪽 분산이 0이면 null", () => {
    expect(pearson([1], [2])).toBeNull();
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  it("완전한 양의 상관은 1", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBe(1);
  });
});
