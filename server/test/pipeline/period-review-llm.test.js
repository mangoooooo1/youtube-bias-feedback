import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildPeriodPrompt,
  generatePeriodReview,
  generatePeriodFallbackReview,
  PROMPT_VERSION,
} from "../../pipeline/period-review-llm.js";

function baseArgs(overrides = {}) {
  return {
    validVideoCount: 20,
    timeDistribution: { 음악: 0.6, 게임: 0.4 },
    categoryDistribution: { 음악: 0.5, 게임: 0.5 },
    titleGroups: [
      {
        category: "음악",
        videoCount: 12,
        titles: [{ title: "아이유 라이브", count: 4 }],
        omittedCount: 0,
      },
    ],
    periodDays: 4,
    ...overrides,
  };
}

describe("buildPeriodPrompt — 입력", () => {
  it("구간 일수, 유효 영상 수, 시청 시간 비중(퍼센트)과 분야별 제목을 넣는다", () => {
    const prompt = buildPeriodPrompt(baseArgs());
    expect(prompt).toContain("이 기간(4일)에 시청한 영상 수: 20개");
    expect(prompt).toContain(
      "분야별 시청 시간 비중:\n  · 음악: 60%\n  · 게임: 40%",
    );
    expect(prompt).toContain("  [음악] 영상 12개\n  · 아이유 라이브 (4번)");
    expect(prompt).not.toContain("다양성 지수:");
  });
});

describe("buildPeriodPrompt — 지침", () => {
  it("유효 영상이 구간 일수 × 2개 미만이면 패턴 단정이 어렵고 정확한 피드백이 아니라는 점을 밝히게 한다", () => {
    const prompt = buildPeriodPrompt(baseArgs({ validVideoCount: 7 }));
    expect(prompt).toContain(
      "이 기간은 시청한 영상이 적어 패턴을 단정하기 어렵습니다",
    );
    expect(prompt).toContain("정확한 피드백은 아니라는 점을 한 문장으로 밝혀");
  });

  it("영상 수가 기준(4일 → 8개) 이상이면 [피드백 작성 지침] 섹션 자체를 넣지 않는다", () => {
    const prompt = buildPeriodPrompt(baseArgs({ validVideoCount: 8 }));
    expect(prompt).not.toContain("[피드백 작성 지침]");
  });

  it("적은 구간 기준은 구간 일수를 따른다(7일 → 14개)", () => {
    const prompt = buildPeriodPrompt(
      baseArgs({ validVideoCount: 13, periodDays: 7 }),
    );
    expect(prompt).toContain("시청한 영상이 적어");
  });

  // 결정 4 — 70% 분기 제거
  it("한 분야 비중이 커도 쏠림 지시를 넣지 않는다", () => {
    const prompt = buildPeriodPrompt(
      baseArgs({ timeDistribution: { 음악: 0.95, 게임: 0.05 } }),
    );
    expect(prompt).not.toContain("한 주제에 크게 모여");
  });

  it("이전 기간과 비교·증감을 언급하지 말라는 지침을 포함한다 (베이스라인 대비가 아니라 종합 서술)", () => {
    const prompt = buildPeriodPrompt(baseArgs());
    expect(prompt).toContain("이전 기간과 비교하거나 증감을 언급하지 마세요");
    expect(prompt).not.toContain("베이스라인");
    expect(prompt).not.toContain("기준이 된 첫 기간");
  });

  it("여러 세션을 개별 나열하지 말고 기간 전체로 요약하라는 지침을 포함한다", () => {
    const prompt = buildPeriodPrompt(baseArgs());
    expect(prompt).toContain("기간 전체를 하나로 요약하세요");
  });

  it("넘겨준 퍼센트만 쓰고 판정·권유 없이, 세부 소재와 업로더 분야 지침을 포함한다", () => {
    const prompt = buildPeriodPrompt(baseArgs());
    expect(prompt).toContain("위에 적힌 퍼센트만 그대로 쓰세요");
    expect(prompt).toContain(
      '"다양하다/편중됐다/쏠렸다"처럼 시청을 판정하는 말',
    );
    expect(prompt).toContain("비중이 가장 큰 분야는 그 퍼센트와 함께 언급");
    expect(prompt).toContain("어떤 소재를 주로 봤는지 제목을 근거로 짚어");
    expect(prompt).toContain("주장이나 논조는 절대 요약·평가하지 마세요");
    expect(prompt).toContain(
      "분야는 영상을 올린 사람이 정한 것이라 내용과 다를 수 있습니다",
    );
  });
});

