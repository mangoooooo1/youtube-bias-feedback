import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildTodayCumulativePrompt,
  generateTodayReview,
  generateTodayFallbackReview,
  TODAY_PROMPT_VERSION,
} from "../../pipeline/today-review-llm.js";

// 이 파일은 원래 extension/pipeline/llm.js에서 확장 프로그램이 직접 Gemini를 호출하던
// "오늘" 리뷰 로직을 서버로 이식한 것이다(연구 무결성 점검 항목 1 후속 조치, Stage 2a).
// 확장 프로그램 쪽 원본은 Stage 2c에서 완전히 제거됐으므로(더 이상 클라이언트가 Gemini를
// 직접 부르지 않음), 지금부터는 서버 버전 단독으로 프롬프트·폴백 문구를 검증한다
// (이식 당시의 문구 동치성은 git 이력의 이전 버전에 남아 있다).
function baseArgs(overrides = {}) {
  return {
    categoryDistribution: { 음악: 0.6, 게임: 0.4 },
    entropy: 0.97,
    videoCount: 10,
    ...overrides,
  };
}

describe("buildTodayCumulativePrompt — 추세 문구 경계값 (buildTodayTrendGuidance)", () => {
  it("videoCount가 5 미만이면 '패턴 단정 어려움' 문구만 넣는다", () => {
    const prompt = buildTodayCumulativePrompt(baseArgs({ videoCount: 4 }));
    expect(prompt).toContain(
      "오늘은 시청한 영상 수가 적어 패턴을 단정하기 어렵습니다",
    );
    expect(prompt).not.toContain("한 주제에 크게 모여 있습니다");
  });

  it("직전 시청일보다 entropy가 늘면 '다양해졌다' 문구를 넣는다", () => {
    const prompt = buildTodayCumulativePrompt(
      baseArgs({ entropy: 1.5, prevEntropy: 0.5 }),
    );
    expect(prompt).toContain("여러 주제로 다양해졌습니다");
  });

  it("직전 시청일보다 entropy가 줄면 '더 적은 수의 주제' 문구를 넣는다", () => {
    const prompt = buildTodayCumulativePrompt(
      baseArgs({ entropy: 0.3, prevEntropy: 1.5 }),
    );
    expect(prompt).toContain("더 적은 수의 주제에 모였습니다");
  });

  it("직전 시청일과 변화가 미미하면(delta < eps) '비슷한 다양성' 문구를 넣는다", () => {
    const prompt = buildTodayCumulativePrompt(
      baseArgs({ entropy: 0.97, prevEntropy: 0.95 }),
    );
    expect(prompt).toContain("직전 시청일과 비슷한 다양성을 유지");
  });

  it("top 카테고리 비율이 0.7 이상이면 편중 경고 문구를 추가한다", () => {
    const prompt = buildTodayCumulativePrompt(
      baseArgs({ categoryDistribution: { 음악: 0.8, 게임: 0.2 } }),
    );
    expect(prompt).toContain("시청이 한 주제에 크게 모여 있습니다");
  });

  it("카테고리가 1개뿐이면 '최대 entropy' 값을 표기하지 않는다", () => {
    const prompt = buildTodayCumulativePrompt(
      baseArgs({ categoryDistribution: { 음악: 1 }, entropy: 0 }),
    );
    expect(prompt).toContain("다양성 지수: 0");
    expect(prompt).not.toContain("최대");
  });

  it("영상 제목이 있으면 상위 10개까지만 프롬프트에 포함한다", () => {
    const titles = Array.from({ length: 15 }, (_, i) => `영상${i}`);
    const prompt = buildTodayCumulativePrompt(
      baseArgs({ videoTitles: titles }),
    );
    expect(prompt).toContain("영상0");
    expect(prompt).toContain("영상9");
    expect(prompt).not.toContain("영상10");
  });

  it("오늘 하루 전체를 하나로 요약하라는 지침을 포함한다(세션별 나열 금지)", () => {
    const prompt = buildTodayCumulativePrompt(baseArgs());
    expect(prompt).toContain("오늘 하루 전체를 하나로 요약하세요");
  });
});

