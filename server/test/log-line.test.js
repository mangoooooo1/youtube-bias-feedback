import { describe, it, expect } from "vitest";
import { oneLine, formatStack } from "../log-line.js";

describe("oneLine — 외부 문자열을 로그 한 줄로", () => {
  it("줄바꿈(\\n, \\r\\n, \\r)을 \\n 문자로 바꾼다", () => {
    expect(oneLine("a\nb\r\nc\rd")).toBe("a\\nb\\nc\\nd");
  });

  it("줄바꿈이 없으면 그대로라 기존 로그 모양과 지문이 바뀌지 않는다", () => {
    expect(oneLine('DB 오류: "x" 실패')).toBe('DB 오류: "x" 실패');
  });

  it("문자열이 아니어도 문자열로 바꿔 처리한다", () => {
    expect(oneLine(undefined)).toBe("undefined");
    expect(oneLine(42)).toBe("42");
  });
});

describe("formatStack — 스택을 줄 끝에 붙일 한 줄 문자열로", () => {
  it("Error가 아니거나 스택이 없으면 빈 문자열이다", () => {
    expect(formatStack("문자열 reject")).toBe("");
    expect(formatStack(undefined)).toBe("");
    const noStack = new Error("x");
    noStack.stack = undefined;
    expect(formatStack(noStack)).toBe("");
  });

  it("스택 속 줄바꿈이 이스케이프되어 다른 로그 줄을 위조할 수 없다", () => {
    const err = new Error("x");
    err.stack = "Error: x\n[Error] 위조된 줄";
    const suffix = formatStack(err);
    expect(suffix).not.toContain("\n");
    expect(suffix).toBe(' stack="Error: x\\n[Error] 위조된 줄"');
  });
});
