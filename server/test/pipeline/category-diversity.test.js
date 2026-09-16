import { describe, it, expect } from "vitest";
import {
  calculateDistribution,
  calculateEntropy,
  getCategoryName,
  isValidWatch,
  calculateWeightedDistribution,
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

// 클릭성 이탈(오클릭) 판별 (시청시간 기반 노이즈 제거)
describe("isValidWatch", () => {
  it("watchedSeconds를 모르면(계측 실패·구버전 확장) 보수적으로 유효 처리한다", () => {
    expect(isValidWatch({ watchedSeconds: null, durationSeconds: 600 })).toBe(
      true,
    );
    expect(
      isValidWatch({ watchedSeconds: undefined, durationSeconds: 600 }),
    ).toBe(true);
  });

  it("절대 기준(30초 이상)을 넘으면 durationSeconds와 무관하게 유효하다", () => {
    expect(isValidWatch({ watchedSeconds: 30, durationSeconds: 3600 })).toBe(
      true,
    );
    expect(isValidWatch({ watchedSeconds: 45, durationSeconds: null })).toBe(
      true,
    );
  });

  it("절대 기준 미달이어도 상대 기준(25% 이상)을 넘으면 유효하다 — 짧은 영상(쇼츠)에 자연히 유리하게 작동", () => {
    // 15초 쇼츠: 25%는 3.75초 — 절대 30초보다 훨씬 낮은 문턱이 저절로 적용된다.
    expect(isValidWatch({ watchedSeconds: 4, durationSeconds: 15 })).toBe(true);
  });

  it("절대·상대 기준을 모두 충족 못하면 무효(오클릭)로 판정한다", () => {
    expect(isValidWatch({ watchedSeconds: 2, durationSeconds: 15 })).toBe(
      false,
    );
    expect(isValidWatch({ watchedSeconds: 5, durationSeconds: 600 })).toBe(
      false,
    );
  });

  it("durationSeconds가 없거나 0이면 상대 기준을 적용할 수 없어 절대 기준만으로 판정한다", () => {
    expect(isValidWatch({ watchedSeconds: 5, durationSeconds: 0 })).toBe(false);
    expect(isValidWatch({ watchedSeconds: 5, durationSeconds: null })).toBe(
      false,
    );
  });
});

// 시간 가중 다양성 지표 (유효/무효 이분법 대신 시청시간 가중 entropy 병행)
describe("calculateWeightedDistribution", () => {
  it("빈 배열이면 빈 객체를 반환한다", () => {
    expect(calculateWeightedDistribution([])).toEqual({});
  });

  it("weight가 없거나 0 이하인 항목은 제외한다", () => {
    const result = calculateWeightedDistribution([
      { categoryId: 10, weight: 100 },
      { categoryId: 20, weight: 0 },
      { categoryId: 20, weight: -5 },
      { categoryId: 20, weight: null },
    ]);
    expect(result).toEqual({ 음악: 1 });
  });

  it("categoryId가 없는 항목은 제외한다", () => {
    const result = calculateWeightedDistribution([
      { categoryId: 10, weight: 100 },
      { categoryId: null, weight: 100 },
    ]);
    expect(result).toEqual({ 음악: 1 });
  });

  it("같은 카테고리의 weight를 합산해 비율을 계산한다(영상 개수가 아니라 시청 시간 기준)", () => {
    // 음악 영상 1개(600초)와 게임 영상 3개(각 100초, 합 300초) — 개수로는 게임이
    // 우세하지만(3:1) 시청시간으로는 음악이 우세하다(600:300) — 이 차이를 검증한다.
    const result = calculateWeightedDistribution([
      { categoryId: 10, weight: 600 },
      { categoryId: 20, weight: 100 },
      { categoryId: 20, weight: 100 },
      { categoryId: 20, weight: 100 },
    ]);
    expect(result).toEqual({ 음악: 0.667, 게임: 0.333 });
  });

  // Infinity/NaN 오염 경로(코드리뷰 회귀): 검증기가 뚫려 weight로 Infinity가 들어오거나,
  // 유한한 weight들의 합 자체가 부동소수점 오버플로로 Infinity가 되는 두 경우 모두
  // distribution이 NaN(→ JSON.stringify가 null로 저장)이 되면 안 된다.
  describe("weight 오버플로/비정상값 방어(코드리뷰 회귀)", () => {
    it("weight가 Infinity/NaN인 항목은 제외한다(검증기를 우회해 들어온 경우 방어)", () => {
      const result = calculateWeightedDistribution([
        { categoryId: 10, weight: 100 },
        { categoryId: 20, weight: Infinity },
        { categoryId: 30, weight: NaN },
      ]);
      expect(result).toEqual({ 음악: 1 });
    });

    it("weight 전부가 Infinity/NaN이면 빈 객체를 반환한다", () => {
      const result = calculateWeightedDistribution([
        { categoryId: 10, weight: Infinity },
        { categoryId: 20, weight: NaN },
      ]);
      expect(result).toEqual({});
    });

    it("개별 weight는 유한해도 합계가 오버플로되는 극단값에서도 NaN 없이 유한한 비율을 반환한다", () => {
      // 1e308 두 개를 그대로 더하면(2e308) 부동소수점 double 표현 범위를 넘어 Infinity가
      // 된다 — 이 경우 예전 구현(그대로 합산)은 두 카테고리 모두 Infinity/Infinity=NaN이
      // 됐다. 최대값으로 정규화한 뒤 더하면 이런 경우에도 정상적으로 0.5/0.5가 나와야 한다.
      const result = calculateWeightedDistribution([
        { categoryId: 10, weight: 1e308 },
        { categoryId: 20, weight: 1e308 },
      ]);
      expect(result).toEqual({ 음악: 0.5, 게임: 0.5 });
      expect(Number.isFinite(result.음악)).toBe(true);
      expect(Number.isFinite(result.게임)).toBe(true);
    });

    it("여러 유효 항목(500개 규모)의 weight가 모두 커도 합계 오버플로 없이 정상 비율을 낸다", () => {
      const entries = Array.from({ length: 500 }, (_, i) => ({
        categoryId: i % 2 === 0 ? 10 : 20,
        weight: 8e307, // 500개를 그대로 더하면(4e310) 확실히 Infinity로 오버플로된다.
      }));
      const result = calculateWeightedDistribution(entries);
      expect(result).toEqual({ 음악: 0.5, 게임: 0.5 });
    });
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
