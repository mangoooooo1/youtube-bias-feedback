import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// E2E: 시청 감지 이후 단계 — 세션 분석 → 서버 전송(videoId 목록만 보내면 서버가
// categoryId 조회·다양성 계산·세션 저장·오늘 리뷰 생성을 한 번에 처리) → 응답 반영
// (로컬 저장·캐시) → 알림
// background.js는 manifest.json에서 type:module로 선언된 서비스워커라 export를 붙여도
// 실제 확장 동작에 영향이 없다. 모듈 최상단이 chrome.alarms.create 등 부작용을 즉시 실행하므로,
// 매 테스트마다 chrome 목을 새로 세팅한 뒤 vi.resetModules()로 모듈을 새로 import한다

// config.js는 gitignore 대상이라 로컬엔 개발자가 미리 채워둔 실제 값이 있을 수 있지만,
// CI처럼 새로 체크아웃한 환경에선 scripts/ensure-config.js가 config.example.js를 그대로
// 복사해 SERVER_URL이 "YOUR_SERVER_URL_HERE" placeholder로 남는다. background.js는 이
// placeholder를 보면 postSessionToServer를 조용히 건너뛰므로, 로컬에서만 우연히 통과하고
// CI에서는 항상 실패하는 결과가 났었다. 테스트가 로컬 파일 상태에 좌우되지 않도록 고정값으로 목킹한다.
// GEMINI_API_KEY·YOUTUBE_API_KEY 둘 다 더 이상 확장 프로그램에 없다 — "오늘 리뷰" 생성과
// categoryId 조회를 전부 서버가 직접 한다(연구 무결성 점검 항목 1 후속 조치: 확장 프로그램
// 파일을 열어보면 키가 그대로 노출되는 문제가 있었다).
vi.mock("../config.js", () => ({
  SERVER_URL: "http://localhost:3000",
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

// 서버 전송(sessions)만 나간다 — categoryId 조회는 서버 안에서 일어나므로 확장은
// googleapis를 직접 호출하지 않는다. sessions 응답의 data.categoryDistribution/entropy가
// 곧 "서버가 videoId 목록으로 계산해 돌려준 다양성 결과"이고, data.todayReview가 "서버가
// 생성해 돌려준 오늘 리뷰"다.
function createFetchMock({
  todayReview,
  categoryDistribution = { 음악: 1 },
  entropy = 0,
}) {
  const calls = { sessions: [] };

  const fetchMock = vi.fn(async (url, options = {}) => {
    const href = String(url);

    if (href.endsWith("/api/sessions")) {
      calls.sessions.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: { todayReview, categoryDistribution, entropy },
        }),
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
  it("성공 경로: 서버 전송 → 응답의 카테고리 분포·오늘 리뷰를 로컬에 반영 → 알림까지 전부 맞물려 동작한다", async () => {
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

    // 4) 서버로 전송된 세션 데이터는 categoryId 조회·다양성 계산에 필요한 videoId
    // 목록과 타이밍 지표만 담는다 — categoryDistribution/entropy는 이제 서버가 계산해
    // 응답으로 돌려주는 값이므로, 클라이언트가 직접 계산해 요청 본문에 실어 보내지 않는다.
    expect(calls.sessions).toHaveLength(1);
    expect(calls.sessions[0]).toMatchObject({
      anonymousId: "a1",
      sessionId: "s1",
      videoIds: ["v1"],
      feedbackNotifiedAt: expect.any(String),
    });
    expect(calls.sessions[0]).not.toHaveProperty("categoryDistribution");
    expect(calls.sessions[0]).not.toHaveProperty("entropy");
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
      videoIds: ["v1"],
    });
    expect(calls.sessions[0]).not.toHaveProperty("categoryDistribution");
    expect(calls.sessions[0]).not.toHaveProperty("entropy");

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
    // fetch 자체가 실패해도 analyzeSession은 예외를 던지지 않는다(postSessionToServer가
    // 네트워크 오류를 흡수해 null을 반환).
    await expect(
      analyzeSession({
        sessionId: "s1",
        videos: [{ videoId: "v1", title: "노래 모음" }],
      }),
    ).resolves.toBeUndefined();

    const { sessions } = await global.chrome.storage.local.get("sessions");
    const saved = sessions.find((s) => s.sessionId === "s1");
    // categoryDistribution/entropy는 서버 응답에서만 채워진다(전면 이관 이후 동작) —
    // 이번 요청 자체가 실패했으므로 아직 값이 없다. 이전(클라이언트가 직접 계산하던
    // 시절)에는 오프라인이어도 로컬 계산 결과가 즉시 채워졌지만, 이제는 서버 응답을
    // 받기 전까지 팝업의 카테고리 그래프가 이 세션에 대해 비어 있다 — 재시도가 성공하면
    // 채워진다(아래 retryUnsyncedSessions 스위트 참고).
    expect(saved.categoryDistribution).toBeUndefined();
    expect(saved.review).toBeUndefined();
    // 재시도 큐(retryUnsyncedSessions)가 이 세션을 찾아낼 수 있어야 하므로 false로
    // 명시돼 있어야 한다(필드 자체가 없는 것과는 구분).
    expect(saved.syncedToServer).toBe(false);

    // 알림 대상(EXP, 베이스라인 아님)이라도 서버 전송이 실패해 오늘 리뷰를 받지 못했다면
    // 알림을 띄우지 않는다 — 그렇지 않으면 "피드백이 업데이트됐어요" 알림만 뜨고
    // 팝업엔 실제 리뷰 없이 "생성 중" 상태만 보이는 불일치가 생긴다.
    expect(global.chrome.notifications.create).not.toHaveBeenCalled();
  });

  // 서버가 200을 반환해도 YouTube API 실패 등으로 categoryDistribution을
  // 아직 확정 못 했으면(null) syncedToServer를 true로 확정하지 않는다. {}·0처럼 확정값으로
  // 저장해버리면 원인이 나중에 풀려도 다시 채울 방법이 없기 때문이다.
  it("서버가 200을 반환해도 categoryDistribution이 null(분석 미완료)이면 동기화 완료로 확정하지 않는다", async () => {
    global.chrome = createChromeMock();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { categoryDistribution: null, entropy: null, todayReview: null },
      }),
    });

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
    expect(saved.categoryDistribution).toBeNull();
    // 요청 자체는 성공했지만(200) 분석이 미완료라 재시도 큐가 계속 집어가야 한다.
    expect(saved.syncedToServer).toBe(false);
  });
});

