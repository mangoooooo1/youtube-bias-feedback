import { describe, it, expect } from "vitest";
import { isConGroup } from "../../pipeline/study-period.js";

describe("isConGroup", () => {
  it("CON/TEST-CON은 대조군으로 판별한다", () => {
    expect(isConGroup("CON")).toBe(true);
    expect(isConGroup("TEST-CON")).toBe(true);
  });

  it("EXP/TEST-EXP는 대조군이 아니다", () => {
    expect(isConGroup("EXP")).toBe(false);
    expect(isConGroup("TEST-EXP")).toBe(false);
  });

  it("알 수 없는 값은 대조군이 아니다", () => {
    expect(isConGroup(undefined)).toBe(false);
    expect(isConGroup(null)).toBe(false);
    expect(isConGroup("")).toBe(false);
  });
});
