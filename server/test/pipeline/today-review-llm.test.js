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
    validVideoCount: 7,
    timeDistribution: { 음악: 0.62, 게임: 0.38 },
    categoryDistribution: { 음악: 0.5, 게임: 0.5 },
    titleGroups: [
      {
        category: "음악",
        videoCount: 5,
        titles: [
          { title: "아이유 라이브", count: 3 },
          { title: "피아노 플레이리스트", count: 1 },
        ],
        omittedCount: 0,
      },
      {
        category: "게임",
        videoCount: 2,
        titles: [{ title: "롤 하이라이트", count: 1 }],
        omittedCount: 0,
      },
    ],
    ...overrides,
  };
}

describe("buildTodayCumulativePrompt — 입력", () => {
  it("유효 영상 수와 시청 시간 비중(퍼센트)을 넣는다", () => {
    const prompt = buildTodayCumulativePrompt(baseArgs());
    expect(prompt).toContain("오늘 시청한 영상 수: 7개");
    expect(prompt).toContain(
      "분야별 시청 시간 비중:\n  · 음악: 62%\n  · 게임: 38%",
    );
  });

  it("시청 시간 비중이 비어 있으면 영상 개수 비중으로 대신한다", () => {
    const prompt = buildTodayCumulativePrompt(
      baseArgs({ timeDistribution: {} }),
    );
    expect(prompt).toContain("분야별 영상 개수 비중:\n  · 음악: 50%");
    expect(prompt).not.toContain("시청 시간 비중");
  });

  it("제목을 분야별로 묶어 전부 넣고, 다시 본 횟수를 붙인다", () => {
    const prompt = buildTodayCumulativePrompt(baseArgs());
    expect(prompt).toContain(
      "  [음악] 영상 5개\n  · 아이유 라이브 (3번)\n  · 피아노 플레이리스트\n  [게임] 영상 2개\n  · 롤 하이라이트",
    );
  });

  it("상한으로 줄인 묶음은 남은 수를 '이 외 n개'로 알린다", () => {
    const prompt = buildTodayCumulativePrompt(
      baseArgs({
        titleGroups: [
          {
            category: "음악",
            videoCount: 130,
            titles: [{ title: "남은 영상", count: 1 }],
            omittedCount: 29,
          },
        ],
      }),
    );
    expect(prompt).toContain("  · 남은 영상\n  · 이 외 29개");
  });

  it("제목이 없으면 제목 항목을 넣지 않는다", () => {
    const prompt = buildTodayCumulativePrompt(baseArgs({ titleGroups: [] }));
    expect(prompt).not.toContain("분야별 영상 제목");
  });
});

describe("buildTodayCumulativePrompt — 지침", () => {
  it("유효 영상이 2개 미만이면 패턴 단정이 어렵고 정확한 피드백이 아니라는 점을 밝히게 한다", () => {
    const prompt = buildTodayCumulativePrompt(baseArgs({ validVideoCount: 1 }));
    expect(prompt).toContain(
      "오늘은 시청한 영상이 적어 패턴을 단정하기 어렵습니다",
    );
    expect(prompt).toContain("정확한 피드백은 아니라는 점을 한 문장으로 밝혀");
  });

  it("유효 영상이 2개 이상이면 영상이 적다는 지침을 넣지 않는다", () => {
    const prompt = buildTodayCumulativePrompt(baseArgs({ validVideoCount: 2 }));
    expect(prompt).not.toContain("시청한 영상이 적어");
  });

  // 결정 4 — 70% 분기 제거, B — 다양성 지수·직전 시청일 비교 제거
  it("한 분야 비중이 커도 쏠림 지시를 넣지 않고, 다양성 지수·직전 시청일 비교도 없다", () => {
    const prompt = buildTodayCumulativePrompt(
      baseArgs({ timeDistribution: { 음악: 0.95, 게임: 0.05 } }),
    );
    expect(prompt).not.toContain("한 주제에 크게 모여");
    expect(prompt).not.toContain("다양성 지수:");
    expect(prompt).not.toContain("직전 시청일");
  });

  it("넘겨준 퍼센트만 쓰고, 판정·권유 없이 가장 큰 분야의 비중을 언급하게 한다", () => {
    const prompt = buildTodayCumulativePrompt(baseArgs());
    expect(prompt).toContain("위에 적힌 퍼센트만 그대로 쓰세요");
    expect(prompt).toContain(
      '"다양하다/편중됐다/쏠렸다"처럼 시청을 판정하는 말',
    );
    expect(prompt).toContain("비중이 가장 큰 분야는 그 퍼센트와 함께 언급");
  });

  it("분야 안의 세부 소재를 짚되 인물·정당·이슈 논조는 요약하지 않게 한다(결정 9)", () => {
    const prompt = buildTodayCumulativePrompt(baseArgs());
    expect(prompt).toContain("어떤 소재를 주로 봤는지 제목을 근거로 짚어");
    expect(prompt).toContain("주장이나 논조는 절대 요약·평가하지 마세요");
  });

  it("업로더가 정한 분야가 제목과 다르면 소재로 말하되 숫자는 바꾸지 않게 한다", () => {
    const prompt = buildTodayCumulativePrompt(baseArgs());
    expect(prompt).toContain(
      "분야는 영상을 올린 사람이 정한 것이라 내용과 다를 수 있습니다",
    );
    expect(prompt).toContain("비중 숫자는 바꾸지 마세요");
  });

  it("오늘 하루 전체를 하나로 요약하라는 지침을 포함한다(세션별 나열 금지)", () => {
    const prompt = buildTodayCumulativePrompt(baseArgs());
    expect(prompt).toContain("오늘 하루 전체를 하나로 요약하세요");
  });
});

