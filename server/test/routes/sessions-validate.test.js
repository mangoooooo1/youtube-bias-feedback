import { describe, it, expect } from "vitest";
import { validateSession } from "../../routes/sessions-validate.js";
import { ERROR_CODES } from "../../middleware/responseHandler.js";

function basePayload(overrides = {}) {
  return {
    anonymousId: "exp-user",
    sessionId: "s1",
    startTime: "2026-08-13T09:00:00+09:00",
    endTime: "2026-08-13T09:10:00+09:00",
    videoCount: 3,
    videoIds: ["v1", "v2", "v3"],
    totalMs: 1200,
    youtubeMs: 300,
    geminiMs: 850,
    llmStatus: "success",
    failureReason: null,
    httpStatus: null,
    timedOut: 0,
    feedbackNotifiedAt: null,
    review: "오늘은 게임과 뉴스를 두루 보셨네요.",
    reviewTopic: "게임과 뉴스",
    source: "llm",
    promptVersion: "viewlens-today-mirror-v1.0",
    ...overrides,
  };
}

describe("validateSession — 잘못된 형태의 body", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["배열", []],
    ["문자열", "not-an-object"],
    ["숫자", 42],
  ])(
    "body가 %s이면 예외 없이 INVALID_FIELD_VALUE(field: body)를 반환한다",
    (_label, body) => {
      expect(() => validateSession(body)).not.toThrow();
      expect(validateSession(body)).toEqual({
        code: ERROR_CODES.INVALID_FIELD_VALUE,
        field: "body",
      });
    },
  );
});

describe("validateSession — 필수 필드", () => {
  it("최소 필수 필드(anonymousId/sessionId/startTime/endTime/videoIds)만 있어도 통과한다", () => {
    expect(
      validateSession({
        anonymousId: "exp-user",
        sessionId: "s1",
        startTime: "2026-08-13T09:00:00+09:00",
        endTime: "2026-08-13T09:10:00+09:00",
        videoIds: [],
      }),
    ).toBeNull();
  });

  it("전체 스냅샷(정상 payload)은 통과한다", () => {
    expect(validateSession(basePayload())).toBeNull();
  });

  it.each(["anonymousId", "sessionId", "startTime", "endTime"])(
    "%s가 빠지면 MISSING_REQUIRED_FIELD로 거부한다",
    (field) => {
      const payload = basePayload();
      delete payload[field];
      expect(validateSession(payload)).toEqual({
        code: ERROR_CODES.MISSING_REQUIRED_FIELD,
        field,
      });
    },
  );

  it.each(["anonymousId", "sessionId", "startTime", "endTime"])(
    "%s가 빈 문자열이면 MISSING_REQUIRED_FIELD로 거부한다",
    (field) => {
      const result = validateSession(basePayload({ [field]: "  " }));
      expect(result).toEqual({
        code: ERROR_CODES.MISSING_REQUIRED_FIELD,
        field,
      });
    },
  );

  // PATCH /:sessionId/feedback-viewed 등(sessions.js)의 anonymousId 검증은
  // typeof === "string"을 요구한다 — POST도 같은 계약을 지켜야 한다.
  it.each(["anonymousId", "sessionId"])(
    "%s가 숫자면 MISSING_REQUIRED_FIELD로 거부한다(문자열이 아님)",
    (field) => {
      const result = validateSession(basePayload({ [field]: 12345 }));
      expect(result).toEqual({
        code: ERROR_CODES.MISSING_REQUIRED_FIELD,
        field,
      });
    },
  );

  it("anonymousId가 객체면 MISSING_REQUIRED_FIELD로 거부한다(문자열이 아님)", () => {
    const result = validateSession(basePayload({ anonymousId: {} }));
    expect(result).toEqual({
      code: ERROR_CODES.MISSING_REQUIRED_FIELD,
      field: "anonymousId",
    });
  });
});

describe("validateSession — 날짜/숫자 형식", () => {
  it.each(["startTime", "endTime"])(
    "%s가 파싱 불가능한 문자열이면 거부한다",
    (field) => {
      const result = validateSession(basePayload({ [field]: "not-a-date" }));
      expect(result).toEqual({
        code: ERROR_CODES.INVALID_FIELD_VALUE,
        field,
      });
    },
  );

  it("endTime이 startTime보다 이르면 거부한다(음수 기간 방지, 회귀)", () => {
    const result = validateSession(
      basePayload({
        startTime: "2026-08-13T09:10:00+09:00",
        endTime: "2026-08-13T09:00:00+09:00",
      }),
    );
    expect(result).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "endTime",
    });
  });

  it("endTime이 startTime과 같으면 통과한다(0초 세션, 경계값)", () => {
    expect(
      validateSession(
        basePayload({
          startTime: "2026-08-13T09:00:00+09:00",
          endTime: "2026-08-13T09:00:00+09:00",
        }),
      ),
    ).toBeNull();
  });

  it("videoCount가 0이면 통과한다(경계값)", () => {
    expect(validateSession(basePayload({ videoCount: 0 }))).toBeNull();
  });

  it("videoCount가 음수면 거부한다", () => {
    expect(validateSession(basePayload({ videoCount: -1 }))).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "videoCount",
    });
  });

  it("videoCount가 정수가 아니면 거부한다", () => {
    expect(validateSession(basePayload({ videoCount: 1.5 }))).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "videoCount",
    });
  });

  it.each(["totalMs", "geminiMs"])(
    "%s가 음수면 거부한다(지연시간 필드)",
    (field) => {
      expect(validateSession(basePayload({ [field]: -1 }))).toEqual({
        code: ERROR_CODES.INVALID_FIELD_VALUE,
        field,
      });
    },
  );

  it.each(["totalMs", "geminiMs"])(
    "%s가 null이면 허용한다(구버전 확장 하위호환)",
    (field) => {
      expect(validateSession(basePayload({ [field]: null }))).toBeNull();
    },
  );

  it("youtubeMs는 더 이상 검증하지 않는다(categoryId 조회가 서버로 이관돼 서버가 직접 측정)", () => {
    expect(validateSession(basePayload({ youtubeMs: -1 }))).toBeNull();
  });
});

