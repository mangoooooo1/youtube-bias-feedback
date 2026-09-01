import { describe, it, expect } from "vitest";
import { validateVideoEvent } from "../../routes/video-events-validate.js";
import { ERROR_CODES } from "../../middleware/responseHandler.js";

function basePayload(overrides = {}) {
  return {
    anonymousId: "exp-user",
    videoId: "dQw4w9WgXcQ",
    watchedAt: "2026-08-13T10:00:00+09:00",
    title: "영상 제목",
    sessionId: "s1",
    ...overrides,
  };
}

describe("validateVideoEvent — 잘못된 형태의 body", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["배열", []],
    ["문자열", "not-an-object"],
    ["숫자", 42],
  ])("body가 %s이면 예외 없이 INVALID_FIELD_VALUE(field: body)를 반환한다", (_label, body) => {
    expect(() => validateVideoEvent(body)).not.toThrow();
    expect(validateVideoEvent(body)).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "body",
    });
  });
});

describe("validateVideoEvent — 필수 필드 (anonymousId/videoId/watchedAt)", () => {
  it("모든 필수 필드가 채워진 정상 payload는 통과한다", () => {
    expect(validateVideoEvent(basePayload())).toBeNull();
  });

  it.each(["anonymousId", "videoId", "watchedAt"])(
    "%s가 없으면 MISSING_REQUIRED_FIELD를 반환한다",
    (field) => {
      const payload = basePayload();
      delete payload[field];
      expect(validateVideoEvent(payload)).toEqual({
        code: ERROR_CODES.MISSING_REQUIRED_FIELD,
        field,
      });
    },
  );

  it.each(["anonymousId", "videoId", "watchedAt"])(
    "%s가 빈 문자열이면 MISSING_REQUIRED_FIELD를 반환한다",
    (field) => {
      expect(validateVideoEvent(basePayload({ [field]: "" }))).toEqual({
        code: ERROR_CODES.MISSING_REQUIRED_FIELD,
        field,
      });
    },
  );

  it.each(["anonymousId", "videoId", "watchedAt"])(
    "%s가 공백만 있으면 MISSING_REQUIRED_FIELD를 반환한다",
    (field) => {
      expect(validateVideoEvent(basePayload({ [field]: "   " }))).toEqual({
        code: ERROR_CODES.MISSING_REQUIRED_FIELD,
        field,
      });
    },
  );

  it.each(["anonymousId", "videoId", "watchedAt"])(
    "%s가 문자열이 아니면(숫자) MISSING_REQUIRED_FIELD를 반환한다",
    (field) => {
      expect(validateVideoEvent(basePayload({ [field]: 123 }))).toEqual({
        code: ERROR_CODES.MISSING_REQUIRED_FIELD,
        field,
      });
    },
  );
});

describe("validateVideoEvent — watchedAt 형식", () => {
  it("파싱 불가능한 문자열이면 INVALID_FIELD_VALUE(watchedAt)를 반환한다", () => {
    expect(validateVideoEvent(basePayload({ watchedAt: "not-a-date" }))).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "watchedAt",
    });
  });
});

describe("validateVideoEvent — sessionId (옵션 필드, 하위호환)", () => {
  it.each([undefined, null])("%s이면 통과한다(구버전 확장 하위호환)", (value) => {
    expect(validateVideoEvent(basePayload({ sessionId: value }))).toBeNull();
  });

  it("빈 문자열이면 거부한다", () => {
    expect(validateVideoEvent(basePayload({ sessionId: "" }))).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "sessionId",
    });
  });

  it("공백만 있으면 거부한다", () => {
    expect(validateVideoEvent(basePayload({ sessionId: "   " }))).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "sessionId",
    });
  });

  it("문자열이 아니면(숫자) 거부한다", () => {
    expect(validateVideoEvent(basePayload({ sessionId: 123 }))).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "sessionId",
    });
  });

  it("유효한 문자열이면 통과한다", () => {
    expect(validateVideoEvent(basePayload({ sessionId: "s-abc" }))).toBeNull();
  });
});

describe("validateVideoEvent — eventId (옵션 필드, 멱등 키·하위호환)", () => {
  it.each([undefined, null])("%s이면 통과한다(구버전 확장 하위호환)", (value) => {
    expect(validateVideoEvent(basePayload({ eventId: value }))).toBeNull();
  });

  it("빈 문자열이면 거부한다", () => {
    expect(validateVideoEvent(basePayload({ eventId: "" }))).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "eventId",
    });
  });

  it("문자열이 아니면(boolean) 거부한다 — better-sqlite3에 그대로 바인딩하면 TypeError로 500이 난다", () => {
    expect(validateVideoEvent(basePayload({ eventId: true }))).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "eventId",
    });
  });

  it("문자열이 아니면(object) 거부한다", () => {
    expect(validateVideoEvent(basePayload({ eventId: { x: 1 } }))).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "eventId",
    });
  });

  it("유효한 문자열이면 통과한다", () => {
    expect(
      validateVideoEvent(basePayload({ eventId: "evt-abc" })),
    ).toBeNull();
  });
});

describe("validateVideoEvent — title (옵션, 검증 대상 아님)", () => {
  it("title이 없어도 통과한다", () => {
    const payload = basePayload();
    delete payload.title;
    expect(validateVideoEvent(payload)).toBeNull();
  });
});
