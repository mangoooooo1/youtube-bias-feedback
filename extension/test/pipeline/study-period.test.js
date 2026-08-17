import { describe, it, expect } from "vitest";
import { isStudyEnded, isConGroup } from "../../pipeline/study-period.js";

describe("isStudyEnded", () => {
  it("installDate가 없으면 종료되지 않은 것으로 취급한다", () => {
    expect(isStudyEnded(null, 6)).toBe(false);
    expect(isStudyEnded(undefined, 6)).toBe(false);
  });

  it("경과일이 totalDays 미만이면 종료되지 않았다", () => {
    const install = new Date("2026-01-01T00:00:00Z");
    const now = new Date(install.getTime() + 5 * 86400000);
    expect(isStudyEnded(install.toISOString(), 6, now)).toBe(false);
  });

  it("경과일이 정확히 totalDays이면 종료된다(경계값)", () => {
    const install = new Date("2026-01-01T00:00:00Z");
    const now = new Date(install.getTime() + 6 * 86400000);
    expect(isStudyEnded(install.toISOString(), 6, now)).toBe(true);
  });

  it("경과일이 totalDays를 초과해도 종료된다", () => {
    const install = new Date("2026-01-01T00:00:00Z");
    const now = new Date(install.getTime() + 40 * 86400000);
    expect(isStudyEnded(install.toISOString(), 6, now)).toBe(true);
  });

  it("totalDays 값만 바꾸면(파일럿→본조사) 코드 수정 없이 재계산된다", () => {
    const install = new Date("2026-01-01T00:00:00Z");
    const now = new Date(install.getTime() + 10 * 86400000);
    expect(isStudyEnded(install.toISOString(), 6, now)).toBe(true);
    expect(isStudyEnded(install.toISOString(), 42, now)).toBe(false);
  });
});

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
