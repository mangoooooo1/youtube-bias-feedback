import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildTodayCumulativePrompt,
  generateTodayReview,
  generateTodayFallbackReview,
  TODAY_PROMPT_VERSION,
} from "../../pipeline/today-review-llm.js";
import {
  buildTodayCumulativePrompt as buildTodayCumulativePromptClient,
  generateTodayFallbackReview as generateTodayFallbackReviewClient,
  TODAY_PROMPT_VERSION as TODAY_PROMPT_VERSION_CLIENT,
} from "../../../extension/pipeline/llm.js";

function baseArgs(overrides = {}) {
  return {
    categoryDistribution: { 음악: 0.6, 게임: 0.4 },
    entropy: 0.97,
    videoCount: 10,
    ...overrides,
  };
}

describe("today-review-llm ↔ extension/pipeline/llm.js 동치성", () => {
  it("PROMPT_VERSION 문자열이 같다", () => {
    expect(TODAY_PROMPT_VERSION).toBe(TODAY_PROMPT_VERSION_CLIENT);
  });

  it.each([
    ["기본(추세 없음)", baseArgs()],
    ["직전 시청일 있음 · 다양해짐", baseArgs({ prevEntropy: 0.5 })],
    ["직전 시청일 있음 · 편중됨", baseArgs({ entropy: 0.3, prevEntropy: 0.9 })],
    [
      "직전 시청일 있음 · 변화 없음(delta < eps)",
      baseArgs({ entropy: 0.97, prevEntropy: 0.95 }),
    ],
    ["영상 수 적음(추세 판단 불가)", baseArgs({ videoCount: 3 })],
    [
      "편중 경고 임계(topRatio>=0.7)",
      baseArgs({ categoryDistribution: { 음악: 0.8, 게임: 0.2 } }),
    ],
    [
      "카테고리 1개(최대 entropy 미표기)",
      baseArgs({ categoryDistribution: { 음악: 1 }, entropy: 0 }),
    ],
    [
      "영상 제목 포함",
      baseArgs({ videoTitles: ["아이유 신곡 MV", "LCK 하이라이트"] }),
    ],
  ])("%s — 프롬프트 문구가 클라이언트 원본과 완전히 같다", (_label, args) => {
    expect(buildTodayCumulativePrompt(args)).toBe(
      buildTodayCumulativePromptClient(args),
    );
  });

  it.each([
    ["빈 분포", baseArgs({ categoryDistribution: {}, videoCount: 0 })],
    [
      "카테고리 1개",
      baseArgs({ categoryDistribution: { 음악: 1 }, videoCount: 3 }),
    ],
    [
      "top 비율 > 0.5",
      baseArgs({
        categoryDistribution: { 음악: 0.6, 게임: 0.4 },
        videoCount: 10,
      }),
    ],
    [
      "다양한 카테고리",
      baseArgs({
        categoryDistribution: { 음악: 0.4, 게임: 0.35, 교육: 0.25 },
        videoCount: 10,
      }),
    ],
    [
      "편중 + 추세(다양해짐)",
      baseArgs({
        categoryDistribution: { 음악: 0.9, 게임: 0.1 },
        videoCount: 10,
        prevEntropy: 0.2,
      }),
    ],
    [
      "영상 수 적어 추세 문구 없음",
      baseArgs({
        categoryDistribution: { 음악: 0.9, 게임: 0.1 },
        videoCount: 2,
      }),
    ],
  ])("%s — 폴백 문구가 클라이언트 원본과 완전히 같다", (_label, args) => {
    expect(generateTodayFallbackReview(args)).toEqual(
      generateTodayFallbackReviewClient(args),
    );
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
});
