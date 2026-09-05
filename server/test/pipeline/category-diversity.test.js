import { describe, it, expect } from "vitest";
import {
  calculateDistribution,
  calculateEntropy,
  getCategoryName,
} from "../../pipeline/category-diversity.js";

describe("calculateDistribution", () => {
  it("빈 배열이면 빈 객체를 반환한다", () => {
    expect(calculateDistribution([])).toEqual({});
  });

  it("null/undefined 카테고리 id를 제외하고 계산한다", () => {
    const result = calculateDistribution([10, null, 10, undefined]);
    expect(result).toEqual({ 음악: 1 });
  });

  it("여러 카테고리의 비율을 소수점 3자리로 반올림한다", () => {
    const result = calculateDistribution([10, 10, 20]);
    expect(result).toEqual({ 음악: 0.667, 게임: 0.333 });
  });

  it("알 수 없는 카테고리 id는 '기타'로 묶인다", () => {
    const result = calculateDistribution([9999]);
    expect(result).toEqual({ 기타: 1 });
  });

  it("문자열 categoryId(YouTube API 원본 형식)도 동일하게 처리한다", () => {
    const result = calculateDistribution(["10", "10", "20"]);
    expect(result).toEqual({ 음악: 0.667, 게임: 0.333 });
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

describe("getCategoryName", () => {
  it("알려진 categoryId는 한글 이름으로 변환한다", () => {
    expect(getCategoryName(25)).toBe("뉴스 & 정치");
    expect(getCategoryName("25")).toBe("뉴스 & 정치");
  });

  it("알 수 없는 categoryId는 '기타'를 반환한다", () => {
    expect(getCategoryName(9999)).toBe("기타");
  });
});
