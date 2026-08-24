import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  calculateDistribution,
  calculateEntropy,
  aggregateDailyData,
  aggregateTodayCumulative,
} from "../../pipeline/analysis.js";

describe("calculateDistribution", () => {
  it("빈 배열이면 빈 객체를 반환한다", () => {
    expect(calculateDistribution([])).toEqual({});
  });

  it("null/undefined 카테고리 id를 제외하고 계산한다", () => {
    // 10=음악, null/undefined는 삭제/비공개 영상(youtube.js의 nullMap)
    const result = calculateDistribution([10, null, 10, undefined]);
    expect(result).toEqual({ 음악: 1 });
  });

  it("여러 카테고리의 비율을 소수점 3자리로 반올림한다", () => {
    // 10=음악 x2, 20=게임 x1 → 2/3, 1/3
    const result = calculateDistribution([10, 10, 20]);
    expect(result).toEqual({ 음악: 0.667, 게임: 0.333 });
  });

  it("알 수 없는 카테고리 id는 '기타'로 묶인다", () => {
    const result = calculateDistribution([9999]);
    expect(result).toEqual({ 기타: 1 });
  });
});

describe("calculateEntropy", () => {
  it("빈 분포면 0을 반환한다", () => {
    expect(calculateEntropy({})).toBe(0);
  });

  it("단일 카테고리(비율 1)면 entropy는 0이다", () => {
    expect(calculateEntropy({ 음악: 1 })).toBe(0);
  });

  it("두 카테고리 균등 분포면 entropy는 log2(2)=1이다", () => {
    expect(calculateEntropy({ 음악: 0.5, 게임: 0.5 })).toBe(1);
  });

  it("네 카테고리 균등 분포면 entropy는 log2(4)=2다", () => {
    expect(calculateEntropy({ a: 0.25, b: 0.25, c: 0.25, d: 0.25 })).toBe(2);
  });

  it("비균등 분포(0.25/0.75)의 entropy를 소수점 2자리로 반올림한다", () => {
    expect(calculateEntropy({ 음악: 0.25, 게임: 0.75 })).toBe(0.81);
  });
});

describe("aggregateDailyData", () => {
  beforeEach(() => {
    // "오늘"을 2026-01-10 정오(로컬)로 고정 — 최근 7일 창(1/4~1/10) 계산을 결정론적으로 만든다.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 10, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("분석되지 않은 세션(categoryDistribution 없음)은 집계에서 제외한다", () => {
    const sessions = [
      {
        endTime: new Date(2026, 0, 8, 12).toISOString(),
        categoryDistribution: {},
      },
      { endTime: new Date(2026, 0, 8, 12).toISOString() }, // categoryDistribution 자체가 없음
    ];
    const { dates, distributions, entropies } = aggregateDailyData(sessions);
    expect(dates).toHaveLength(7);
    expect(distributions.every((d) => d === null)).toBe(true);
    expect(entropies.every((e) => e === null)).toBe(true);
  });

  it("최근 7일을 오늘 기준 오름차순으로 고정 생성한다", () => {
    const { dates } = aggregateDailyData([]);
    expect(dates).toEqual([
      "2026-01-04",
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
      "2026-01-10",
    ]);
  });

  it("결측일은 null로, 데이터가 있는 날은 videoCount 가중 평균으로 병합한다", () => {
    const sessions = [
      {
        endTime: new Date(2026, 0, 8, 10).toISOString(),
        videoCount: 1,
        categoryDistribution: { 음악: 1 },
      },
      {
        endTime: new Date(2026, 0, 8, 15).toISOString(),
        videoCount: 3,
        categoryDistribution: { 게임: 1 },
      },
    ];

    const { dates, distributions, entropies } = aggregateDailyData(sessions);
    const jan8 = dates.indexOf("2026-01-08");

    // 가중 평균: 음악 1*(1/4) + 게임 1*(3/4)
    expect(distributions[jan8]).toEqual({ 음악: 0.25, 게임: 0.75 });
    expect(entropies[jan8]).toBe(0.81);

    // 나머지 날짜는 결측 — 세션이 없으므로 null 유지
    const otherIndices = dates.map((_, i) => i).filter((i) => i !== jan8);
    for (const i of otherIndices) {
      expect(distributions[i]).toBeNull();
      expect(entropies[i]).toBeNull();
    }
  });
});