describe("generateTodayFallbackReview", () => {
  it("분포가 없으면 '분석하지 못했다' 문구를 반환한다", () => {
    const result = generateTodayFallbackReview(
      baseArgs({ timeDistribution: {}, categoryDistribution: {} }),
    );
    expect(result.topic).toBe("분석 불가");
    expect(result.feedback).toContain(
      "오늘의 시청 데이터를 분석하지 못했습니다",
    );
    expect(result.source).toBe("fallback");
    expect(result.promptVersion).toBe(TODAY_PROMPT_VERSION);
  });

  it("분야가 하나면 유효 영상 수만 사실로 적는다", () => {
    const result = generateTodayFallbackReview(
      baseArgs({ timeDistribution: { 음악: 1 }, validVideoCount: 3 }),
    );
    expect(result.topic).toBe("음악");
    expect(result.feedback).toBe("오늘은 음악 영상을 3개 보셨어요.");
  });

  it("분야가 여럿이면 시청 시간 비중 상위 3개를 숫자로 적는다", () => {
    const result = generateTodayFallbackReview(
      baseArgs({
        timeDistribution: { 음악: 0.5, 게임: 0.3, 교육: 0.15, 스포츠: 0.05 },
        validVideoCount: 10,
      }),
    );
    expect(result.feedback).toBe(
      "오늘은 영상 10개를 보셨고, 시청 시간은 음악 50%, 게임 30%, 교육 15% 순이었어요.",
    );
  });

  it("시청 시간 비중이 없으면 영상 개수 기준이라고 밝힌다", () => {
    const result = generateTodayFallbackReview(
      baseArgs({ timeDistribution: {}, validVideoCount: 2 }),
    );
    expect(result.feedback).toContain("영상 개수는 음악 50%, 게임 50% 순");
  });

  it("한 분야 비중이 커도 판정 문장을 넣지 않는다(결정 4)", () => {
    const result = generateTodayFallbackReview(
      baseArgs({ timeDistribution: { 음악: 0.9, 게임: 0.1 } }),
    );
    expect(result.feedback).not.toContain("모여");
    expect(result.feedback).not.toContain("집중");
    expect(result.feedback).not.toContain("다양");
  });

  it("유효 영상이 2개 미만이면 영상이 적다는 문장을 붙인다", () => {
    const result = generateTodayFallbackReview(
      baseArgs({ timeDistribution: { 음악: 1 }, validVideoCount: 1 }),
    );
    expect(result.feedback).toBe(
      "오늘은 음악 영상을 1개 보셨어요. 영상이 적어 오늘 패턴을 정확히 말하기는 어려워요.",
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

  it("여러 줄 오류 본문은 한 줄로, 길면 잘라서 로그에 남긴다", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = `{\n  "error": {\n    "message": "${"x".repeat(2000)}"\n  }\n}`;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => body,
    });

    await expect(
      generateTodayReview("prompt", "fake-api-key"),
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
