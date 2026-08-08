import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildPrompt,
  generateReview,
  generateFallbackReview,
  PROMPT_VERSION,
} from "../../pipeline/llm.js";

function baseArgs(overrides = {}) {
  return {
    categoryDistribution: { 음악: 0.6, 게임: 0.4 },
    entropy: 0.97,
    videoCount: 10,
    ...overrides,
  };
}

describe("buildPrompt — 트렌드 문구 경계값 (buildTrendGuidance)", () => {
  it("videoCount가 5 미만이면 '패턴 단정 어려움' 문구만 넣는다", () => {
    const prompt = buildPrompt(baseArgs({ videoCount: 4, prevEntropy: 0.5 }));
    expect(prompt).toContain("시청한 영상 수가 적어 패턴을 단정하기 어렵습니다");
    // 영상 수가 적을 때는 편중 경고·증감 비교를 하지 않는다
    expect(prompt).not.toContain("여러 주제로 다양해졌습니다");
  });

  it("직전 대비 entropy delta가 +0.1 이상이면 '다양해졌다' 문구를 넣는다", () => {
    const prompt = buildPrompt(
      baseArgs({ videoCount: 5, entropy: 1.5, prevEntropy: 1.0 }),
    );
    expect(prompt).toContain("직전 세션보다 시청이 여러 주제로 다양해졌습니다");
  });

  it("다양성 증가/감소 문구는 방향과 무관하게 같은 강도(부드럽고 또렷하게)를 쓴다", () => {
    const increased = buildPrompt(
      baseArgs({ videoCount: 5, entropy: 1.5, prevEntropy: 1.0 }),
    );
    const decreased = buildPrompt(
      baseArgs({ videoCount: 5, entropy: 0.5, prevEntropy: 1.0 }),
    );
    expect(increased).toContain("다양해졌습니다. 이 변화를 부드럽고 또렷하게 사실로");
    expect(decreased).toContain("모였습니다. 이 변화를 부드럽고 또렷하게 사실로");
  });

  it("직전 대비 entropy delta가 -0.1 이하이면 '적은 주제에 모였다' 문구를 넣는다", () => {
    const prompt = buildPrompt(
      baseArgs({ videoCount: 5, entropy: 0.5, prevEntropy: 1.0 }),
    );
    expect(prompt).toContain(
      "직전 세션보다 시청이 더 적은 수의 주제에 모였습니다",
    );
  });

  it("delta가 ±0.1 미만이면 '비슷한 다양성' 문구를 넣는다 (경계값 안쪽)", () => {
    const prompt = buildPrompt(
      baseArgs({ videoCount: 5, entropy: 1.05, prevEntropy: 1.0 }),
    );
    expect(prompt).toContain("직전 세션과 비슷한 다양성을 유지하고 있습니다");
  });

  it("top 카테고리 비율이 0.7 이상이면 편중 경고 문구를 추가한다", () => {
    const prompt = buildPrompt(
      baseArgs({
        videoCount: 5,
        categoryDistribution: { 음악: 0.8, 게임: 0.2 },
      }),
    );
    expect(prompt).toContain("시청이 한 주제에 크게 모여 있습니다");
  });

  it("prevEntropy가 없고 편중도 없으면 트렌드 섹션 자체를 넣지 않는다", () => {
    const prompt = buildPrompt(
      baseArgs({
        videoCount: 5,
        categoryDistribution: { 음악: 0.5, 게임: 0.5 },
        prevEntropy: null,
      }),
    );
    expect(prompt).not.toContain("[피드백 작성 지침]");
  });

  it("카테고리가 1개뿐이면 '최대 entropy' 값을 표기하지 않는다", () => {
    const prompt = buildPrompt(
      baseArgs({ categoryDistribution: { 음악: 1 }, entropy: 0 }),
    );
    expect(prompt).toContain("다양성 지수: 0");
    expect(prompt).not.toContain("최대");
  });

  it("영상 제목을 소재 수준으로만 지칭하라는 가드레일 문구를 포함한다", () => {
    const prompt = buildPrompt(baseArgs());
    expect(prompt).toContain("소재 수준으로만 지칭");
    expect(prompt).toContain("주장이나 논조는 절대 요약·평가하지 마세요");
  });
});

