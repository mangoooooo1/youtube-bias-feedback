import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// E2E: 시청 감지 이후 단계 — 세션 분석 → 카테고리 조회 → 서버 전송(세션 저장 + 오늘 리뷰
// 생성을 서버가 한 번에 처리) → 응답 반영(로컬 저장·캐시) → 알림
// background.js는 manifest.json에서 type:module로 선언된 서비스워커라 export를 붙여도
// 실제 확장 동작에 영향이 없다. 모듈 최상단이 chrome.alarms.create 등 부작용을 즉시 실행하므로,
// 매 테스트마다 chrome 목을 새로 세팅한 뒤 vi.resetModules()로 모듈을 새로 import한다

// config.js는 gitignore 대상이라 로컬엔 개발자가 미리 채워둔 실제 값이 있을 수 있지만,
// CI처럼 새로 체크아웃한 환경에선 scripts/ensure-config.js가 config.example.js를 그대로
// 복사해 SERVER_URL이 "YOUR_SERVER_URL_HERE" placeholder로 남는다. background.js는 이
// placeholder를 보면 postSessionToServer를 조용히 건너뛰므로, 로컬에서만 우연히 통과하고
// CI에서는 항상 실패하는 결과가 났었다. 테스트가 로컬 파일 상태에 좌우되지 않도록 고정값으로 목킹한다.
// GEMINI_API_KEY는 더 이상 확장 프로그램에 없다 — "오늘 리뷰" 생성은 서버가 직접 한다
// (연구 무결성 점검 항목 1 후속 조치: 확장 프로그램 파일을 열어보면 키가 그대로 노출되는
// 문제가 있었다).
vi.mock("../config.js", () => ({
  SERVER_URL: "http://localhost:3000",
  YOUTUBE_API_KEY: "test-youtube-key",
}));

function createChromeMock() {
  let store = {};
  return {
    storage: {
      local: {
        get: (keys) => {
          if (keys == null) return Promise.resolve({ ...store });
          if (typeof keys === "string")
            return Promise.resolve({ [keys]: store[keys] });
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) out[k] = store[k];
            return Promise.resolve(out);
          }
          return Promise.resolve({ ...store });
        },
        set: (obj) => {
          store = { ...store, ...obj };
          return Promise.resolve();
        },
      },
    },
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    },
    runtime: {
      onMessage: { addListener: vi.fn() },
      getURL: (p) => `chrome-extension://fake/${p}`,
    },
    notifications: {
      create: vi.fn(),
      clear: vi.fn(),
      onButtonClicked: { addListener: vi.fn() },
      onClicked: { addListener: vi.fn() },
    },
    action: {
      setIcon: vi.fn(),
    },
  };
}

// videoId → 유튜브 카테고리 조회, 서버 전송(sessions) — 2곳으로 나가는 fetch를 URL로
// 구분해 응답한다. sessions 응답의 data.todayReview가 곧 "서버가 생성해 돌려준 오늘 리뷰"다
// (더 이상 확장 프로그램이 Gemini를 직접 부르지 않는다).
function createFetchMock({ todayReview }) {
  const calls = { sessions: [] };

  const fetchMock = vi.fn(async (url, options = {}) => {
    const href = String(url);

    if (href.includes("googleapis.com/youtube/v3/videos")) {
      const idsParam = new URL(href).searchParams.get("id");
      const ids = idsParam ? idsParam.split(",") : [];
      return {
        ok: true,
        json: async () => ({
          items: ids.map((id) => ({
            id,
            snippet: { categoryId: "10" }, // 음악
          })),
        }),
      };
    }

    if (href.endsWith("/api/sessions")) {
      calls.sessions.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({ success: true, data: { todayReview } }),
      };
    }

    throw new Error(`예상치 못한 fetch 호출: ${href}`);
  });

  return { fetchMock, calls };
}

const FIXED_NOW = new Date(2026, 0, 10, 12, 0, 0);

async function loadAnalyzeSession() {
  vi.resetModules();
  const mod = await import("../background.js");
  return mod.analyzeSession;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  delete global.chrome;
  delete global.fetch;
});

