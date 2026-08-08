import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  calculateDistribution,
  calculateChannelDistribution,
  calculateTopicDistribution,
  calculateEntropy,
  aggregateDailyData,
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

describe("calculateChannelDistribution", () => {
  it("빈 배열이면 빈 객체를 반환한다", () => {
    expect(calculateChannelDistribution([])).toEqual({});
  });

  it("null/undefined/빈 문자열 채널명을 제외하고 계산한다", () => {
    const result = calculateChannelDistribution(["A채널", null, "A채널", undefined, ""]);
    expect(result).toEqual({ A채널: 1 });
  });

  it("여러 채널의 비율을 소수점 3자리로 반올림한다", () => {
    const result = calculateChannelDistribution(["A채널", "A채널", "B채널"]);
    expect(result).toEqual({ A채널: 0.667, B채널: 0.333 });
  });
});

describe("calculateTopicDistribution", () => {
  it("빈 배열이면 빈 객체를 반환한다", () => {
    expect(calculateTopicDistribution([])).toEqual({});
  });

  it("영상당 여러 토픽을 평탄화해서 등장 횟수로 집계한다", () => {
    // v1: Politics+Music, v2: Music → Music 2회, Politics 1회
    const result = calculateTopicDistribution([
      [
        "https://en.wikipedia.org/wiki/Politics",
        "https://en.wikipedia.org/wiki/Music",
      ],
      ["https://en.wikipedia.org/wiki/Music"],
    ]);
    expect(result).toEqual({ Music: 0.667, Politics: 0.333 });
  });

  it("Wikipedia URL의 밑줄을 공백으로 바꿔 사람이 읽을 라벨로 변환한다", () => {
    const result = calculateTopicDistribution([
      ["https://en.wikipedia.org/wiki/Video_game_culture"],
    ]);
    expect(result).toEqual({ "Video game culture": 1 });
  });

  it("빈 토픽 배열(topicDetails 없음)이 섞여 있어도 무시하고 계산한다", () => {
    const result = calculateTopicDistribution([
      ["https://en.wikipedia.org/wiki/Music"],
      [],
    ]);
    expect(result).toEqual({ Music: 1 });
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
    expect(
      calculateEntropy({ a: 0.25, b: 0.25, c: 0.25, d: 0.25 }),
    ).toBe(2);
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
      { endTime: new Date(2026, 0, 8, 12).toISOString(), categoryDistribution: {} },
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