describe("generateFallbackReview", () => {
  it("카테고리가 1개뿐이면 집중 시청 문구를 만든다", () => {
    const result = generateFallbackReview(
      baseArgs({ categoryDistribution: { 음악: 1 }, videoCount: 3 }),
    );
    expect(result.topic).toBe("음악");
    expect(result.feedback).toContain("음악 영상을 3개 집중적으로 시청");
    expect(result.source).toBe("fallback");
    expect(result.promptVersion).toBe(PROMPT_VERSION);
  });

  it("top 비율이 0.5 초과면 top 2개를 언급하는 문구를 만든다", () => {
    const result = generateFallbackReview(
      baseArgs({
        categoryDistribution: { 음악: 0.6, 게임: 0.4 },
        videoCount: 10,
      }),
    );
    expect(result.topic).toBe("음악");
    expect(result.feedback).toContain("주로 음악 영상을 보셨고");
  });

  it("top 비율이 0.5 이하면 '다양한 카테고리' 문구를 만든다", () => {
    const result = generateFallbackReview(
      baseArgs({
        categoryDistribution: { 음악: 0.4, 게임: 0.35, 교육: 0.25 },
        videoCount: 10,
      }),
    );
    expect(result.feedback).toContain("다양한 카테고리의 영상을");
  });

  it("videoCount가 MIN_VIDEOS_FOR_TREND 미만이면 트렌드/편중 문구를 넣지 않는다", () => {
    const result = generateFallbackReview(
      baseArgs({
        categoryDistribution: { 음악: 0.9, 게임: 0.1 },
        videoCount: 2,
        prevEntropy: 0.1,
        entropy: 1.5,
      }),
    );
    expect(result.feedback).not.toContain("직전 세션");
    expect(result.feedback).not.toContain("한 주제에 크게 모여");
  });
});

describe("generateReview — 실패 사유 분류 (failureReason 태깅)", () => {
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

    const result = await generateReview("prompt");
    expect(result).toEqual({
      topic: "과학과 기술",
      feedback: "관찰 문장",
      source: "llm",
      promptVersion: PROMPT_VERSION,
    });
  });

  it("HTTP 오류 응답이면 http_error + httpStatus를 태깅한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "quota exceeded",
    });

    await expect(generateReview("prompt")).rejects.toMatchObject({
      failureReason: "http_error",
      httpStatus: 429,
    });
  });

  it("응답에 텍스트가 없으면 empty_response로 분류한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [] }),
    });

    await expect(generateReview("prompt")).rejects.toMatchObject({
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
                  text: '{"topic":"정치","feedback":"이번 세션은 보수 성향 콘텐츠를 많이 보셨어요."}',
                },
              ],
            },
          },
        ],
      }),
    });

    await expect(generateReview("prompt")).rejects.toMatchObject({
      failureReason: "policy_filtered",
    });
  });

  it("'진보'/'보수'가 정치와 무관한 의미로 쓰이면 필터링하지 않는다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: '{"topic":"과학과 기술","feedback":"기술의 진보를 다루는 다큐멘터리와 보수 작업 관련 영상을 시청하셨어요."}',
                },
              ],
            },
          },
        ],
      }),
    });

    const result = await generateReview("prompt");
    expect(result.feedback).toContain("기술의 진보");
  });

  it("응답 본문 JSON 파싱이 실패하면 parse_error로 분류한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error("invalid body json");
      },
    });

    await expect(generateReview("prompt")).rejects.toMatchObject({
      failureReason: "parse_error",
    });
  });

  it("피드백 텍스트가 JSON이 아니면 parse_error로 분류한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "이건 JSON이 아님" }] } }],
      }),
    });

    await expect(generateReview("prompt")).rejects.toMatchObject({
      failureReason: "parse_error",
    });
  });

  it("네트워크 예외(abort 아님)는 network_error로 분류한다", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("network down"));

    await expect(generateReview("prompt")).rejects.toMatchObject({
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

    const promise = generateReview("prompt");
    // rejection을 먼저 걸어둔 뒤 타이머를 진행해야 unhandled rejection 경고가 안 뜬다
    const assertion = expect(promise).rejects.toMatchObject({
      failureReason: "timeout",
      timedOut: true,
    });
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
  });
});
