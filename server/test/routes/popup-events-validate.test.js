import { describe, it, expect } from "vitest";
import { validatePopupEvent } from "../../routes/popup-events-validate.js";
import { ERROR_CODES } from "../../middleware/responseHandler.js";

function basePayload(overrides = {}) {
  return {
    eventId: "evt-1",
    anonymousId: "exp-user",
    dwellMs: 4200,
    tabTodayClicks: 2,
    tabWeekClicks: 1,
    feedbackViewed: 1,
    openedAt: "2026-08-13T10:00:00+09:00",
    ...overrides,
  };
}

describe("validatePopupEvent — 잘못된 형태의 body", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["배열", []],
    ["문자열", "not-an-object"],
    ["숫자", 42],
  ])("body가 %s이면 예외 없이 INVALID_FIELD_VALUE(field: body)를 반환한다", (_label, body) => {
    expect(() => validatePopupEvent(body)).not.toThrow();
    expect(validatePopupEvent(body)).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "body",
    });
  });
});

describe("validatePopupEvent — anonymousId", () => {
  it("anonymousId만 있는 최소 payload는 통과한다", () => {
    expect(validatePopupEvent({ anonymousId: "exp-user" })).toBeNull();
  });

  it.each([
    ["없음", undefined],
    ["null", null],
    ["빈 문자열", ""],
    ["공백만", "   "],
    ["숫자", 123],
  ])("anonymousId가 %s이면 MISSING_REQUIRED_FIELD를 반환한다", (_label, value) => {
    expect(validatePopupEvent(basePayload({ anonymousId: value }))).toEqual({
      code: ERROR_CODES.MISSING_REQUIRED_FIELD,
      field: "anonymousId",
    });
  });
});

describe("validatePopupEvent — 카운트 필드 (dwellMs/tabTodayClicks/tabWeekClicks)", () => {
  it.each(["dwellMs", "tabTodayClicks", "tabWeekClicks"])(
    "%s는 미전송(undefined)이면 통과한다(하위호환)",
    (field) => {
      const payload = basePayload({ [field]: undefined });
      expect(validatePopupEvent(payload)).toBeNull();
    },
  );

  it.each(["dwellMs", "tabTodayClicks", "tabWeekClicks"])(
    "%s는 null이면 통과한다(하위호환)",
    (field) => {
      expect(validatePopupEvent(basePayload({ [field]: null }))).toBeNull();
    },
  );

  it.each(["dwellMs", "tabTodayClicks", "tabWeekClicks"])(
    "%s는 0이면 허용한다(경계값)",
    (field) => {
      expect(validatePopupEvent(basePayload({ [field]: 0 }))).toBeNull();
    },
  );

  it.each(["dwellMs", "tabTodayClicks", "tabWeekClicks"])(
    "%s가 음수면 거부한다",
    (field) => {
      expect(validatePopupEvent(basePayload({ [field]: -1 }))).toEqual({
        code: ERROR_CODES.INVALID_FIELD_VALUE,
        field,
      });
    },
  );

  it.each(["dwellMs", "tabTodayClicks", "tabWeekClicks"])(
    "%s가 정수가 아니면(실수) 거부한다",
    (field) => {
      expect(validatePopupEvent(basePayload({ [field]: 1.5 }))).toEqual({
        code: ERROR_CODES.INVALID_FIELD_VALUE,
        field,
      });
    },
  );

  it.each(["dwellMs", "tabTodayClicks", "tabWeekClicks"])(
    "%s가 숫자 문자열이면 거부한다(타입 강제 변환 없음)",
    (field) => {
      expect(validatePopupEvent(basePayload({ [field]: "10" }))).toEqual({
        code: ERROR_CODES.INVALID_FIELD_VALUE,
        field,
      });
    },
  );
});

describe("validatePopupEvent — feedbackViewed", () => {
  it.each([undefined, null])("%s이면 통과한다(하위호환)", (value) => {
    expect(validatePopupEvent(basePayload({ feedbackViewed: value }))).toBeNull();
  });

  it.each([0, 1])("%i는 허용한다", (value) => {
    expect(validatePopupEvent(basePayload({ feedbackViewed: value }))).toBeNull();
  });

  it.each([2, -1, true, "1"])("%p는 거부한다(0/1 외 값)", (value) => {
    expect(validatePopupEvent(basePayload({ feedbackViewed: value }))).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "feedbackViewed",
    });
  });
});

describe("validatePopupEvent — openedAt", () => {
  it.each([undefined, null])("%s이면 통과한다(하위호환)", (value) => {
    expect(validatePopupEvent(basePayload({ openedAt: value }))).toBeNull();
  });

  it("파싱 가능한 날짜 문자열이면 통과한다", () => {
    expect(
      validatePopupEvent(basePayload({ openedAt: "2026-08-13T10:00:00+09:00" })),
    ).toBeNull();
  });

  it("파싱 불가능한 문자열이면 거부한다", () => {
    expect(validatePopupEvent(basePayload({ openedAt: "not-a-date" }))).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "openedAt",
    });
  });
});