describe("validateSession — videoIds", () => {
  it("videoIds가 없으면 MISSING_REQUIRED_FIELD로 거부한다", () => {
    const payload = basePayload();
    delete payload.videoIds;
    expect(validateSession(payload)).toEqual({
      code: ERROR_CODES.MISSING_REQUIRED_FIELD,
      field: "videoIds",
    });
  });

  it("videoIds가 배열이 아니면 MISSING_REQUIRED_FIELD로 거부한다", () => {
    expect(validateSession(basePayload({ videoIds: "v1" }))).toEqual({
      code: ERROR_CODES.MISSING_REQUIRED_FIELD,
      field: "videoIds",
    });
  });

  it("빈 배열이면 통과한다(시청 영상이 0개인 경계값)", () => {
    expect(validateSession(basePayload({ videoIds: [] }))).toBeNull();
  });

  it("videoIds 안에 재시청으로 인한 중복이 있어도 통과한다", () => {
    expect(
      validateSession(basePayload({ videoIds: ["v1", "v1", "v2"] })),
    ).toBeNull();
  });

  it.each([
    { label: "숫자 원소", videoIds: [1, 2] },
    { label: "null 원소", videoIds: [null] },
    { label: "빈 문자열 원소", videoIds: [""] },
    { label: "공백뿐인 문자열 원소", videoIds: [" "] },
  ])(
    "videoIds에 $label이 있으면 INVALID_FIELD_VALUE로 거부한다",
    ({ videoIds }) => {
      expect(validateSession(basePayload({ videoIds }))).toEqual({
        code: ERROR_CODES.INVALID_FIELD_VALUE,
        field: "videoIds",
      });
    },
  );

  // /api/sessions는 인증·rateLimiter가 없어, 개수 제한이 없으면
  // 한 요청이 YouTube API를 수백 번 순차 호출하게 만들 수 있다(DoS/쿼터 낭비 벡터).
  it("videoIds가 500개를 넘으면 INVALID_FIELD_VALUE로 거부한다", () => {
    const videoIds = Array.from({ length: 501 }, (_, i) => `v${i}`);
    expect(validateSession(basePayload({ videoIds }))).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "videoIds",
    });
  });

  it("videoIds가 정확히 500개면 통과한다(경계값)", () => {
    const videoIds = Array.from({ length: 500 }, (_, i) => `v${i}`);
    expect(validateSession(basePayload({ videoIds }))).toBeNull();
  });
});

describe("validateSession — LLM 폴백 로깅 분류값", () => {
  it.each(["success", "fallback"])(
    "llmStatus가 %s이면 통과한다",
    (llmStatus) => {
      expect(validateSession(basePayload({ llmStatus }))).toBeNull();
    },
  );

  it("llmStatus가 허용 목록에 없는 값이면 거부한다", () => {
    expect(validateSession(basePayload({ llmStatus: "unknown" }))).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "llmStatus",
    });
  });

  it.each([
    "timeout",
    "http_error",
    "empty_response",
    "parse_error",
    "network_error",
    "policy_filtered",
  ])("failureReason이 %s이면 통과한다", (failureReason) => {
    expect(validateSession(basePayload({ failureReason }))).toBeNull();
  });

  it("failureReason이 허용 목록에 없는 값이면 거부한다", () => {
    expect(
      validateSession(basePayload({ failureReason: "unknown_reason" })),
    ).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "failureReason",
    });
  });

  it("httpStatus가 음수면 거부한다", () => {
    expect(validateSession(basePayload({ httpStatus: -1 }))).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "httpStatus",
    });
  });

  it.each([0, 1])("timedOut이 %i이면 통과한다", (timedOut) => {
    expect(validateSession(basePayload({ timedOut }))).toBeNull();
  });

  it.each([2, true, "1"])("timedOut이 %p이면 거부한다", (timedOut) => {
    expect(validateSession(basePayload({ timedOut }))).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "timedOut",
    });
  });

  it("feedbackNotifiedAt이 파싱 불가능한 문자열이면 거부한다", () => {
    expect(
      validateSession(basePayload({ feedbackNotifiedAt: "not-a-date" })),
    ).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "feedbackNotifiedAt",
    });
  });
});

describe("validateSession — 생성된 피드백 텍스트", () => {
  it.each(["review", "reviewTopic", "promptVersion"])(
    "%s가 빈 문자열이면 거부한다(구버전은 null만 허용, 빈 문자열은 결함 신호)",
    (field) => {
      expect(validateSession(basePayload({ [field]: "" }))).toEqual({
        code: ERROR_CODES.INVALID_FIELD_VALUE,
        field,
      });
    },
  );

  it.each(["review", "reviewTopic", "promptVersion"])(
    "%s가 null이면 허용한다(구버전 확장 하위호환)",
    (field) => {
      expect(validateSession(basePayload({ [field]: null }))).toBeNull();
    },
  );

  it("source가 허용된 값이 아니면 거부한다", () => {
    expect(validateSession(basePayload({ source: "unknown" }))).toEqual({
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      field: "source",
    });
  });

  it("source가 null이면 허용한다(구버전 확장 하위호환)", () => {
    expect(validateSession(basePayload({ source: null }))).toBeNull();
  });
});