// 서버 장애 대비 로컬 큐잉/재시도 로직 (데이터 유실 방지).
// analyzeSession의 최초 전송이 실패해도 세션은 syncedToServer:false로 로컬에 남고,
// retryUnsyncedSessions(1분 알람에서 checkSessionTimeout과 함께 호출됨)가 이를 찾아 재전송
describe("retryUnsyncedSessions — 서버 장애 대비 로컬 재시도 큐", () => {
  it("최초 서버 전송이 실패해도, 재시도에서 성공하면 리뷰 반영과 알림까지 완료된다", async () => {
    global.chrome = createChromeMock();
    const calls = { sessions: [] };
    let sessionAttempt = 0;
    global.fetch = vi.fn(async (url, options = {}) => {
      const href = String(url);
      if (href.endsWith("/api/sessions")) {
        calls.sessions.push(JSON.parse(options.body));
        sessionAttempt++;
        if (sessionAttempt === 1) {
          throw new TypeError("network down"); // 최초 시도: 오프라인
        }
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: {
              categoryDistribution: { 음악: 1 },
              entropy: 0,
              todayReview: {
                reviewDate: "2026-01-10",
                review: "오늘은 음악 영상 위주로 보셨네요.",
                reviewTopic: "음악",
                source: "llm",
                promptVersion: "viewlens-today-mirror-v1.0",
              },
            },
          }),
        };
      }
      throw new Error(`예상치 못한 fetch 호출: ${href}`);
    });

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

    vi.resetModules();
    const mod = await import("../background.js");

    await mod.analyzeSession({
      sessionId: "s1",
      videos: [{ videoId: "v1", title: "노래 모음" }],
    });

    // 최초 시도는 오프라인으로 실패 — 아직 미동기화 상태, 알림도 없다.
    let { sessions } = await global.chrome.storage.local.get("sessions");
    let saved = sessions.find((s) => s.sessionId === "s1");
    expect(saved.syncedToServer).toBe(false);
    expect(saved.review).toBeUndefined();
    expect(global.chrome.notifications.create).not.toHaveBeenCalled();

    // 1분 알람 틱마다 도는 재시도 — 이번엔 서버가 정상 응답한다.
    await mod.retryUnsyncedSessions();

    ({ sessions } = await global.chrome.storage.local.get("sessions"));
    saved = sessions.find((s) => s.sessionId === "s1");
    expect(saved.syncedToServer).toBe(true);
    expect(saved.review).toBe("오늘은 음악 영상 위주로 보셨네요.");

    const { todayReviewsCache } =
      await global.chrome.storage.local.get("todayReviewsCache");
    expect(todayReviewsCache.reviews).toEqual([
      expect.objectContaining({ reviewDate: "2026-01-10" }),
    ]);

    expect(global.chrome.notifications.create).toHaveBeenCalledTimes(1);
    // 최초 시도(오프라인 실패) + 재시도(성공) — /api/sessions만 두 번 호출된다.
    expect(calls.sessions).toHaveLength(2);
  });

  it("재시도 중 서버가 409(중복 세션)를 반환하면 재전송 없이 동기화 완료로 처리하고, 서버가 돌려준 categoryDistribution/entropy로 로컬 그래프를 채운다", async () => {
    global.chrome = createChromeMock();
    const calls = { sessions: [] };
    global.fetch = vi.fn(async (url, options = {}) => {
      const href = String(url);
      if (href.endsWith("/api/sessions")) {
        calls.sessions.push(JSON.parse(options.body));
        return {
          ok: false,
          status: 409,
          text: async () =>
            JSON.stringify({
              success: false,
              data: { categoryDistribution: { 음악: 1 }, entropy: 0 },
            }),
        };
      }
      throw new Error(`예상치 못한 fetch 호출: ${href}`);
    });

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
          // 최초 시도가 이미 서버에 저장까지는 됐지만 응답을 못 받아 실패로 남았던
          // 상황을 재현한다 — categoryDistribution/entropy는 서버 응답에서만 채워지므로
          // (전면 이관 이후), 이 시점엔 아직 로컬에 없는 게 정상이다.
          videoCount: 1,
          syncedToServer: false,
        },
      ],
    });

    vi.resetModules();
    const mod = await import("../background.js");
    await mod.retryUnsyncedSessions();

    const { sessions } = await global.chrome.storage.local.get("sessions");
    const saved = sessions.find((s) => s.sessionId === "s1");
    // 서버엔 이미 반영돼 있던 것(중복 오류)이므로, 다시 보내지 않고 동기화 완료로 처리한다.
    expect(saved.syncedToServer).toBe(true);
    expect(saved.review).toBeUndefined();
    // 409 응답에 실려온 categoryDistribution/entropy로 로컬 카테고리 그래프가 채워진다
    // (코드리뷰 반영 전에는 이 값이 비어있는 게 알려진 트레이드오프였다).
    expect(saved.categoryDistribution).toEqual({ 음악: 1 });
    expect(saved.entropy).toBe(0);
    expect(calls.sessions).toHaveLength(1);
  });

  it("이미 동기화됐거나(true) 이 기능 이전에 만들어져 필드 자체가 없는 세션은 건드리지 않는다", async () => {
    global.chrome = createChromeMock();
    const calls = { sessions: [] };
    global.fetch = vi.fn(async (url) => {
      calls.sessions.push(String(url));
      return {
        ok: true,
        json: async () => ({ success: true, data: { todayReview: null } }),
      };
    });

    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "EXP",
      installDate: new Date(2025, 0, 1).toISOString(),
      sessions: [
        {
          sessionId: "s-already-synced",
          categoryDistribution: { 음악: 1 },
          entropy: 0,
          videoCount: 1,
          syncedToServer: true,
        },
        {
          // syncedToServer 필드 자체가 없음 — 이 재시도 기능이 생기기 전에 이미
          // 분석·전송됐던(혹은 실패했던) 레거시 세션. 일괄 재전송 대상이 아니다.
          sessionId: "s-legacy",
          categoryDistribution: { 음악: 1 },
          entropy: 0,
          videoCount: 1,
        },
        {
          // 아직 분석 자체가 끝나지 않은 세션(categoryDistribution 없음).
          sessionId: "s-not-analyzed-yet",
        },
      ],
    });

    vi.resetModules();
    const mod = await import("../background.js");
    await mod.retryUnsyncedSessions();

    expect(calls.sessions).toHaveLength(0);
  });

  // 알람 리스너는 retryUnsyncedSessions/retryUnsentVideoEvents/checkSessionTimeout을
  // await 없이 나란히 호출한다 — 즉 같은 세션을 두 경로가 "동시에" 다시 시도할 수 있다
  // (예: checkSessionTimeout이 막 끝낸 세션을, 같은 틱의 retryUnsyncedSessions가 곧바로
  // 집는 경우). 이 테스트는 그 경합을 재현해, 서버의 409(중복 세션) 응답 덕분에 알림이
  // 두 번 뜨거나 오늘 리뷰 캐시가 잘못 반영되지 않음을 확인한다.
  it("같은 세션을 두 경로가 동시에 재시도해도(경합) 알림은 한 번만 뜬다", async () => {
    global.chrome = createChromeMock();
    const calls = { sessions: [] };
    let sessionAttempt = 0;
    global.fetch = vi.fn(async (url, options = {}) => {
      const href = String(url);
      if (href.endsWith("/api/sessions")) {
        calls.sessions.push(JSON.parse(options.body));
        sessionAttempt++;
        // 첫 요청이 서버에 실제로 먼저 도착해 저장을 마쳤다고 가정 — 두 번째는 UNIQUE
        // 제약(sessionId)에 걸려 409를 받는다(실제 동시 요청에서 서버가 보이는 동작).
        if (sessionAttempt === 1) {
          return {
            ok: true,
            json: async () => ({
              success: true,
              data: {
                categoryDistribution: { 음악: 1 },
                entropy: 0,
                todayReview: {
                  reviewDate: "2026-01-10",
                  review: "오늘은 음악 영상 위주로 보셨네요.",
                  reviewTopic: "음악",
                  source: "llm",
                  promptVersion: "viewlens-today-mirror-v1.0",
                },
              },
            }),
          };
        }
        // 실제 서버는 409에도 이미 저장된 categoryDistribution/entropy를 본문에 함께
        // 돌려준다(승자 요청이 방금 계산해 저장한 값과 같다) — 빈 문자열이 아니다.
        return {
          ok: false,
          status: 409,
          text: async () =>
            JSON.stringify({
              success: false,
              data: { categoryDistribution: { 음악: 1 }, entropy: 0 },
            }),
        };
      }
      throw new Error(`예상치 못한 fetch 호출: ${href}`);
    });

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
          categoryDistribution: { 음악: 1 },
          entropy: 0,
          videoCount: 1,
          syncedToServer: false,
        },
      ],
    });

    vi.resetModules();
    const mod = await import("../background.js");
    // 알람 리스너와 동일하게 await 없이 나란히 호출해 실제 경합 타이밍을 재현한다.
    await Promise.all([
      mod.retryUnsyncedSessions(),
      mod.retryUnsyncedSessions(),
    ]);

    expect(calls.sessions).toHaveLength(2);
    // 승자(200)든 패자(409)든 최종적으로 동기화 완료 상태로 수렴한다.
    const { sessions } = await global.chrome.storage.local.get("sessions");
    expect(sessions.find((s) => s.sessionId === "s1").syncedToServer).toBe(
      true,
    );
    // 알림은 승자 쪽 한 번만 뜬다 — 패자는 "DUPLICATE"를 보고 즉시 반환하므로
    // showFeedbackNotification을 다시 호출하지 않는다.
    expect(global.chrome.notifications.create).toHaveBeenCalledTimes(1);
  });
});