describe("generatePeriodFallbackReview", () => {
  it("카테고리 데이터가 없으면 topic이 빈 문자열이 아닌 placeholder를 반환한다", () => {
    const result = generatePeriodFallbackReview(
      baseArgs({
        timeDistribution: {},
        categoryDistribution: {},
        validVideoCount: 0,
      }),
    );
    expect(result.topic).toBe("분석 불가");
    expect(result.feedback).toContain("이 기간엔 분석할 시청 기록이 없어요");
    expect(result.source).toBe("fallback");
    expect(result.promptVersion).toBe(PROMPT_VERSION);
  });

  it("영상은 있는데 카테고리를 하나도 모르면 '기록 없음'이 아니라 '분석하지 못했다'고 알린다", () => {
    const result = generatePeriodFallbackReview(
      baseArgs({
        timeDistribution: {},
        categoryDistribution: {},
        validVideoCount: 3,
      }),
    );
    expect(result.topic).toBe("분석 불가");
    expect(result.feedback).toContain("분석하지 못했어요");
    expect(result.feedback).not.toContain("시청 기록이 없어요");
  });

  it("분야가 하나면 유효 영상 수만 사실로 적는다", () => {
    const result = generatePeriodFallbackReview(
      baseArgs({ timeDistribution: { 음악: 1 }, validVideoCount: 10 }),
    );
    expect(result.topic).toBe("음악");
    expect(result.feedback).toBe("이 기간에는 음악 영상을 10개 보셨어요.");
  });

  it("분야가 여럿이면 시청 시간 비중 상위 3개를 숫자로 적는다", () => {
    const result = generatePeriodFallbackReview(
      baseArgs({
        timeDistribution: { 음악: 0.48, 게임: 0.3, 스포츠: 0.12, 교육: 0.1 },
        validVideoCount: 23,
      }),
    );
    expect(result.topic).toBe("음악");
    expect(result.feedback).toBe(
      "이 기간에는 영상 23개를 보셨고, 시청 시간은 음악 48%, 게임 30%, 스포츠 12% 순이었어요.",
    );
  });

  it("한 분야 비중이 커도 판정 문장을 넣지 않는다(결정 4)", () => {
    const result = generatePeriodFallbackReview(
      baseArgs({ timeDistribution: { 음악: 0.9, 게임: 0.1 } }),
    );
    expect(result.feedback).not.toContain("모여");
    expect(result.feedback).not.toContain("집중");
    expect(result.feedback).not.toContain("다양");
  });

  it("유효 영상이 구간 일수 × 2개 미만이면 영상이 적다는 문장을 붙인다", () => {
    const result = generatePeriodFallbackReview(
      baseArgs({ timeDistribution: { 음악: 1 }, validVideoCount: 3 }),
    );
    expect(result.feedback).toBe(
      "이 기간에는 음악 영상을 3개 보셨어요. 영상이 적어 이 기간의 패턴을 정확히 말하기는 어려워요.",
    );
  });

  it("베이스라인 대비 증감 문구는 더 이상 만들지 않는다", () => {
    const result = generatePeriodFallbackReview(baseArgs());
    expect(result.feedback).not.toContain("기준이 된 첫 기간");
    expect(result.feedback).not.toContain("비교의 기준으로 담아 두었어요");
  });
});