describe("analyzeSession — 시청 감지 이후 전체 파이프라인 E2E", () => {
  it("성공 경로: 카테고리 조회 → 서버 전송 → 응답의 오늘 리뷰를 로컬에 반영 → 알림까지 전부 맞물려 동작한다", async () => {
    global.chrome = createChromeMock();
    const { fetchMock, calls } = createFetchMock({
      todayReview: {
        reviewDate: "2026-01-10",
        review: "오늘은 음악 영상 위주로 보셨네요.",
        reviewTopic: "음악",
        source: "llm",
        promptVersion: "viewlens-today-mirror-v1.0",
      },
    });
    global.fetch = fetchMock;

    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "EXP",
      installDate: new Date(2025, 0, 1).toISOString(), // 베이스라인 훨씬 지남 → 알림 대상
      sessions: [
        {
          sessionId: "s1",
          startTime: new Date(2026, 0, 10, 11, 50).toISOString(),
          endTime: FIXED_NOW.toISOString(),
          videos: [{ videoId: "v1", title: "노래 모음" }],
        },
      ],
    });

    const analyzeSession = await loadAnalyzeSession();
    await analyzeSession({
      sessionId: "s1",
      videos: [{ videoId: "v1", title: "노래 모음" }],
    });

    // 1) 로컬 세션에 분석 결과 + 서버가 돌려준 오늘 리뷰가 반영됐는지
    const { sessions } = await global.chrome.storage.local.get("sessions");
    const saved = sessions.find((s) => s.sessionId === "s1");
    expect(saved.categoryDistribution).toEqual({ 음악: 1 });
    expect(saved.entropy).toBe(0);
    expect(saved.review).toBe("오늘은 음악 영상 위주로 보셨네요.");
    expect(saved.reviewTopic).toBe("음악");

    // 2) 오늘 리뷰 이력 캐시(팝업이 읽는 곳)에도 병합됐는지
    const { todayReviewsCache } =
      await global.chrome.storage.local.get("todayReviewsCache");
    expect(todayReviewsCache.anonymousId).toBe("a1");
    expect(todayReviewsCache.reviews).toEqual([
      expect.objectContaining({
        reviewDate: "2026-01-10",
        review: "오늘은 음악 영상 위주로 보셨네요.",
      }),
    ]);

    // 3) 알림 대상(EXP, 베이스라인 아님)이라 실제로 알림이 떴는지
    expect(global.chrome.notifications.create).toHaveBeenCalledTimes(1);

    // 4) 서버로 전송된 세션 데이터에 더 이상 review/llmStatus 등을 직접 계산해 보내지 않는지
    // (서버가 저장 직후 자체적으로 today_reviews를 생성하므로, 클라이언트는 원시 분석
    // 결과와 타이밍 지표만 보낸다)
    expect(calls.sessions).toHaveLength(1);
    expect(calls.sessions[0]).toMatchObject({
      anonymousId: "a1",
      sessionId: "s1",
      entropy: 0,
      feedbackNotifiedAt: expect.any(String),
    });
    expect(calls.sessions[0].categoryDistribution).toEqual({ 음악: 1 });
    expect(calls.sessions[0]).not.toHaveProperty("review");
    expect(calls.sessions[0]).not.toHaveProperty("llmStatus");
  });

  it("서버 응답에 오늘 리뷰가 없으면(자격 없음 등) 로컬에도 리뷰 텍스트를 저장하지 않는다", async () => {
    global.chrome = createChromeMock();
    const { fetchMock, calls } = createFetchMock({ todayReview: null });
    global.fetch = fetchMock;

    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "CON",
      installDate: new Date(2025, 0, 1).toISOString(),
      sessions: [
        {
          sessionId: "s1",
          startTime: new Date(2026, 0, 10, 11, 50).toISOString(),
          endTime: FIXED_NOW.toISOString(),
          videos: [{ videoId: "v1", title: "노래 모음" }],
        },
      ],
    });

    const analyzeSession = await loadAnalyzeSession();
    await analyzeSession({
      sessionId: "s1",
      videos: [{ videoId: "v1", title: "노래 모음" }],
    });

    const { sessions } = await global.chrome.storage.local.get("sessions");
    const saved = sessions.find((s) => s.sessionId === "s1");
    // 리뷰(피드백)는 자격이 없어 비어 있지만, 시청 데이터 자체(연구 데이터의 핵심)는
    // 대조군도 실험군과 동일하게 수집된다 — "피드백 미노출"과 "데이터 미수집"은 별개다
    expect(saved.categoryDistribution).toEqual({ 음악: 1 });
    expect(saved.entropy).toBe(0);
    expect(saved.review).toBeUndefined();

    expect(calls.sessions).toHaveLength(1);
    expect(calls.sessions[0]).toMatchObject({
      anonymousId: "a1",
      sessionId: "s1",
      entropy: 0,
    });
    expect(calls.sessions[0].categoryDistribution).toEqual({ 음악: 1 });

    const { todayReviewsCache } =
      await global.chrome.storage.local.get("todayReviewsCache");
    expect(todayReviewsCache).toBeUndefined();

    // CON은 애초에 알림 대상이 아니다(그룹과 무관하게 항상 꺼져 있음)
    expect(global.chrome.notifications.create).not.toHaveBeenCalled();
    expect(calls.sessions[0].feedbackNotifiedAt).toBeNull();
  });

  it("서버 전송 자체가 실패해도(오프라인 등) 세션 분석 결과는 로컬에 남아 있다", async () => {
    global.chrome = createChromeMock();
    global.fetch = vi.fn().mockRejectedValue(new TypeError("network down"));

    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "EXP",
      installDate: new Date(2025, 0, 1).toISOString(),
      sessions: [
        {
          sessionId: "s1",
          startTime: new Date(2026, 0, 10, 11, 50).toISOString(),
          endTime: FIXED_NOW.toISOString(),
          videos: [{ videoId: "v1", title: "노래 모음" }],
        },
      ],
    });

    const analyzeSession = await loadAnalyzeSession();
    // 카테고리 조회(fetch)도 같이 실패하지만, analyzeSession 자체가 예외를 던지진 않는다
    // (fetchVideoCategories 내부에서 개별 실패를 흡수하는 기존 동작 — youtube.js 영역).
    await expect(
      analyzeSession({
        sessionId: "s1",
        videos: [{ videoId: "v1", title: "노래 모음" }],
      }),
    ).resolves.toBeUndefined();

    const { sessions } = await global.chrome.storage.local.get("sessions");
    const saved = sessions.find((s) => s.sessionId === "s1");
    expect(saved.categoryDistribution).toBeDefined();
    expect(saved.review).toBeUndefined();

    // 알림 대상(EXP, 베이스라인 아님)이라도 서버 전송이 실패해 오늘 리뷰를 받지 못했다면
    // 알림을 띄우지 않는다 — 그렇지 않으면 "피드백이 업데이트됐어요" 알림만 뜨고
    // 팝업엔 실제 리뷰 없이 "생성 중" 상태만 보이는 불일치가 생긴다.
    expect(global.chrome.notifications.create).not.toHaveBeenCalled();
  });
});