// 연구 무결성 점검: content.js의 /api/video-events 즉시 전송은 fire-and-forget이라
// 실패해도 그 자리에서 조용히 버려졌다. retryUnsentVideoEvents(1분 알람에서
// checkSessionTimeout·retryUnsyncedSessions와 함께 호출됨)가 sent:true가 안 된 영상
// 이벤트를 세션 종료 전(video__ 키)·후(sessions[].videos) 가리지 않고 찾아 재전송한다.
describe("retryUnsentVideoEvents — 영상 이벤트 서버 장애 대비 재시도 큐", () => {
  it("세션 종료 전(video__ 키)에 남은 미전송 영상을 재전송하고 sent:true로 표시한다", async () => {
    global.chrome = createChromeMock();
    const calls = { videoEvents: [] };
    global.fetch = vi.fn(async (url, options = {}) => {
      const href = String(url);
      if (href.endsWith("/api/video-events")) {
        calls.videoEvents.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ success: true }) };
      }
      throw new Error(`예상치 못한 fetch 호출: ${href}`);
    });

    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "EXP",
      installDate: new Date(2025, 0, 1).toISOString(),
      currentSession: { sessionId: "s1", startTime: "2026-01-10T11:00:00Z" },
      video__s1__uuid1: {
        videoId: "v1",
        title: "노래 모음",
        watchedAt: "2026-01-10T11:00:00Z",
        sent: false, // 최초 즉시 전송(content.js)이 실패해 남은 상태
        eventId: "uuid1", // content.js가 최초 시도 때 발급해둔 멱등 키
      },
    });

    vi.resetModules();
    const mod = await import("../background.js");
    await mod.retryUnsentVideoEvents();

    expect(calls.videoEvents).toHaveLength(1);
    expect(calls.videoEvents[0]).toMatchObject({
      anonymousId: "a1",
      videoId: "v1",
      sessionId: "s1",
      // 최초 시도와 같은 eventId를 재전송해야 서버가 OR IGNORE로 중복을 걸러낸다.
      eventId: "uuid1",
    });

    const all = await global.chrome.storage.local.get(null);
    expect(all["video__s1__uuid1"].sent).toBe(true);
  });

  it("세션 종료 후(sessions[].videos)에 남은 미전송 영상도 재전송하고 sent:true로 표시한다", async () => {
    global.chrome = createChromeMock();
    const calls = { videoEvents: [] };
    global.fetch = vi.fn(async (url, options = {}) => {
      const href = String(url);
      if (href.endsWith("/api/video-events")) {
        calls.videoEvents.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ success: true }) };
      }
      throw new Error(`예상치 못한 fetch 호출: ${href}`);
    });

    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "EXP",
      installDate: new Date(2025, 0, 1).toISOString(),
      sessions: [
        {
          sessionId: "s1",
          startTime: "2026-01-10T11:00:00Z",
          endTime: "2026-01-10T11:20:00Z",
          videos: [
            {
              videoId: "v1",
              title: "노래 모음",
              watchedAt: "2026-01-10T11:00:00Z",
              sent: true, // 이미 성공 — 건드리면 안 됨
            },
            {
              videoId: "v2",
              title: "게임 하이라이트",
              watchedAt: "2026-01-10T11:10:00Z",
              sent: false, // 세션이 끝날 때까지 전송이 안 됐던 영상
            },
          ],
        },
      ],
    });

    vi.resetModules();
    const mod = await import("../background.js");
    await mod.retryUnsentVideoEvents();

    // 이미 sent:true인 v1은 다시 보내지 않는다.
    expect(calls.videoEvents).toHaveLength(1);
    expect(calls.videoEvents[0]).toMatchObject({
      anonymousId: "a1",
      videoId: "v2",
      sessionId: "s1",
    });

    const { sessions } = await global.chrome.storage.local.get("sessions");
    const videos = sessions[0].videos;
    expect(videos.find((v) => v.videoId === "v1").sent).toBe(true);
    expect(videos.find((v) => v.videoId === "v2").sent).toBe(true);
  });

  it("재전송도 실패하면 sent:false로 남겨 다음 알람 틱에서 다시 시도할 수 있게 한다", async () => {
    global.chrome = createChromeMock();
    global.fetch = vi.fn().mockRejectedValue(new TypeError("network down"));

    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "EXP",
      installDate: new Date(2025, 0, 1).toISOString(),
      video__s1__uuid1: {
        videoId: "v1",
        title: "노래 모음",
        watchedAt: "2026-01-10T11:00:00Z",
        sent: false,
      },
    });

    vi.resetModules();
    const mod = await import("../background.js");
    await mod.retryUnsentVideoEvents();

    const all = await global.chrome.storage.local.get(null);
    expect(all["video__s1__uuid1"].sent).toBe(false);
  });

  it("anonymousId가 없으면(온보딩 전) 아무것도 시도하지 않는다", async () => {
    global.chrome = createChromeMock();
    const calls = [];
    global.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ success: true }) };
    });

    await global.chrome.storage.local.set({
      video__s1__uuid1: {
        videoId: "v1",
        title: "노래 모음",
        watchedAt: "2026-01-10T11:00:00Z",
        sent: false,
      },
    });

    vi.resetModules();
    const mod = await import("../background.js");
    await mod.retryUnsentVideoEvents();

    expect(calls).toHaveLength(0);
  });

  it("sent 필드 자체가 없는 레거시 영상은 재전송하지 않는다(확장 업데이트 직후 대량 중복 방지)", async () => {
    global.chrome = createChromeMock();
    const calls = [];
    global.fetch = vi.fn(async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ success: true }) };
    });

    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "EXP",
      installDate: new Date(2025, 0, 1).toISOString(),
      // 이 재시도 큐가 생기기 전(구버전 content.js)에 기록된 영상 — sent 필드가 없다.
      // 대부분 이미 서버 전송에 성공한 상태라, 이걸 재전송하면 eventId도 없어
      // video_events에 영구 중복 행이 쌓인다.
      video__s1__legacy: {
        videoId: "v1",
        title: "노래 모음",
        watchedAt: "2026-01-10T11:00:00Z",
      },
      sessions: [
        {
          sessionId: "s2",
          videos: [
            { videoId: "v2", title: "게임", watchedAt: "2026-01-10T12:00:00Z" },
          ],
        },
      ],
    });

    vi.resetModules();
    const mod = await import("../background.js");
    await mod.retryUnsentVideoEvents();

    expect(calls).toHaveLength(0);
  });
});
