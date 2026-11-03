import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildTodayCumulativePrompt,
  generateTodayReview,
  generateTodayFallbackReview,
  TODAY_PROMPT_VERSION,
} from "../../pipeline/today-review-llm.js";

// 기간 리뷰 테스트와 같은 문장을 확인한다(두 프롬프트가 같은 기준을 쓰는지)
const FULL_SHARE_PRINCIPLE =
  '- 한 분야가 시청 시간의 100%이면 퍼센트 대신 "전부"로 말하세요(예: "시청 시간 전부가 음악이었어요").';
const POLITICAL_TOPIC_PRINCIPLE =
  "- 제목에 나온 인물·사건 이름은 사실대로 말해도 됩니다. 단, 제목의 주장은 사실로 단정하지 말고 무엇에 관한 영상인지만 말하며, 제목의 평가·조롱 표현은 옮기지 마세요. 시청자가 어떤 인물·정당·진영을 지지하거나 반대하는지, 호감이나 반감을 가졌는지 추론하지 말고, 영상이나 채널을 보수·진보로 분류하지 마세요.";
const JUDGMENT_PRINCIPLE =
  '"다양하다/다양하지 못하다/편중됐다/쏠렸다/균형 잡혔다"처럼 시청을 좋거나 나쁘게 판정하는 말';
const SENSITIVE_TRAIT_PRINCIPLE =
  "- 시청자의 성적 지향·성별 정체성, 종교, 건강·질병·장애·임신, 감정·정신 상태, 국적·인종, 경제 사정 같은 개인적 특성을 추론하거나 단정하지 마세요. 그런 주제의 영상을 봤다면 무엇에 관한 영상을 봤는지까지만 말하세요.";
