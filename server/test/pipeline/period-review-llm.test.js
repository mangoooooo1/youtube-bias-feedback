import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildPeriodPrompt,
  buildCodeComparison,
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

  it("한 분야 비중이 커도 쏠림 지시를 넣지 않는다", () => {
    const prompt = buildPeriodPrompt(
      baseArgs({ timeDistribution: { 음악: 0.95, 게임: 0.05 } }),
    );
    expect(prompt).not.toContain("한 주제에 크게 모여");
  });

  it("1구간(직전 구간 없음)은 이전과 비교하지 말라고 하고 comparison을 요청하지 않는다", () => {
    const prompt = buildPeriodPrompt(baseArgs());
    expect(prompt).toContain("비교할 이전 구간이 없습니다");
    expect(prompt).not.toContain("feedback의 첫 문장은 직전 구간과의 비교");
    expect(prompt).not.toContain("[이전 구간과 비교]");
    expect(prompt).not.toContain("베이스라인");
    expect(prompt).not.toContain("기준이 된 첫 기간");
  });

  it("여러 세션을 개별 나열하지 말고 기간 전체로 요약하라는 지침을 포함한다", () => {
    const prompt = buildPeriodPrompt(baseArgs());
    expect(prompt).toContain("기간 전체를 하나로 요약하세요");
  });

  it("넘겨준 퍼센트만 쓰고 판정·권유 없이, 세부 소재와 업로더 분야 지침을 포함한다", () => {
    const prompt = buildPeriodPrompt(baseArgs());
    expect(prompt).toContain("숫자는 위에 적힌 것만 그대로 쓰세요");
    expect(prompt).toContain(
      '"편중됐다/다양하지 못하다/균형 잡혔다"처럼 시청을 좋거나 나쁘게 평가하는 말',
    );
    expect(prompt).toContain("위 숫자로 확인되지 않는 패턴은 말하지 마세요");
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

  it("분야가 하나면 영상 수와 그 분야의 시청 시간 비중을 따로 적는다", () => {
    const result = generatePeriodFallbackReview(
      baseArgs({ timeDistribution: { 음악: 1 }, validVideoCount: 10 }),
    );
    expect(result.topic).toBe("음악");
    expect(result.feedback).toBe(
      "이 기간에는 영상 10개를 보셨고, 시청 시간은 모두 음악이었어요.",
    );
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
      "이 기간에는 영상 23개를 보셨고, 전체 시청 시간 중 음악이 48%로 가장 많았어요. 그다음은 게임 30%, 스포츠 12%였어요.",
    );
  });

  it("한 분야 비중이 커도 판정 문장을 넣지 않는다", () => {
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
      "이 기간에는 영상 3개를 보셨고, 시청 시간은 모두 음악이었어요. 영상이 적어 이번 구간의 패턴을 정확히 말하기는 어려워요.",
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

// 직전 구간 비교. 숫자는 코드가 계산(period-comparison.js), Gemini는 문장만
function comparisonArgs(overrides = {}) {
  return {
    previousPeriods: [
      {
        periodIndex: 1,
        validVideoCount: 12,
        isFew: false,
        shares: [
          { category: "음악", percent: 70 },
          { category: "게임", percent: 30 },
        ],
      },
      {
        periodIndex: 2,
        validVideoCount: 18,
        isFew: false,
        shares: [
          { category: "음악", percent: 60 },
          { category: "게임", percent: 40 },
        ],
      },
    ],
    changeFromPrevious: {
      previousPeriodIndex: 2,
      changes: [
        { category: "게임", from: 40, to: 55, delta: 15 },
        { category: "음악", from: 60, to: 45, delta: -15 },
      ],
      largest: { category: "게임", from: 40, to: 55, delta: 15 },
      newCategories: [],
      droppedCategories: [],
    },
    usualChange: null,
    dailyShares: [
      {
        date: "2026-03-09",
        validVideoCount: 5,
        noRecord: false,
        isFew: false,
        shares: [
          { category: "게임", percent: 70 },
          { category: "음악", percent: 30 },
        ],
      },
      {
        date: "2026-03-10",
        validVideoCount: 0,
        noRecord: true,
        isFew: false,
        shares: [],
      },
      {
        date: "2026-03-11",
        validVideoCount: 1,
        noRecord: false,
        isFew: true,
        shares: [{ category: "음악", percent: 100 }],
      },
    ],
    previousTitleGroups: [
      {
        category: "스포츠",
        videoCount: 3,
        titles: [{ title: "축구 하이라이트", count: 3 }],
        omittedCount: 0,
      },
    ],
    ...overrides,
  };
}

describe("buildPeriodPrompt — 직전 구간 비교", () => {
  it("직전·이전 구간 비중, 크기 순 변화, 새로/안 본 분야, 직전 구간 제목을 넣고 comparison을 요청한다", () => {
    const prompt = buildPeriodPrompt(
      baseArgs({ comparison: comparisonArgs() }),
    );

    expect(prompt).toContain(
      "- 직전 구간(2구간) 시청 시간 비중: 음악 60%, 게임 40% (영상 18개)",
    );
    expect(prompt).toContain("  · 1구간: 음악 70%, 게임 30% (영상 12개)");
    expect(prompt).toContain(
      "- 직전 구간 대비 변화(크기 순): 게임 +15%p (40% → 55%), 음악 -15%p (60% → 45%)",
    );
    expect(prompt).toContain("- 새로 본 분야: 없음 / 보지 않게 된 분야: 없음");
    expect(prompt).toContain(
      "- 직전 구간 분야별 영상 제목 (시청 시간이 많은 분야부터, 최근 본 순서, 괄호는 본 횟수):\n  [스포츠] 영상 3개\n  · 축구 하이라이트 (3번)",
    );
    expect(prompt).toContain("feedback의 첫 문장은 직전 구간과의 비교입니다");
    expect(prompt).toContain("3~4문장. 첫 문장은 직전 구간과의 비교");
    expect(prompt).toContain("변화가 좋다거나 나쁘다고 평가하지 마세요");
    expect(prompt).not.toContain(
      "이전 기간과 비교하거나 증감을 언급하지 마세요",
    );
  });

  it("이번 구간 날짜별 비중을 요일과 함께 넣고, 기록 없는 날·영상이 적은 날을 표시한다", () => {
    const prompt = buildPeriodPrompt(
      baseArgs({ comparison: comparisonArgs() }),
    );

    expect(prompt).toContain(
      "[이번 구간 날짜별 시청 시간 비중]\n- 3/9(월): 게임 70%, 음악 30% (영상 5개)\n- 3/10(화): 기록 없음\n- 3/11(수): 음악 100% (영상 1개, 영상이 적은 날)",
    );
  });

  it("평소 변화 폭은 주어졌을 때만 넣고, 없으면 평소와 비교하지 말라고 한다", () => {
    const without = buildPeriodPrompt(
      baseArgs({ comparison: comparisonArgs() }),
    );
    const withUsual = buildPeriodPrompt(
      baseArgs({
        comparison: comparisonArgs({
          usualChange: { pairCount: 2, averageLargestDelta: 10 },
        }),
      }),
    );

    expect(without).not.toContain("- 평소 변화 폭:");
    expect(without).toContain("주어지지 않았으면 평소와 비교하지 마세요");
    expect(withUsual).toContain(
      "- 평소 변화 폭: 이전 구간이 바뀔 때마다 가장 크게 달라진 분야가 평균 10%p였음",
    );
  });

  it("이번이나 직전 구간이 적은 구간이면 비교 문장에 변화 폭이 다를 수 있다고 밝히게 한다", () => {
    const fewPrevious = comparisonArgs();
    fewPrevious.previousPeriods[1].isFew = true;
    const prompt = buildPeriodPrompt(baseArgs({ comparison: fewPrevious }));
    const normal = buildPeriodPrompt(
      baseArgs({ comparison: comparisonArgs() }),
    );

    expect(prompt).toContain("(영상 18개, 영상이 적은 구간)");
    expect(prompt).toContain("영상이 적어서 변화 폭이 평소와 다를 수 있다");
    expect(normal).not.toContain("영상이 적어서 변화 폭이 평소와 다를 수 있다");
  });
});

describe("buildPeriodPrompt — 영상이 적다는 지침은 한 번만", () => {
  it("이번 구간이 적으면 패턴과 변화 폭을 한 문장으로, 비교 문장용 지침은 따로 넣지 않는다", () => {
    const prompt = buildPeriodPrompt(
      baseArgs({ comparison: comparisonArgs(), validVideoCount: 6 }),
    );
    expect(prompt).toContain(
      "영상이 적어 이번 구간의 패턴이나 직전 구간과의 변화 폭을 정확히 말하기는 어렵다는 점을 한 문장으로만",
    );
    expect(prompt).not.toContain("직전 구간의 영상이 적습니다");
  });

  it("직전 구간만 적으면 비교 첫 문장에 직전 구간이 적다는 점을 밝히게 한다", () => {
    const fewPrevious = comparisonArgs();
    fewPrevious.previousPeriods[1].isFew = true;
    const prompt = buildPeriodPrompt(baseArgs({ comparison: fewPrevious }));
    expect(prompt).toContain(
      "직전 구간은 영상이 적어서 변화 폭이 평소와 다를 수 있다",
    );
    expect(prompt).not.toContain("이 기간은 시청한 영상이 적어");
  });
});

describe("buildCodeComparison — Gemini를 쓰지 못할 때의 비교 문장", () => {
  const args = (comparison, extra = {}) => ({
    comparison,
    validVideoCount: 20,
    periodDays: 4,
    ...extra,
  });

  it("1구간(직전 구간 없음)이면 비교 문장을 만들지 않는다", () => {
    expect(buildCodeComparison(args(null))).toBeNull();
  });

  it("가장 큰 변화가 정확히 10%p이면 달라졌다고 말한다(경계값)", () => {
    const comparison = comparisonArgs({
      changeFromPrevious: {
        previousPeriodIndex: 2,
        changes: [{ category: "게임", from: 40, to: 50, delta: 10 }],
        largest: { category: "게임", from: 40, to: 50, delta: 10 },
        newCategories: [],
        droppedCategories: [],
      },
    });

    expect(buildCodeComparison(args(comparison))).toBe(
      "직전 구간보다 게임 비중이 10%p 늘었어요.",
    );
  });

  it("가장 큰 변화가 10%p 이상이면 그 분야가 늘었는지 줄었는지 말한다", () => {
    const down = comparisonArgs({
      changeFromPrevious: {
        ...comparisonArgs().changeFromPrevious,
        largest: { category: "음악", from: 60, to: 45, delta: -15 },
      },
    });

    expect(buildCodeComparison(args(comparisonArgs()))).toBe(
      "직전 구간보다 게임 비중이 15%p 늘었어요.",
    );
    expect(buildCodeComparison(args(down))).toBe(
      "직전 구간보다 음악 비중이 15%p 줄었어요.",
    );
  });

  it("10%p 미만이고 새로 본 분야가 있으면 그 분야를 말한다", () => {
    const comparison = comparisonArgs({
      changeFromPrevious: {
        previousPeriodIndex: 2,
        changes: [{ category: "스포츠", from: 0, to: 9, delta: 9 }],
        largest: { category: "스포츠", from: 0, to: 9, delta: 9 },
        newCategories: ["스포츠"],
        droppedCategories: [],
      },
    });

    expect(buildCodeComparison(args(comparison))).toBe(
      "직전 구간에는 보지 않았던 스포츠 분야도 봤어요.",
    );
  });

  it("모든 변화가 10%p 미만이고 새로 본 분야도 없으면 비슷하다고 한다", () => {
    const comparison = comparisonArgs({
      changeFromPrevious: {
        previousPeriodIndex: 2,
        changes: [
          { category: "음악", from: 60, to: 63, delta: 3 },
          { category: "게임", from: 40, to: 37, delta: -3 },
        ],
        largest: { category: "음악", from: 60, to: 63, delta: 3 },
        newCategories: [],
        droppedCategories: [],
      },
    });

    expect(buildCodeComparison(args(comparison))).toBe(
      "직전 구간과 비슷하게 봤어요.",
    );
  });

  // 영상이 적다는 안내는 한 번만 — 이번 구간이 적으면 대체 문구 마지막 문장이 맡는다
  it("직전 구간만 적으면 비교 문장에 '직전 구간은 영상이 적어서…'를 붙이고, 이번 구간이 적으면 붙이지 않는다", () => {
    const fewPrevious = comparisonArgs();
    fewPrevious.previousPeriods[1].isFew = true;

    expect(buildCodeComparison(args(fewPrevious))).toBe(
      "직전 구간보다 게임 비중이 15%p 늘었어요. 직전 구간은 영상이 적어서, 변화 폭이 평소와 다를 수 있어요.",
    );
    expect(
      buildCodeComparison(args(comparisonArgs(), { validVideoCount: 7 })),
    ).toBe("직전 구간보다 게임 비중이 15%p 늘었어요.");
    expect(buildCodeComparison(args(fewPrevious, { validVideoCount: 7 }))).toBe(
      "직전 구간보다 게임 비중이 15%p 늘었어요.",
    );
  });
});

describe("generatePeriodFallbackReview — 비교 문장", () => {
  it("이번·직전 구간이 둘 다 적어도 '영상이 적어' 안내는 마지막 문장 한 번(패턴이나 변화 폭)", () => {
    const fewPrevious = comparisonArgs();
    fewPrevious.previousPeriods[1].isFew = true;
    const { feedback } = generatePeriodFallbackReview(
      baseArgs({ comparison: fewPrevious, validVideoCount: 6 }),
    );

    expect(feedback.match(/영상이 적어/g)).toHaveLength(1);
    expect(feedback).toMatch(
      /영상이 적어 이번 구간의 패턴이나 변화 폭을 정확히 말하기는 어려워요\.$/,
    );
  });

  it("2구간부터는 대체 문구의 첫 문장을 코드 비교 문장으로 둔다", () => {
    const result = generatePeriodFallbackReview(
      baseArgs({ comparison: comparisonArgs() }),
    );
    expect(result.feedback).toBe(
      "직전 구간보다 게임 비중이 15%p 늘었어요. 이 기간에는 영상 20개를 보셨고, 전체 시청 시간 중 음악이 60%로 가장 많았어요. 그다음은 게임 40%였어요.",
    );
  });

  it("1구간이나 분석할 분포가 없으면 비교 문장을 넣지 않는다", () => {
    const first = generatePeriodFallbackReview(baseArgs());
    const empty = generatePeriodFallbackReview(
      baseArgs({
        timeDistribution: {},
        categoryDistribution: {},
        comparison: comparisonArgs(),
      }),
    );
    expect(first.feedback).not.toContain("직전 구간");
    expect(empty.feedback).not.toContain("직전 구간");
  });
});

describe("generatePeriodReview — 숫자 검증", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function respond(feedback) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ topic: "게임", feedback }) }],
            },
          },
        ],
      }),
    });
  }

  const prompt = buildPeriodPrompt(baseArgs({ comparison: comparisonArgs() }));

  it("입력에 없는 숫자를 쓰면 number_mismatch로 실패한다", async () => {
    respond("직전 구간보다 게임 비중이 25%p 늘었어요.");
    await expect(generatePeriodReview(prompt, "key")).rejects.toMatchObject({
      failureReason: "number_mismatch",
    });

    respond("음악과 게임을 합쳐 시청 시간의 99%였어요.");
    await expect(generatePeriodReview(prompt, "key")).rejects.toMatchObject({
      failureReason: "number_mismatch",
    });
  });

  it("원칙의 예시 숫자(85%)나 유효 시청 설명(30초)은 입력이 아니라 허용하지 않는다", async () => {
    respond("시청 시간의 85%가 음악이었어요.");
    await expect(generatePeriodReview(prompt, "key")).rejects.toMatchObject({
      failureReason: "number_mismatch",
    });

    // 비교 입력 없는 프롬프트(30이 데이터에 없음)로 확인
    respond("30초 넘게 본 영상이 많았어요.");
    await expect(
      generatePeriodReview(buildPeriodPrompt(baseArgs()), "key"),
    ).rejects.toMatchObject({
      failureReason: "number_mismatch",
    });
  });

  it("비중·변화·날짜·영상 수·구간 번호처럼 입력에 있는 숫자는 허용한다", async () => {
    respond(
      "2구간보다 게임 비중이 15%p 늘었어요(40% → 55%). 3/9에는 게임이 70%였고, 4일 동안 영상 20개를 보셨어요.",
    );

    const result = await generatePeriodReview(prompt, "key");
    expect(result.source).toBe("llm");
  });
});