describe("generateTodayFallbackReview", () => {
  it("카테고리 데이터가 없으면 topic이 빈 문자열이 아닌 placeholder를 반환한다", () => {
    const result = generateTodayFallbackReview(
      baseArgs({ categoryDistribution: {}, videoCount: 0 }),
    );
    expect(result.topic).toBe("분석 불가");
    expect(result.feedback).toContain(
      "오늘의 시청 데이터를 분석하지 못했습니다",
    );
    expect(result.source).toBe("fallback");
    expect(result.promptVersion).toBe(TODAY_PROMPT_VERSION);
  });

  it("카테고리가 1개뿐이면 집중 시청 문구를 만든다", () => {
    const result = generateTodayFallbackReview(
      baseArgs({ categoryDistribution: { 음악: 1 }, videoCount: 3 }),
    );
    expect(result.topic).toBe("음악");
    expect(result.feedback).toContain("음악 영상을 3개 집중적으로 시청");
  });

  it("top 비율이 0.5 초과면 top 2개를 언급하는 문구를 만든다", () => {
    const result = generateTodayFallbackReview(
      baseArgs({
        categoryDistribution: { 음악: 0.6, 게임: 0.4 },
        videoCount: 10,
      }),
    );
    expect(result.feedback).toContain("주로 음악 영상을 보셨고");
  });

  it("top 비율이 0.5 이하면 '다양한 카테고리' 문구를 만든다", () => {
    const result = generateTodayFallbackReview(
      baseArgs({
        categoryDistribution: { 음악: 0.4, 게임: 0.35, 교육: 0.25 },
        videoCount: 10,
      }),
    );
    expect(result.feedback).toContain("다양한 카테고리의 영상을");
  });

  it("videoCount가 MIN_VIDEOS_FOR_TREND 이상이고 편중이 있으면 편중 문구를 넣는다", () => {
    const result = generateTodayFallbackReview(
      baseArgs({
        categoryDistribution: { 음악: 0.9, 게임: 0.1 },
        videoCount: 10,
        prevEntropy: 0.2,
      }),
    );
    expect(result.feedback).toContain(
      "특히 시청이 한 주제에 크게 모여 있었어요",
    );
  });

  it("videoCount가 MIN_VIDEOS_FOR_TREND 미만이면 추세·편중 문구를 넣지 않는다", () => {
    const result = generateTodayFallbackReview(
      baseArgs({
        categoryDistribution: { 음악: 0.9, 게임: 0.1 },
        videoCount: 2,
      }),
    );
    expect(result.feedback).not.toContain("한 주제에 크게 모여");
    expect(result.feedback).not.toContain("여러 주제를 두루");
  });
});

describe("generateTodayReview — 실패 사유 분류 (failureReason 태깅)", () => {
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

    const result = await generateTodayReview("prompt", "fake-api-key");
    expect(result).toEqual({
      topic: "과학과 기술",
      feedback: "관찰 문장",
      source: "llm",
      promptVersion: TODAY_PROMPT_VERSION,
    });
    // 오늘 리뷰 전용 키가 기간 리뷰 키와 섞이지 않도록 헤더로 명시 전달되는지 확인
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
      generateTodayReview("prompt", "fake-api-key"),
    ).rejects.toMatchObject({
      failureReason: "http_error",
      httpStatus: 429,
    });
  });

  it("응답에 텍스트가 없으면 empty_response로 분류한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [] }),
    });

    await expect(
      generateTodayReview("prompt", "fake-api-key"),
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
                  text: '{"topic":"정치","feedback":"오늘은 보수 성향 콘텐츠를 많이 보셨어요."}',
                },
              ],
            },
          },
        ],
      }),
    });

    await expect(
      generateTodayReview("prompt", "fake-api-key"),
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
      generateTodayReview("prompt", "fake-api-key"),
    ).rejects.toMatchObject({
      failureReason: "parse_error",
    });
  });

  it("네트워크 예외(abort 아님)는 network_error로 분류한다", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("network down"));

    await expect(
      generateTodayReview("prompt", "fake-api-key"),
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

    const promise = generateTodayReview("prompt", "fake-api-key");
    const assertion = expect(promise).rejects.toMatchObject({
      failureReason: "timeout",
      timedOut: true,
    });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
  });

  it("헤더는 정상 수신했지만 본문 전송이 멈추면 timeout으로 분류한다 (POST /api/sessions 무기한 대기 방지)", async () => {
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

    const promise = generateTodayReview("prompt", "fake-api-key");
    const assertion = expect(promise).rejects.toMatchObject({
      failureReason: "timeout",
      timedOut: true,
    });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
  });
});
