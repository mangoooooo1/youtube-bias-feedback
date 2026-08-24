import { describe, it, expect } from "vitest";
import { validateTodayReview } from "../../routes/today-reviews-validate.js";
import { ERROR_CODES } from "../../middleware/responseHandler.js";

function basePayload(overrides = {}) {
  return {
    anonymousId: "exp-user",
    reviewDate: "2026-08-13",
    sessionCount: 2,
    videoCount: 7,
    categoryDistribution: { 게임: 0.6, 뉴스: 0.4 },
    entropy: 0.97,
    review: "오늘은 게임과 뉴스를 두루 보셨네요.",
    reviewTopic: "게임과 뉴스",
    source: "llm",
    promptVersion: "viewlens-today-mirror-v1.0",
    llmStatus: "success",
    failureReason: null,
    geminiMs: 850,
    genCount: 1,
    generatedAt: "2026-08-13T10:00:00+09:00",
    ...overrides,
  };
}

describe("validateTodayReview — 잘못된 형태의 body", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["배열", []],
    ["문자열", "not-an-object"],
    ["숫자", 42],
  ])(
    "body가 %s이면 예외 없이 INVALID_FIELD_VALUE(field: body)를 반환한다",
    (_label, body) => {
      expect(() => validateTodayReview(body)).not.toThrow();
      expect(validateTodayReview(body)).toEqual({
        code: ERROR_CODES.INVALID_FIELD_VALUE,
        field: "body",
      });
    },
  );
});

describe("validateTodayReview", () => {
  it("전체 스냅샷(정상 payload)은 통과한다", () => {
    expect(validateTodayReview(basePayload())).toBeNull();
  });

  it("failureReason이 null(성공 케이스)이어도 통과한다", () => {
    expect(
      validateTodayReview(basePayload({ failureReason: null })),
    ).toBeNull();
  });

  // today_reviews는 전체 스냅샷을 통째로 upsert하는 테이블이라, 이 필드들이 빠지면
  // 기존 행의 값을 null로 덮어쓰게 된다(부분 갱신 미지원) — 그래서 요청 단계에서 막아야 한다.
  const snapshotFields = [
    "sessionCount",
    "videoCount",
    "categoryDistribution",
    "entropy",
    "review",
    "reviewTopic",
    "source",
    "promptVersion",
    "llmStatus",
    "geminiMs",
    "genCount",
  ];

  it.each(snapshotFields)(
    "%s가 빠진 부분 payload는 MISSING_REQUIRED_FIELD로 거부한다",
    (field) => {
      const payload = basePayload();
      delete payload[field];

      const result = validateTodayReview(payload);
      expect(result).toEqual({
        code: ERROR_CODES.MISSING_REQUIRED_FIELD,
        field,
      });
    },
  );

  it("anonymousId/reviewDate/generatedAt이 빠지면 MISSING_REQUIRED_FIELD로 거부한다", () => {
    for (const field of ["anonymousId", "reviewDate", "generatedAt"]) {
      const payload = basePayload();
      delete payload[field];
      expect(validateTodayReview(payload)).toEqual({
        code: ERROR_CODES.MISSING_REQUIRED_FIELD,
        field,
      });
    }
  });

  it("reviewDate 형식이 YYYY-MM-DD가 아니면 거부한다", () => {
    const result = validateTodayReview(
      basePayload({ reviewDate: "2026/08/13" }),
    );
    expect(result).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "reviewDate",
    });
  });

  it("source가 허용된 값이 아니면 거부한다", () => {
    const result = validateTodayReview(basePayload({ source: "unknown" }));
    expect(result).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "source",
    });
  });

  it("videoCount가 음수면 거부한다", () => {
    const result = validateTodayReview(basePayload({ videoCount: -1 }));
    expect(result).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "videoCount",
    });
  });

  it("failureReason이 허용 목록에 없는 값이면 거부한다", () => {
    const result = validateTodayReview(
      basePayload({ failureReason: "unknown_reason" }),
    );
    expect(result).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "failureReason",
    });
  });
});