describe("aggregateTodayCumulative", () => {
  beforeEach(() => {
    // "오늘"을 2026-01-10 정오(로컬)로 고정
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 10, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("오늘 세션이 없으면 null을 반환한다", () => {
    const sessions = [
      {
        sessionId: "s1",
        endTime: new Date(2026, 0, 9, 10).toISOString(),
        videoCount: 1,
        categoryDistribution: { 음악: 1 },
      },
    ];
    expect(aggregateTodayCumulative(sessions)).toBeNull();
  });

  it("분석되지 않은 세션(categoryDistribution 없음)은 오늘 세션이어도 집계에서 제외한다", () => {
    const sessions = [
      { sessionId: "s1", endTime: new Date(2026, 0, 10, 9).toISOString() },
      {
        sessionId: "s2",
        endTime: new Date(2026, 0, 10, 10).toISOString(),
        categoryDistribution: {},
      },
    ];
    expect(aggregateTodayCumulative(sessions)).toBeNull();
  });

  it("오늘 여러 세션을 videoCount 가중 평균으로 병합한다", () => {
    const sessions = [
      {
        sessionId: "s1",
        endTime: new Date(2026, 0, 10, 9).toISOString(),
        videoCount: 1,
        categoryDistribution: { 음악: 1 },
        videos: [{ title: "음악 영상" }],
      },
      {
        sessionId: "s2",
        endTime: new Date(2026, 0, 10, 11).toISOString(),
        videoCount: 3,
        categoryDistribution: { 게임: 1 },
        videos: [{ title: "게임1" }, { title: "게임2" }, { title: "게임3" }],
      },
    ];

    const result = aggregateTodayCumulative(sessions);
    expect(result.reviewDate).toBe("2026-01-10");
    // 가중 평균: 음악 1*(1/4) + 게임 1*(3/4)
    expect(result.categoryDistribution).toEqual({ 음악: 0.25, 게임: 0.75 });
    expect(result.entropy).toBe(0.81);
    expect(result.videoCount).toBe(4);
    expect(result.sessionCount).toBe(2);
    expect(result.sessionIds).toEqual(["s1", "s2"]);
    expect(result.videoTitles).toEqual([
      "음악 영상",
      "게임1",
      "게임2",
      "게임3",
    ]);
  });

  it("videoCount가 없는 세션은 videos.length로 폴백하고, 그 값이 분포 가중치에도 동일하게 반영된다", () => {
    const sessions = [
      {
        sessionId: "s1",
        endTime: new Date(2026, 0, 10, 9).toISOString(),
        // videoCount 없음 — videos.length(3)로 폴백해야 함
        categoryDistribution: { 음악: 1 },
        videos: [{ title: "음악1" }, { title: "음악2" }, { title: "음악3" }],
      },
      {
        sessionId: "s2",
        endTime: new Date(2026, 0, 10, 11).toISOString(),
        videoCount: 1,
        categoryDistribution: { 게임: 1 },
        videos: [{ title: "게임1" }],
      },
    ];

    const result = aggregateTodayCumulative(sessions);
    // 총 영상 수: 3(videos.length 폴백) + 1 = 4
    expect(result.videoCount).toBe(4);
    // 가중치도 같은 3:1 비율을 써야 한다(1:1로 잘못 계산되면 0.5/0.5가 나옴)
    expect(result.categoryDistribution).toEqual({ 음악: 0.75, 게임: 0.25 });
  });

  it("직전 세션이 아니라 가장 최근 데이터가 있었던 이전 날짜의 entropy를 prevEntropy로 계산한다", () => {
    const sessions = [
      // 1/7 (사흘 전) — 오늘 대비 더 오래된 날짜
      {
        sessionId: "old",
        endTime: new Date(2026, 0, 7, 10).toISOString(),
        videoCount: 1,
        categoryDistribution: { 스포츠: 1 },
      },
      // 1/8 — 가장 최근 이전 시청일 (1/9은 데이터 없음, 하루 건너뜀)
      {
        sessionId: "prev1",
        endTime: new Date(2026, 0, 8, 10).toISOString(),
        videoCount: 1,
        categoryDistribution: { 음악: 1 },
      },
      {
        sessionId: "prev2",
        endTime: new Date(2026, 0, 8, 15).toISOString(),
        videoCount: 1,
        categoryDistribution: { 게임: 1 },
      },
      // 오늘 (1/10)
      {
        sessionId: "today",
        endTime: new Date(2026, 0, 10, 10).toISOString(),
        videoCount: 1,
        categoryDistribution: { 교육: 1 },
      },
    ];

    const result = aggregateTodayCumulative(sessions);
    // 1/8 균등 분포(음악 0.5, 게임 0.5) → entropy 1
    expect(result.prevEntropy).toBe(1);
  });

  it("이전 시청일이 없으면 prevEntropy는 null이다", () => {
    const sessions = [
      {
        sessionId: "today",
        endTime: new Date(2026, 0, 10, 10).toISOString(),
        videoCount: 1,
        categoryDistribution: { 교육: 1 },
      },
    ];
    expect(aggregateTodayCumulative(sessions).prevEntropy).toBeNull();
  });

  it("videos 배열이 없어도(videoCount만 있어도) 집계가 동작한다", () => {
    const sessions = [
      {
        sessionId: "s1",
        endTime: new Date(2026, 0, 10, 9).toISOString(),
        videoCount: 2,
        categoryDistribution: { 음악: 1 },
      },
    ];
    const result = aggregateTodayCumulative(sessions);
    expect(result.videoCount).toBe(2);
    expect(result.videoTitles).toEqual([]);
  });
});