describe("generatePeriodReview — 실패 사유 분류 (failureReason 태깅)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("성공 시 topic/feedback을 코드펜스 제거 후 파싱해 반환한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '```json\n{"topic":"과학과 기술","feedback":"관찰 문장"}\n```',
                },
              ],
            },
          },
        ],
      }),
    });

    const result = await generatePeriodReview("prompt", "fake-api-key");
    expect(result).toEqual({
      topic: "과학과 기술",
      feedback: "관찰 문장",
      source: "llm",
      promptVersion: PROMPT_VERSION,
    });
    // 기간 리뷰 전용 키가 세션 리뷰 키와 섞이지 않도록 헤더로 명시 전달되는지 확인
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-goog-api-key": "fake-api-key" }),
      }),
    );
  });

  it("HTTP 오류 응답이면 http_error + httpStatus를 태깅한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "quota exceeded",
    });

    await expect(
      generatePeriodReview("prompt", "fake-api-key"),
    ).rejects.toMatchObject({
      failureReason: "http_error",
      httpStatus: 429,
    });
  });

  it("여러 줄 오류 본문은 한 줄로, 길면 잘라서 로그에 남긴다", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = `{\n  "error": {\n    "message": "${"x".repeat(2000)}"\n  }\n}`;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => body,
    });

    await expect(
      generatePeriodReview("prompt", "fake-api-key"),
    ).rejects.toMatchObject({
      failureReason: "http_error",
    });

    const logged = errorSpy.mock.calls[0].join(" ");
    expect(logged).not.toMatch(/[\r\n]/);
    expect(logged).toContain(`자 중 1000자)`);
    errorSpy.mockRestore();
  });

  it("응답에 텍스트가 없으면 empty_response로 분류한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [] }),
    });

    await expect(
      generatePeriodReview("prompt", "fake-api-key"),
    ).rejects.toMatchObject({
      failureReason: "empty_response",
    });
  });

  it("생성된 feedback/topic에 정치·이념 관련 표현이 감지되면 policy_filtered로 분류한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '{"topic":"정치","feedback":"이 기간은 보수 성향 콘텐츠를 많이 보셨어요."}',
                },
              ],
            },
          },
        ],
      }),
    });

    await expect(
      generatePeriodReview("prompt", "fake-api-key"),
    ).rejects.toMatchObject({
      failureReason: "policy_filtered",
    });
  });

  it("응답 본문 JSON 파싱이 실패하면 parse_error로 분류한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("invalid body json");
      },
    });

    await expect(
      generatePeriodReview("prompt", "fake-api-key"),
    ).rejects.toMatchObject({
      failureReason: "parse_error",
    });
  });

  it("네트워크 예외(abort 아님)는 network_error로 분류한다", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("network down"));

    await expect(
      generatePeriodReview("prompt", "fake-api-key"),
    ).rejects.toMatchObject({
      failureReason: "network_error",
    });
  });

  it("10초 내 응답이 없으면 timeout + timedOut:true로 분류한다", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(
      (_url, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    const promise = generatePeriodReview("prompt", "fake-api-key");
    const assertion = expect(promise).rejects.toMatchObject({
      failureReason: "timeout",
      timedOut: true,
    });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
  });

  it("헤더는 정상 수신했지만 본문 전송이 멈추면 timeout으로 분류한다 (cron 직렬 처리 중 무기한 대기 방지)", async () => {
    vi.useFakeTimers();
    // fetch() 자체는 즉시 resolve(헤더 수신 성공)하지만, response.json()이 abort될 때까지
    // 멈춰 있는 상황 — clearTimeout을 너무 일찍 호출하면 이 본문 읽기가 영원히 안 끝난다.
    global.fetch = vi.fn((_url, opts) =>
      Promise.resolve({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      }),
    );

    const promise = generatePeriodReview("prompt", "fake-api-key");
    const assertion = expect(promise).rejects.toMatchObject({
      failureReason: "timeout",
      timedOut: true,
    });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
  });
});
