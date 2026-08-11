import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildPeriodPrompt,
  generatePeriodReview,
  generatePeriodFallbackReview,
  PROMPT_VERSION,
} from "../../pipeline/period-review-llm.js";

function baseArgs(overrides = {}) {
  return {
    categoryDistribution: { 음악: 0.6, 게임: 0.4 },
    entropy: 0.97,
    videoCount: 10,
    ...overrides,
  };
}

describe("buildPeriodPrompt — 패턴 문구 경계값 (buildPatternGuidance)", () => {
  it("videoCount가 5 미만이면 '패턴 단정 어려움' 문구만 넣는다", () => {
    const prompt = buildPeriodPrompt(baseArgs({ videoCount: 4 }));
    expect(prompt).toContain("시청한 영상 수가 적어 패턴을 단정하기 어렵습니다");
    expect(prompt).not.toContain("한 주제에 크게 모여 있습니다");
  });

  it("top 카테고리 비율이 0.7 이상이면 편중 경고 문구를 추가한다", () => {
    const prompt = buildPeriodPrompt(
      baseArgs({
        videoCount: 5,
        categoryDistribution: { 음악: 0.8, 게임: 0.2 },
      }),
    );
    expect(prompt).toContain("시청이 한 주제에 크게 모여 있습니다");
  });

  it("영상 수가 충분하고 편중도 없으면 [피드백 작성 지침] 섹션 자체를 넣지 않는다", () => {
    const prompt = buildPeriodPrompt(
      baseArgs({
        videoCount: 10,
        categoryDistribution: { 음악: 0.5, 게임: 0.5 },
      }),
    );
    expect(prompt).not.toContain("[피드백 작성 지침]");
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

  it("영상 제목을 소재 수준으로만 지칭하라는 가드레일 문구를 포함한다", () => {
    const prompt = buildPeriodPrompt(baseArgs());
    expect(prompt).toContain("소재 수준으로만 지칭");
    expect(prompt).toContain("주장이나 논조는 절대 요약·평가하지 마세요");
  });

  it("카테고리가 1개뿐이면 '최대 entropy' 값을 표기하지 않는다", () => {
    const prompt = buildPeriodPrompt(
      baseArgs({ categoryDistribution: { 음악: 1 }, entropy: 0 }),
    );
    expect(prompt).toContain("다양성 지수: 0");
    expect(prompt).not.toContain("최대");
  });
});

describe("generatePeriodFallbackReview", () => {
  it("카테고리 데이터가 없으면 topic이 빈 문자열이 아닌 placeholder를 반환한다", () => {
    const result = generatePeriodFallbackReview(
      baseArgs({ categoryDistribution: {}, videoCount: 0 }),
    );
    expect(result.topic).toBe("분석 불가");
    expect(result.feedback).toContain("이 기간엔 분석할 시청 기록이 없어요");
    expect(result.source).toBe("fallback");
    expect(result.promptVersion).toBe(PROMPT_VERSION);
  });

  it("카테고리가 1개뿐이면 집중 시청 문구를 만든다", () => {
    const result = generatePeriodFallbackReview(
      baseArgs({ categoryDistribution: { 음악: 1 }, videoCount: 3 }),
    );
    expect(result.topic).toBe("음악");
    expect(result.feedback).toContain("음악 영상을 3개 집중적으로 시청");
  });

  it("top 비율이 0.5 초과면 top 2개를 언급하는 문구를 만든다", () => {
    const result = generatePeriodFallbackReview(
      baseArgs({
        categoryDistribution: { 음악: 0.6, 게임: 0.4 },
        videoCount: 10,
      }),
    );
    expect(result.topic).toBe("음악");
    expect(result.feedback).toContain("주로 음악 영상을 보셨고");
  });

  it("top 비율이 0.5 이하면 '다양한 카테고리' 문구를 만든다", () => {
    const result = generatePeriodFallbackReview(
      baseArgs({
        categoryDistribution: { 음악: 0.4, 게임: 0.35, 교육: 0.25 },
        videoCount: 10,
      }),
    );
    expect(result.feedback).toContain("다양한 카테고리의 영상을");
  });

  it("videoCount가 MIN_VIDEOS_FOR_PATTERN 이상이고 편중이 있으면 편중 문구를 넣는다", () => {
    const result = generatePeriodFallbackReview(
      baseArgs({
        categoryDistribution: { 음악: 0.9, 게임: 0.1 },
        videoCount: 10,
      }),
    );
    expect(result.feedback).toContain("특히 시청이 한 주제에 크게 모여 있었어요");
  });

  it("videoCount가 MIN_VIDEOS_FOR_PATTERN 미만이면 편중 문구를 넣지 않는다", () => {
    const result = generatePeriodFallbackReview(
      baseArgs({
        categoryDistribution: { 음악: 0.9, 게임: 0.1 },
        videoCount: 2,
      }),
    );
    expect(result.feedback).not.toContain("한 주제에 크게 모여");
  });

  it("베이스라인 대비 증감 문구는 더 이상 만들지 않는다", () => {
    const result = generatePeriodFallbackReview(
      baseArgs({ videoCount: 10 }),
    );
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
});
