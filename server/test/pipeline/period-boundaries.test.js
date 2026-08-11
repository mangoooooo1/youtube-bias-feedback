import { describe, it, expect } from "vitest";
import {
  kstDateStr,
  dayFromInstall,
  mergeSessionDistributions,
  pendingCompletedPeriods,
} from "../../pipeline/period-boundaries.js";

describe("kstDateStr / dayFromInstall — KST 고정 날짜 계산", () => {
  it("UTC 자정 직후(KST로는 오전 9시)는 같은 KST 날짜로 계산된다", () => {
    expect(kstDateStr(new Date("2026-06-01T00:30:00Z"))).toBe("2026-06-01");
  });

  it("UTC로는 전날 오후이지만 KST로는 다음날로 넘어간 시각을 정확히 구분한다", () => {
    // 2026-05-31T15:30:00Z → KST로는 2026-06-01 00:30 (날짜가 넘어감)
    expect(kstDateStr(new Date("2026-05-31T15:30:00Z"))).toBe("2026-06-01");
    // 2026-05-31T14:30:00Z → KST로는 2026-05-31 23:30 (아직 넘어가기 전)
    expect(kstDateStr(new Date("2026-05-31T14:30:00Z"))).toBe("2026-05-31");
  });

  it("dayFromInstall은 설치일로부터 offsetDays만큼 지난 KST 날짜를 반환한다", () => {
    expect(dayFromInstall("2026-06-01T00:00:00Z", 0)).toBe("2026-06-01");
    expect(dayFromInstall("2026-06-01T00:00:00Z", 1)).toBe("2026-06-02");
    expect(dayFromInstall("2026-06-01T00:00:00Z", 6)).toBe("2026-06-07");
  });
});

describe("mergeSessionDistributions — videoCount 가중 병합", () => {
  it("세션이 없으면 빈 분포·entropy 0을 반환한다", () => {
    const result = mergeSessionDistributions([]);
    expect(result).toEqual({
      categoryDistribution: {},
      entropy: 0,
      videoCount: 0,
    });
  });

  it("videoCount로 가중 평균해 병합하고 합이 1이 되도록 정규화한다", () => {
    const result = mergeSessionDistributions([
      { categoryDistribution: { 음악: 1 }, videoCount: 3 },
      { categoryDistribution: { 게임: 1 }, videoCount: 1 },
    ]);
    expect(result.videoCount).toBe(4);
    expect(result.categoryDistribution.음악).toBeCloseTo(0.75);
    expect(result.categoryDistribution.게임).toBeCloseTo(0.25);
    const sum = Object.values(result.categoryDistribution).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBeCloseTo(1);
  });

  it("videoCount가 없는 세션은 1개로 취급한다", () => {
    const result = mergeSessionDistributions([
      { categoryDistribution: { 음악: 1 } },
    ]);
    expect(result.videoCount).toBe(1);
  });
});

describe("pendingCompletedPeriods — 완료된 기간 판정", () => {
  it("설치 당일(오늘)은 아직 어떤 기간도 완료되지 않은 것으로 본다", () => {
    const now = new Date("2026-06-01T10:00:00+09:00");
    const periods = pendingCompletedPeriods({
      installDate: "2026-06-01T00:00:00+09:00",
      existingIndexes: new Set(),
      totalDays: 7,
      daysPerPeriod: 1,
      baselineDays: 1,
      now,
    });
    expect(periods).toEqual([]);
  });

  it("설치 후 3일이 지나면 1~3일차가 오름차순으로 완료 처리된다", () => {
    const now = new Date("2026-06-04T10:00:00+09:00");
    const periods = pendingCompletedPeriods({
      installDate: "2026-06-01T00:00:00+09:00",
      existingIndexes: new Set(),
      totalDays: 7,
      daysPerPeriod: 1,
      baselineDays: 1,
      now,
    });
    expect(periods.map((p) => p.periodIndex)).toEqual([1, 2, 3]);
    expect(periods[0].periodStart).toBe("2026-06-01");
    expect(periods[0].periodEnd).toBe("2026-06-01");
  });

  it("이미 생성된 periodIndex는 결과에서 제외한다", () => {
    const now = new Date("2026-06-04T10:00:00+09:00");
    const periods = pendingCompletedPeriods({
      installDate: "2026-06-01T00:00:00+09:00",
      existingIndexes: new Set([1, 2]),
      totalDays: 7,
      daysPerPeriod: 1,
      baselineDays: 1,
      now,
    });
    expect(periods.map((p) => p.periodIndex)).toEqual([3]);
  });

  it("BASELINE_DAYS 미만의 startOffset을 가진 기간만 isBaseline=1이다", () => {
    const now = new Date("2026-06-05T10:00:00+09:00");
    const periods = pendingCompletedPeriods({
      installDate: "2026-06-01T00:00:00+09:00",
      existingIndexes: new Set(),
      totalDays: 7,
      daysPerPeriod: 2,
      baselineDays: 2,
      now,
    });
    // daysPerPeriod=2: 1구간(offset 0)은 baseline, 2구간(offset 2)은 아님
    expect(periods[0]).toMatchObject({ periodIndex: 1, isBaseline: 1 });
    expect(periods[1]).toMatchObject({ periodIndex: 2, isBaseline: 0 });
  });

  it("totalDays를 넘어서는 기간은 만들지 않는다", () => {
    const now = new Date("2026-07-01T10:00:00+09:00");
    const periods = pendingCompletedPeriods({
      installDate: "2026-06-01T00:00:00+09:00",
      existingIndexes: new Set(),
      totalDays: 7,
      daysPerPeriod: 1,
      baselineDays: 1,
      now,
    });
    expect(periods.length).toBe(7);
    expect(Math.max(...periods.map((p) => p.periodIndex))).toBe(7);
  });
});
