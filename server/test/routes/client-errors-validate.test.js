import { describe, it, expect } from "vitest";
import {
  validateClientErrors,
  MAX_ERRORS_PER_REQUEST,
} from "../../routes/client-errors-validate.js";
import { ERROR_CODES } from "../../middleware/responseHandler.js";

function entry(overrides = {}) {
  return {
    code: "QUEUE_CRASHED",
    where: "background.queue.sessions",
    count: 3,
    firstAt: "2026-09-30T01:00:00.000Z",
    lastAt: "2026-09-30T01:10:00.000Z",
    ...overrides,
  };
}

function basePayload(overrides = {}) {
  return {
    anonymousId: "exp-user",
    version: "2.4.1",
    errors: [entry()],
    ...overrides,
  };
}

describe("validateClientErrors — body 형태", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["배열", []],
    ["문자열", "x"],
  ])("body가 %s이면 INVALID_FIELD_VALUE(field: body)", (_label, body) => {
    expect(validateClientErrors(body)).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "body",
    });
  });

  it("정상 payload는 통과한다", () => {
    expect(validateClientErrors(basePayload())).toBeNull();
  });
});

describe("validateClientErrors — anonymousId (선택)", () => {
  it.each([undefined, null])("%s이면 통과한다(등록 전 오류)", (anonymousId) => {
    expect(validateClientErrors(basePayload({ anonymousId }))).toBeNull();
  });

  it.each([
    ["빈 문자열", " "],
    ["숫자", 1],
    ["너무 긺", "a".repeat(101)],
  ])("%s이면 거부한다", (_label, anonymousId) => {
    expect(validateClientErrors(basePayload({ anonymousId }))?.field).toBe(
      "anonymousId",
    );
  });
});

describe("validateClientErrors — version", () => {
  it.each([undefined, "", "v2.4.1", "2.4.1 <script>", 241])(
    "%s이면 거부한다",
    (version) => {
      expect(validateClientErrors(basePayload({ version }))?.field).toBe(
        "version",
      );
    },
  );
});

describe("validateClientErrors — errors 배열", () => {
  it.each([
    ["없음", undefined],
    ["빈 배열", []],
    ["객체", {}],
  ])("%s이면 거부한다", (_label, errors) => {
    expect(validateClientErrors(basePayload({ errors }))?.field).toBe("errors");
  });

  it(`${MAX_ERRORS_PER_REQUEST}건을 넘으면 거부한다`, () => {
    const errors = Array.from({ length: MAX_ERRORS_PER_REQUEST + 1 }, () =>
      entry(),
    );
    expect(validateClientErrors(basePayload({ errors }))?.field).toBe("errors");
  });

  it.each([
    ["목록에 없는 code", { code: "SOMETHING_ELSE" }, "code"],
    ["목록에 없는 where", { where: "https://youtube.com/watch?v=x" }, "where"],
    ["count 0", { count: 0 }, "count"],
    ["count 소수", { count: 1.5 }, "count"],
    ["firstAt 형식 오류", { firstAt: "영상 제목" }, "firstAt"],
    ["lastAt 누락", { lastAt: undefined }, "lastAt"],
  ])("%s이면 해당 필드로 거부한다", (_label, override, name) => {
    const payload = basePayload({ errors: [entry(), entry(override)] });
    expect(validateClientErrors(payload)).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: `errors[1].${name}`,
    });
  });
});