const TOPIC_INSTRUCTION =
  '"topic": "비중이 큰 분야의 영상 제목에서 드러나는 구체적인 소재를 5단어 이내 명사구로 (예: 야구 하이라이트). 분야 이름을 그대로 쓰지 말고, 정치·시사 소재는 인물 이름 대신 사건·주제로 쓸 것"';

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

  // 영상 개수 비중(categoryDistribution)은 시청 시간을 모르는 영상까지 세어 대신 쓰지 않는다
  it("시청 시간 비중이 비어 있어도 영상 개수 비중으로 대신하지 않는다", () => {
    const prompt = buildTodayCumulativePrompt(
      baseArgs({ timeDistribution: {} }),
    );
    expect(prompt).not.toContain("영상 개수 비중");
    expect(prompt).not.toContain("음악: 50%");
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

  // 70% 분기 제거, B — 다양성 지수·직전 시청일 비교 제거
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
    expect(prompt).toContain(JUDGMENT_PRINCIPLE);
    expect(prompt).toContain("비중이 가장 큰 분야는 그 퍼센트와 함께 언급");
  });

  it("분야 안의 세부 소재를 짚되 인물·사건 이름은 사실로만 쓰고 주장·평가·지지 추론은 하지 않게 한다", () => {
    const prompt = buildTodayCumulativePrompt(baseArgs());
    expect(prompt).toContain("어떤 소재를 주로 봤는지 제목을 근거로 짚어");
    expect(prompt).toContain(POLITICAL_TOPIC_PRINCIPLE);
    expect(prompt).not.toContain("주장이나 논조는 절대 요약·평가하지 마세요");
  });

  it("성적 지향·종교·건강·감정 상태 같은 개인적 특성은 추론하지 않고 무엇에 관한 영상인지만 말하게 한다", () => {
    const prompt = buildTodayCumulativePrompt(baseArgs());
    expect(prompt).toContain(SENSITIVE_TRAIT_PRINCIPLE);
  });

  it("기간 리뷰와 같이 시청자를 '사용자'가 아니라 '참여자'로 부른다", () => {
    const prompt = buildTodayCumulativePrompt(baseArgs());
    expect(prompt).toContain(
      "당신은 참여자가 자신의 YouTube 콘텐츠 소비 패턴을",
    );
    expect(prompt).not.toContain("사용자");
  });

  it("topic은 분야 이름이 아니라 제목의 세부 소재로, 정치·시사는 인물 대신 사건·주제로 쓰게 한다", () => {
    const prompt = buildTodayCumulativePrompt(baseArgs());
    expect(prompt).toContain(TOPIC_INSTRUCTION);
    expect(prompt).not.toContain("시청 카테고리 기반 주요 관심사");
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

  it("한 분야가 100%이면 퍼센트 대신 '전부'로 말하게 한다", () => {
    const prompt = buildTodayCumulativePrompt(baseArgs());
    expect(prompt).toContain(FULL_SHARE_PRINCIPLE);
    expect(prompt).toContain(
      "언급(한 분야가 100%이면 퍼센트 대신 '전부'라고 말할 것)",
    );
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

  // 영상 수(분야 미확인 포함)를 그 분야의 영상 수로 적지 않는다
  it("분야가 하나면 영상 수와 그 분야의 시청 시간 비중을 따로 적는다", () => {
    const result = generateTodayFallbackReview(
      baseArgs({ timeDistribution: { 음악: 1 }, validVideoCount: 3 }),
    );
    expect(result.topic).toBe("음악");
    expect(result.feedback).toBe(
      "오늘은 영상 3개를 보셨고, 시청 시간은 모두 음악이었어요.",
    );
  });

  it("분야가 여럿이면 시청 시간 비중 상위 3개를 숫자로 적는다", () => {
    const result = generateTodayFallbackReview(
      baseArgs({
        timeDistribution: { 음악: 0.5, 게임: 0.3, 교육: 0.15, 스포츠: 0.05 },
        validVideoCount: 10,
      }),
    );
    expect(result.feedback).toBe(
      "오늘은 영상 10개를 보셨고, 전체 시청 시간 중 음악이 50%로 가장 많았어요. 그다음은 게임 30%, 교육 15%였어요.",
    );
  });

  it("시청 시간 비중이 없으면 영상 개수 비중으로 대신하지 않고 '분석하지 못했다'고 알린다", () => {
    const result = generateTodayFallbackReview(
      baseArgs({ timeDistribution: {}, validVideoCount: 2 }),
    );
    expect(result.feedback).toContain(
      "오늘의 시청 데이터를 분석하지 못했습니다",
    );
  });

  it("한 분야 비중이 커도 판정 문장을 넣지 않는다", () => {
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
      "오늘은 영상 1개를 보셨고, 시청 시간은 모두 음악이었어요. 영상이 적어 오늘 패턴을 정확히 말하기는 어려워요.",
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

describe("generateTodayReview — 숫자 검증", () => {
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
              parts: [
                { text: JSON.stringify({ topic: "아이유 라이브", feedback }) },
              ],
            },
          },
        ],
      }),
    });
  }

  const prompt = buildTodayCumulativePrompt(baseArgs());

  it("입력 비중과 다른 퍼센트를 쓰면 number_mismatch로 실패한다", async () => {
    // 시청 시간 비중(62%) 대신 영상 개수 등으로 직접 계산한 숫자
    respond("음악이 시청 시간의 66%였어요.");
    await expect(generateTodayReview(prompt, "key")).rejects.toMatchObject({
      failureReason: "number_mismatch",
    });
  });

  it("원칙의 예시 숫자나 유효 시청 설명(30초)은 입력이 아니라 허용하지 않는다", async () => {
    respond("30초 넘게 본 영상이 많았어요.");
    await expect(generateTodayReview(prompt, "key")).rejects.toMatchObject({
      failureReason: "number_mismatch",
    });
  });

  it("비중·영상 수·본 횟수처럼 입력에 있는 숫자는 허용한다", async () => {
    respond(
      "영상 7개 중 음악이 시청 시간의 62%였어요. 아이유 라이브를 3번 보셨고, 게임 영상도 2개 보셨어요.",
    );

    const result = await generateTodayReview(prompt, "key");
    expect(result.source).toBe("llm");
  });
});
