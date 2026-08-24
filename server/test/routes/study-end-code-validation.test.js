import { describe, it, expect } from "vitest";
import { isValidStudyEndCode } from "../../routes/study-end-code-validation.js";

describe("isValidStudyEndCode", () => {
  it("입력 코드와 서버 코드가 일치하면 true를 반환한다", () => {
    expect(isValidStudyEndCode("ABCD1234", "ABCD1234")).toBe(true);
  });

  it("대소문자가 달라도 일치로 처리한다", () => {
    expect(isValidStudyEndCode("abcd1234", "ABCD1234")).toBe(true);
  });

  it("앞뒤 공백은 무시한다", () => {
    expect(isValidStudyEndCode("  ABCD1234  ", "ABCD1234")).toBe(true);
  });

  it("일치하지 않으면 false를 반환한다", () => {
    expect(isValidStudyEndCode("WRONG", "ABCD1234")).toBe(false);
  });

  it("서버 코드가 설정되지 않았으면(빈 값) 항상 false를 반환한다 — 통과 폴백 없음", () => {
    expect(isValidStudyEndCode("ANYTHING", "")).toBe(false);
    expect(isValidStudyEndCode("ANYTHING", undefined)).toBe(false);
  });

  it("입력 코드가 빈 값이어도 안전하게 false를 반환한다", () => {
    expect(isValidStudyEndCode("", "ABCD1234")).toBe(false);
    expect(isValidStudyEndCode(null, "ABCD1234")).toBe(false);
  });
});
