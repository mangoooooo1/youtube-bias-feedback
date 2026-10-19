import { describe, it, expect } from "vitest";
import { normalizeIsoTimestamp } from "../../routes/iso-timestamp.js";

describe("normalizeIsoTimestamp", () => {
  it.each([
    ["시간대 없음", "2026-09-01T00:00:00"],
    ["날짜만", "2026-09-01"],
    ["비 ISO 형식", "Sep 1 2026"],
    ["없는 날짜", "2026-02-30T00:00:00Z"],
    ["24시", "2026-09-01T24:00:00Z"],
    ["소문자 t/z", "2026-09-01t00:00:00z"],
    ["초 없음", "2026-09-01T00:00Z"],
    ["콜론 없는 오프셋", "2026-09-01T00:00:00+0900"],
    ["범위 밖 오프셋", "2026-09-01T00:00:00+24:00"],
    ["빈 문자열", ""],
  ])("%s(%s)이면 null을 반환한다", (_label, value) => {
    expect(normalizeIsoTimestamp(value)).toBeNull();
  });

  it.each([
    ["숫자", 1788220800000],
    ["null", null],
    ["undefined", undefined],
    ["toString이 null인 객체", { toString: null }],
  ])("문자열이 아닌 값(%s)이면 예외 없이 null을 반환한다", (_label, value) => {
    expect(normalizeIsoTimestamp(value)).toBeNull();
  });

  it.each([
    ["Z", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00.000Z"],
    ["+09:00", "2026-09-01T09:00:00+09:00", "2026-09-01T00:00:00.000Z"],
    ["-05:00", "2026-08-31T19:00:00.5-05:00", "2026-09-01T00:00:00.500Z"],
    [
      "+09:00 자정(전날 UTC)",
      "2026-03-01T00:00:00+09:00",
      "2026-02-28T15:00:00.000Z",
    ],
  ])(
    "%s 형식은 같은 순간의 UTC ISO로 정규화한다",
    (_label, value, expected) => {
      expect(normalizeIsoTimestamp(value)).toBe(expected);
    },
  );

  it("toISOString 형식은 그대로 반환한다", () => {
    const value = new Date(Date.UTC(2026, 8, 1, 3, 4, 5, 678)).toISOString();
    expect(normalizeIsoTimestamp(value)).toBe(value);
  });
});
