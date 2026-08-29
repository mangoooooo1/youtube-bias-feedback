import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// E2E: 시청 감지 이후 단계 — 세션 분석 → 카테고리 조회 → LLM 리뷰 생성(성공/폴백) → 로컬 저장 → 서버 전송 → 알림
// background.js는 manifest.json에서 type:module로 선언된 서비스워커라 export를 붙여도
// 실제 확장 동작에 영향이 없다. 모듈 최상단이 chrome.alarms.create 등 부작용을 즉시 실행하므로,
// 매 테스트마다 chrome 목을 새로 세팅한 뒤 vi.resetModules()로 모듈을 새로 import한다

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

// videoId → 유튜브 카테고리 조회, Gemini 호출, 서버 전송(sessions/today-reviews) —
// 4곳으로 나가는 fetch를 URL로 구분해 응답한다.
function createFetchMock({ geminiOk }) {
  const calls = { sessions: [], todayReviews: [] };

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

    if (href.includes("generativelanguage.googleapis.com")) {
      if (!geminiOk) {
        return { ok: false, status: 500, text: async () => "server error" };
      }
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '{"topic":"음악","feedback":"오늘은 음악 영상 위주로 보셨네요."}',
                  },
                ],
              },
            },
          ],
        }),
      };
    }

    if (href.endsWith("/api/sessions")) {
      calls.sessions.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ success: true }) };
    }

    if (href.endsWith("/api/today-reviews")) {
      calls.todayReviews.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ success: true }) };
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
  it("성공 경로: 카테고리 조회 → LLM 리뷰 생성 → 로컬 저장 → 서버 전송 → 알림까지 전부 맞물려 동작한다", async () => {
    global.chrome = createChromeMock();
    const { fetchMock, calls } = createFetchMock({ geminiOk: true });
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

    // 1) 로컬 세션에 분석·리뷰 결과가 반영됐는지
    const { sessions } = await global.chrome.storage.local.get("sessions");
    const saved = sessions.find((s) => s.sessionId === "s1");
    expect(saved.categoryDistribution).toEqual({ 음악: 1 });
    expect(saved.entropy).toBe(0);
    expect(saved.review).toBe("오늘은 음악 영상 위주로 보셨네요.");
    expect(saved.reviewTopic).toBe("음악");

    // 2) 알림 대상(EXP, 베이스라인 아님)이라 실제로 알림이 떴는지
    expect(global.chrome.notifications.create).toHaveBeenCalledTimes(1);

    // 3) 서버로 전송된 세션 데이터가 로컬 계산 결과와 일치하는지
    expect(calls.sessions).toHaveLength(1);
    expect(calls.sessions[0]).toMatchObject({
      anonymousId: "a1",
      sessionId: "s1",
      entropy: 0,
      llmStatus: "success",
      source: "llm",
      review: "오늘은 음악 영상 위주로 보셨네요.",
    });
    expect(calls.sessions[0].categoryDistribution).toEqual({ 음악: 1 });

    // 4) 오늘 누적 리뷰도 서버로 전송됐는지
    expect(calls.todayReviews).toHaveLength(1);
    expect(calls.todayReviews[0]).toMatchObject({
      anonymousId: "a1",
      llmStatus: "success",
      review: "오늘은 음악 영상 위주로 보셨네요.",
    });
  });

  it("LLM 실패 경로: Gemini 호출이 실패하면 폴백 리뷰로 전환되고, 실패 사유가 서버에도 그대로 기록된다", async () => {
    global.chrome = createChromeMock();
    const { fetchMock, calls } = createFetchMock({ geminiOk: false });
    global.fetch = fetchMock;

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
    await analyzeSession({
      sessionId: "s1",
      videos: [{ videoId: "v1", title: "노래 모음" }],
    });

    const { sessions } = await global.chrome.storage.local.get("sessions");
    const saved = sessions.find((s) => s.sessionId === "s1");
    // generateTodayFallbackReview의 "카테고리 1개" 문구(llm.test.js에서 이미 검증된 형태)
    expect(saved.review).toContain("음악 영상을");
    expect(saved.review).toContain("집중적으로 시청");

    expect(calls.sessions[0]).toMatchObject({
      llmStatus: "fallback",
      failureReason: "http_error",
      httpStatus: 500,
      source: "fallback",
    });
    expect(calls.todayReviews[0]).toMatchObject({
      llmStatus: "fallback",
      failureReason: "http_error",
    });
  });
});
