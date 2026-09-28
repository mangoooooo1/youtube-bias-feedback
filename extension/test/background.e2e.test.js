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
        remove: (keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
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
const ACTIVE_INSTALL_DATE = new Date(2026, 0, 5).toISOString();

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
      installDate: ACTIVE_INSTALL_DATE, // 베이스라인 훨씬 지남 → 알림 대상
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
      installDate: ACTIVE_INSTALL_DATE,
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
      installDate: ACTIVE_INSTALL_DATE,
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
      installDate: ACTIVE_INSTALL_DATE,
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
      installDate: ACTIVE_INSTALL_DATE,
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
          json: async () => ({
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
      installDate: ACTIVE_INSTALL_DATE,
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
      installDate: ACTIVE_INSTALL_DATE,
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
          json: async () => ({
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
      installDate: ACTIVE_INSTALL_DATE,
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
    // checkSessionTimeout의 최초 전송(analyzeSession)과 재시도 큐를 나란히 호출해 실제 경합을 재현한다.
    // 같은 큐의 중복 실행은 재진입 가드가 막으므로, 409가 필요한 건 서로 다른 두 경로의 경합이다.
    const [session] = (await global.chrome.storage.local.get("sessions"))
      .sessions;
    await Promise.all([
      mod.analyzeSession(session),
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
      installDate: ACTIVE_INSTALL_DATE,
      currentSession: { sessionId: "s1", startTime: "2026-01-10T11:00:00Z" },
      video__s1__uuid1: {
        videoId: "v1",
        title: "노래 모음",
        watchedAt: "2026-01-10T11:00:00Z",
        sent: false, // 최초 즉시 전송(content.js)이 실패해 남은 상태
        eventId: "uuid1", // content.js가 최초 시도 때 발급해둔 멱등 키
        isShortsUrl: 1,
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
      // coderabbitai 리뷰: 재시도 경로가 이 값을 빠뜨리면 서버에 NULL로 저장된다.
      isShortsUrl: 1,
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
      installDate: ACTIVE_INSTALL_DATE,
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
      installDate: ACTIVE_INSTALL_DATE,
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
      installDate: ACTIVE_INSTALL_DATE,
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

// 시청시간 원시 데이터 재시도 큐 — content.js의 finalizePreviousWatchStats나
// pagehide 핸들러가 남겨둔, 아직 서버에 확정 반영 못한 watchedSeconds를 찾아 PATCH로
// 재전송한다. video-events(POST, "봤다")와는 독립된 별도 큐다.
describe("retryUnsentWatchStats — 시청시간 서버 장애 대비 재시도 큐", () => {
  it("세션 종료 전(video__ 키)에 남은 미반영 시청시간을 PATCH로 재전송하고 watchStatsSent:true로 표시한다", async () => {
    global.chrome = createChromeMock();
    const calls = { patches: [] };
    global.fetch = vi.fn(async (url, options = {}) => {
      const href = String(url);
      if (href.includes("/api/video-events/") && options.method === "PATCH") {
        calls.patches.push({ url: href, body: JSON.parse(options.body) });
        return { ok: true, json: async () => ({ success: true }) };
      }
      throw new Error(`예상치 못한 fetch 호출: ${href}`);
    });

    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "EXP",
      installDate: ACTIVE_INSTALL_DATE,
      video__s1__uuid1: {
        videoId: "v1",
        eventId: "uuid1",
        watchedSeconds: 42,
        playbackRate: 1,
        wasBackgrounded: 0,
        watchStatsSent: false,
      },
    });

    vi.resetModules();
    const mod = await import("../background.js");
    await mod.retryUnsentWatchStats();

    expect(calls.patches).toHaveLength(1);
    expect(calls.patches[0].url).toBe(
      "http://localhost:3000/api/video-events/uuid1",
    );
    expect(calls.patches[0].body).toMatchObject({
      anonymousId: "a1",
      watchedSeconds: 42,
      playbackRate: 1,
      wasBackgrounded: 0,
    });

    const all = await global.chrome.storage.local.get(null);
    expect(all["video__s1__uuid1"].watchStatsSent).toBe(true);
  });

  it("세션 종료 후(sessions[].videos)에 남은 미반영 시청시간도 재전송한다", async () => {
    global.chrome = createChromeMock();
    const calls = { patches: [] };
    global.fetch = vi.fn(async (url, options = {}) => {
      if (options.method === "PATCH") {
        calls.patches.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ success: true }) };
      }
      throw new Error(`예상치 못한 fetch 호출: ${url}`);
    });

    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "EXP",
      installDate: ACTIVE_INSTALL_DATE,
      sessions: [
        {
          sessionId: "s1",
          videos: [
            {
              videoId: "v1",
              eventId: "e1",
              watchedSeconds: 10,
              watchStatsSent: true, // 이미 반영 — 건드리면 안 됨
            },
            {
              videoId: "v2",
              eventId: "e2",
              watchedSeconds: 55,
              watchStatsSent: false,
            },
          ],
        },
      ],
    });

    vi.resetModules();
    const mod = await import("../background.js");
    await mod.retryUnsentWatchStats();

    expect(calls.patches).toHaveLength(1);
    expect(calls.patches[0]).toMatchObject({ watchedSeconds: 55 });

    const { sessions } = await global.chrome.storage.local.get("sessions");
    const videos = sessions[0].videos;
    expect(videos.find((v) => v.videoId === "v1").watchStatsSent).toBe(true);
    expect(videos.find((v) => v.videoId === "v2").watchStatsSent).toBe(true);
  });

  it("재전송도 실패하면 watchStatsSent:false로 남겨 다음 알람 틱에서 다시 시도할 수 있게 한다", async () => {
    global.chrome = createChromeMock();
    global.fetch = vi.fn().mockRejectedValue(new TypeError("network down"));

    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "EXP",
      installDate: ACTIVE_INSTALL_DATE,
      video__s1__uuid1: {
        videoId: "v1",
        eventId: "uuid1",
        watchedSeconds: 42,
        watchStatsSent: false,
      },
    });

    vi.resetModules();
    const mod = await import("../background.js");
    await mod.retryUnsentWatchStats();

    const all = await global.chrome.storage.local.get(null);
    expect(all["video__s1__uuid1"].watchStatsSent).toBe(false);
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
        eventId: "uuid1",
        watchedSeconds: 42,
        watchStatsSent: false,
      },
    });

    vi.resetModules();
    const mod = await import("../background.js");
    await mod.retryUnsentWatchStats();

    expect(calls).toHaveLength(0);
  });
});

// 세션 POST 페이로드에 시청시간 원시 데이터(watchedSecondsList)가 실려 가는지
// 서버가 이 값으로 클릭성 이탈을 걸러내고 시간 가중 entropy를 계산한다.
describe("analyzeSession — watchedSecondsList를 세션 페이로드에 함께 보낸다", () => {
  it("videos 배열의 watchedSeconds를 videoIds와 같은 순서의 병렬 배열로 변환해 보낸다", async () => {
    global.chrome = createChromeMock();
    const { fetchMock, calls } = createFetchMock({ todayReview: null });
    global.fetch = fetchMock;

    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "EXP",
      installDate: ACTIVE_INSTALL_DATE,
      sessions: [
        {
          sessionId: "s1",
          startTime: new Date(2026, 0, 10, 11, 50).toISOString(),
          endTime: FIXED_NOW.toISOString(),
          videos: [
            { videoId: "v1", title: "노래 모음", watchedSeconds: 42 },
            { videoId: "v2", title: "게임", watchedSeconds: null },
          ],
        },
      ],
    });

    const analyzeSession = await loadAnalyzeSession();
    await analyzeSession({
      sessionId: "s1",
      videos: [
        { videoId: "v1", title: "노래 모음", watchedSeconds: 42 },
        { videoId: "v2", title: "게임", watchedSeconds: null },
      ],
    });

    expect(calls.sessions[0]).toMatchObject({
      videoIds: ["v1", "v2"],
      watchedSecondsList: [42, null],
    });
  });

  it("watchedSeconds 필드 자체가 없는 영상은(구기능·계측 실패) null로 보낸다", async () => {
    global.chrome = createChromeMock();
    const { fetchMock, calls } = createFetchMock({ todayReview: null });
    global.fetch = fetchMock;

    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "EXP",
      installDate: ACTIVE_INSTALL_DATE,
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

    expect(calls.sessions[0].watchedSecondsList).toEqual([null]);
  });
});

describe("sendToServer — 재시도 큐가 판단할 수 있도록 전송 결과를 분류한다", () => {
  async function loadSendToServer() {
    global.chrome = createChromeMock();
    vi.resetModules();
    const mod = await import("../background.js");
    return mod.sendToServer;
  }

  function respond(status, body) {
    return vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }));
  }

  // 실제 fetch처럼 signal이 abort되면 AbortError로 reject하고, 그 전엔 응답하지 않는다
  function hangUntilAborted() {
    return vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
  }

  it("2xx는 success로 분류하고 본문의 data를 돌려준다", async () => {
    const sendToServer = await loadSendToServer();
    global.fetch = respond(200, { success: true, data: { id: 1 } });

    await expect(sendToServer("/api/x", "POST", {})).resolves.toEqual({
      ok: true,
      kind: "success",
      status: 200,
      code: null,
      data: { id: 1 },
    });
  });

  it("400은 항목 레벨(item)로 분류하고 서버가 보낸 code를 담는다", async () => {
    const sendToServer = await loadSendToServer();
    global.fetch = respond(400, {
      success: false,
      code: "INVALID_FIELD_VALUE",
    });

    await expect(sendToServer("/api/x", "POST", {})).resolves.toMatchObject({
      ok: false,
      kind: "item",
      status: 400,
      code: "INVALID_FIELD_VALUE",
    });
  });

  it("404·403·429·5xx는 큐 레벨(queue)로 분류한다", async () => {
    const sendToServer = await loadSendToServer();
    for (const [status, code] of [
      [404, "NOT_FOUND"],
      [403, "INVALID_PARTICIPANT_TOKEN"],
      [429, "TOO_MANY_REQUESTS"],
      [500, "INTERNAL_SERVER_ERROR"],
    ]) {
      global.fetch = respond(status, { success: false, code });
      await expect(sendToServer("/api/x", "POST", {})).resolves.toMatchObject({
        ok: false,
        kind: "queue",
        status,
        code,
      });
    }
  });

  it("본문이 JSON이 아니어도 status만으로 분류한다", async () => {
    const sendToServer = await loadSendToServer();
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }));

    await expect(sendToServer("/api/x", "POST", {})).resolves.toMatchObject({
      ok: false,
      kind: "queue",
      status: 502,
      code: null,
    });
  });

  it("네트워크 오류는 큐 레벨, code는 network로 분류한다", async () => {
    const sendToServer = await loadSendToServer();
    global.fetch = vi.fn().mockRejectedValue(new TypeError("network down"));

    await expect(sendToServer("/api/x", "POST", {})).resolves.toMatchObject({
      ok: false,
      kind: "queue",
      status: null,
      code: "network",
    });
  });

  it("기본 5초가 지나면 요청을 abort하고 code를 timeout으로 분류한다", async () => {
    const sendToServer = await loadSendToServer();
    global.fetch = hangUntilAborted();

    const pending = sendToServer("/api/x", "POST", {});
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      kind: "queue",
      status: null,
      code: "timeout",
    });
  });

  it("세션 전송은 서버의 YouTube·Gemini 호출을 기다리도록 5초에 끊지 않고 60초에 끊는다", async () => {
    global.chrome = createChromeMock();
    global.fetch = hangUntilAborted();
    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "EXP",
      installDate: ACTIVE_INSTALL_DATE,
      sessions: [
        {
          sessionId: "s1",
          videos: [{ videoId: "v1" }],
          syncedToServer: false,
        },
      ],
    });

    vi.resetModules();
    const mod = await import("../background.js");
    let settled = false;
    const pending = mod.retryUnsyncedSessions().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(55000);
    await pending;
    expect(settled).toBe(true);

    const { sessions } = await global.chrome.storage.local.get("sessions");
    expect(sessions[0].syncedToServer).toBe(false);
  });
});

describe("알람 핸들러 — 시청시간 PATCH는 영상 POST 재시도가 끝난 뒤 보낸다", () => {
  it("같은 틱에서 POST가 확정된 영상의 시청시간을 곧바로 PATCH하고, POST보다 먼저 보내지 않는다", async () => {
    global.chrome = createChromeMock();
    const order = [];
    global.fetch = vi.fn(async (url, options = {}) => {
      order.push(`${options.method} ${new URL(String(url)).pathname}`);
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });

    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "EXP",
      installDate: ACTIVE_INSTALL_DATE,
      // 이 테스트의 관심사는 POST→PATCH 순서뿐이므로 등록 게이트는 열어 둔다
      // (게이트가 닫힌 채 알람이 도는 흐름은 "등록 게이트" describe에서 검증한다).
      participantSynced: true,
      video__s1__e1: {
        videoId: "v1",
        watchedAt: "2026-01-10T11:00:00Z",
        eventId: "e1",
        sent: false,
        watchedSeconds: 42,
        watchStatsSent: false,
      },
    });

    vi.resetModules();
    await import("../background.js");
    const onAlarm = global.chrome.alarms.onAlarm.addListener.mock.calls[0][0];
    onAlarm({ name: "SESSION_TIMEOUT_CHECK" });
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual([
      "POST /api/video-events",
      "PATCH /api/video-events/e1",
    ]);
  });
});

describe("재시도 큐 fail-fast — 큐 전체에 공통된 실패면 한 틱에 1건만 보낸다", () => {
  const BASE = {
    anonymousId: "a1",
    group: "EXP",
    installDate: ACTIVE_INSTALL_DATE,
  };

  function unsentVideos(count) {
    return Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `video__s1__e${i}`,
        {
          videoId: `v${i}`,
          watchedAt: "2026-01-10T11:00:00Z",
          eventId: `e${i}`,
          sent: false,
        },
      ]),
    );
  }

  async function loadBackground(storage) {
    global.chrome = createChromeMock();
    await global.chrome.storage.local.set(storage);
    vi.resetModules();
    return import("../background.js");
  }

  function sentFlags(all) {
    return Object.entries(all)
      .filter(([key]) => key.startsWith("video__"))
      .map(([, v]) => v.sent);
  }

  it.each([
    ["404 참여자 미등록", { ok: false, status: 404, code: "NOT_FOUND" }],
    [
      "500 서버 장애",
      { ok: false, status: 500, code: "INTERNAL_SERVER_ERROR" },
    ],
    [
      "403 토큰 불일치",
      { ok: false, status: 403, code: "INVALID_PARTICIPANT_TOKEN" },
    ],
  ])(
    "%s면 백로그 5건 중 1건만 보내고 전부 큐에 남긴다",
    async (_label, res) => {
      const mod = await loadBackground({ ...BASE, ...unsentVideos(5) });
      global.fetch = vi.fn(async () => ({
        ok: res.ok,
        status: res.status,
        json: async () => ({ success: false, code: res.code }),
      }));

      await mod.retryUnsentVideoEvents();

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const all = await global.chrome.storage.local.get(null);
      expect(sentFlags(all)).toEqual([false, false, false, false, false]);
    },
  );

  it("네트워크 오류도 1건만 보내고 중단한다", async () => {
    const mod = await loadBackground({ ...BASE, ...unsentVideos(5) });
    global.fetch = vi.fn().mockRejectedValue(new TypeError("network down"));

    await mod.retryUnsentVideoEvents();

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("타임아웃도 1건만 보내고 중단한다", async () => {
    const mod = await loadBackground({ ...BASE, ...unsentVideos(5) });
    global.fetch = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );

    const pending = mod.retryUnsentVideoEvents();
    await vi.advanceTimersByTimeAsync(5000);
    await pending;

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("400은 그 항목만 영구 실패로 표시하고 같은 틱에서 뒤 항목을 계속 보낸다", async () => {
    const mod = await loadBackground({ ...BASE, ...unsentVideos(3) });
    global.fetch = vi.fn(async (_url, options) => {
      const { eventId } = JSON.parse(options.body);
      const bad = eventId === "e0";
      return {
        ok: !bad,
        status: bad ? 400 : 200,
        json: async () =>
          bad
            ? { success: false, code: "INVALID_FIELD_VALUE" }
            : { success: true },
      };
    });

    await mod.retryUnsentVideoEvents();

    expect(global.fetch).toHaveBeenCalledTimes(3);
    const all = await global.chrome.storage.local.get(null);
    expect(all["video__s1__e0"].sent).toBe("invalid");
    expect(all["video__s1__e1"].sent).toBe(true);
    expect(all["video__s1__e2"].sent).toBe(true);
  });

  it("백로그가 50건을 넘으면 한 틱에 50건만 보내고 나머지는 다음 틱으로 넘긴다", async () => {
    const mod = await loadBackground({ ...BASE, ...unsentVideos(60) });
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    }));

    await mod.retryUnsentVideoEvents();
    expect(global.fetch).toHaveBeenCalledTimes(50);

    await mod.retryUnsentVideoEvents();
    expect(global.fetch).toHaveBeenCalledTimes(60);
    const all = await global.chrome.storage.local.get(null);
    expect(sentFlags(all).every((sent) => sent === true)).toBe(true);
  });

  it("이전 틱이 아직 진행 중이면 같은 큐의 다음 틱은 요청을 보내지 않는다", async () => {
    const mod = await loadBackground({ ...BASE, ...unsentVideos(2) });
    let release;
    global.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ ok: true, status: 200, json: async () => ({}) });
        }),
    );

    const first = mod.retryUnsentVideoEvents();
    await vi.advanceTimersByTimeAsync(0);
    await mod.retryUnsentVideoEvents();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await first;
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("시청시간 큐도 404면 1건만 보내고 중단한다", async () => {
    const mod = await loadBackground({
      ...BASE,
      ...Object.fromEntries(
        [0, 1, 2].map((i) => [
          `video__s1__e${i}`,
          {
            eventId: `e${i}`,
            sent: true,
            watchedSeconds: 10,
            watchStatsSent: false,
          },
        ]),
      ),
    });
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ success: false, code: "NOT_FOUND" }),
    }));

    await mod.retryUnsentWatchStats();

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("세션 큐는 404면 1건만 보내고 중단하고, 409는 성공으로 보고 다음 세션으로 넘어간다", async () => {
    const sessions = ["s1", "s2", "s3"].map((sessionId) => ({
      sessionId,
      videos: [{ videoId: "v1" }],
      syncedToServer: false,
    }));

    let mod = await loadBackground({ ...BASE, sessions });
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ success: false, code: "NOT_FOUND" }),
    }));
    await mod.retryUnsyncedSessions();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    mod = await loadBackground({ ...BASE, sessions });
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        data: { categoryDistribution: { 음악: 1 }, entropy: 0 },
      }),
    }));
    await mod.retryUnsyncedSessions();
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("대기 항목이 있으면 틱당 로그를 1줄만 남기고, 없으면 남기지 않는다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const mod = await loadBackground({ ...BASE, ...unsentVideos(5) });
      global.fetch = vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ success: false, code: "NOT_FOUND" }),
      }));

      await mod.retryUnsentVideoEvents();
      const queueLines = () =>
        [...warn.mock.calls, ...log.mock.calls]
          .map(([line]) => line)
          .filter((line) => String(line).includes("queue="));
      expect(queueLines()).toEqual([
        "[background] queue=video_events result=abort status=404 code=NOT_FOUND pending=5 sentThisTick=0 invalidThisTick=0",
      ]);

      await mod.retryUnsentWatchStats();
      expect(queueLines()).toHaveLength(1);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});

describe("400 영구 실패 — 서버가 영원히 거부할 항목은 표시하고 다시 보내지 않는다", () => {
  const BASE = {
    anonymousId: "a1",
    group: "EXP",
    installDate: ACTIVE_INSTALL_DATE,
  };

  function reject400() {
    return vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ success: false, code: "INVALID_FIELD_VALUE" }),
    }));
  }

  async function loadBackground(storage) {
    global.chrome = createChromeMock();
    await global.chrome.storage.local.set(storage);
    vi.resetModules();
    return import("../background.js");
  }

  it("영상 이벤트: live·종료된 세션 양쪽 모두 sent:invalid가 되고 다음 틱엔 보내지 않는다", async () => {
    const mod = await loadBackground({
      ...BASE,
      video__s1__e1: {
        videoId: "v1",
        watchedAt: "2026-01-10T11:00:00Z",
        eventId: "e1",
        sent: false,
      },
      sessions: [
        {
          sessionId: "s0",
          videos: [
            {
              videoId: "v0",
              watchedAt: "2026-01-10T10:00:00Z",
              eventId: "e0",
              sent: false,
            },
          ],
        },
      ],
    });
    global.fetch = reject400();

    await mod.retryUnsentVideoEvents();
    await mod.retryUnsentVideoEvents();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const all = await global.chrome.storage.local.get(null);
    expect(all["video__s1__e1"].sent).toBe("invalid");
    expect(all.sessions[0].videos[0].sent).toBe("invalid");
  });

  it("시청시간: watchStatsSent:invalid가 되고 다음 틱엔 보내지 않는다", async () => {
    const mod = await loadBackground({
      ...BASE,
      video__s1__e1: {
        eventId: "e1",
        sent: true,
        watchedSeconds: -5,
        watchStatsSent: false,
      },
    });
    global.fetch = reject400();

    await mod.retryUnsentWatchStats();
    await mod.retryUnsentWatchStats();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const all = await global.chrome.storage.local.get(null);
    expect(all["video__s1__e1"].watchStatsSent).toBe("invalid");
  });

  it("시청시간: eventId가 없는 항목은 요청 없이 invalid로 표시한다", async () => {
    const mod = await loadBackground({
      ...BASE,
      video__s1__noid: {
        sent: true,
        watchedSeconds: 10,
        watchStatsSent: false,
      },
    });
    global.fetch = vi.fn();

    await mod.retryUnsentWatchStats();

    expect(global.fetch).not.toHaveBeenCalled();
    const all = await global.chrome.storage.local.get(null);
    expect(all["video__s1__noid"].watchStatsSent).toBe("invalid");
  });

  it("세션: syncedToServer:invalid가 되고 다음 틱엔 보내지 않는다", async () => {
    const mod = await loadBackground({
      ...BASE,
      sessions: [
        { sessionId: "s1", videos: [{ videoId: "v1" }], syncedToServer: false },
      ],
    });
    global.fetch = reject400();

    await mod.retryUnsyncedSessions();
    await mod.retryUnsyncedSessions();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const { sessions } = await global.chrome.storage.local.get("sessions");
    expect(sessions[0].syncedToServer).toBe("invalid");
  });

  it("영상 POST가 invalid인 항목의 시청시간은 대상에서 뺀다", async () => {
    const mod = await loadBackground({
      ...BASE,
      video__s1__e1: {
        eventId: "e1",
        sent: "invalid",
        watchedSeconds: 10,
        watchStatsSent: false,
      },
    });
    global.fetch = vi.fn();

    await mod.retryUnsentWatchStats();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("400 항목이 50건 넘게 앞에 있어도 다음 틱에 뒤 항목이 전송된다", async () => {
    const storage = { ...BASE };
    for (let i = 0; i < 55; i++) {
      storage[`video__s1__e${String(i).padStart(2, "0")}`] = {
        videoId: `v${i}`,
        watchedAt: "2026-01-10T11:00:00Z",
        eventId: `bad${i}`,
        sent: false,
      };
    }
    storage.video__s1__zz = {
      videoId: "good",
      watchedAt: "2026-01-10T11:00:00Z",
      eventId: "good",
      sent: false,
    };
    const mod = await loadBackground(storage);
    global.fetch = vi.fn(async (_url, options) => {
      const good = JSON.parse(options.body).eventId === "good";
      return {
        ok: good,
        status: good ? 200 : 400,
        json: async () => ({ success: good }),
      };
    });

    await mod.retryUnsentVideoEvents();
    await mod.retryUnsentVideoEvents();

    const all = await global.chrome.storage.local.get(null);
    expect(all.video__s1__zz.sent).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(56);
  });

  it("영구 실패로 표시한 항목은 식별자와 함께 1줄씩 로그를 남긴다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const mod = await loadBackground({
        ...BASE,
        video__s1__e1: {
          videoId: "v1",
          watchedAt: "2026-01-10T11:00:00Z",
          eventId: "e1",
          sent: false,
        },
      });
      global.fetch = reject400();

      await mod.retryUnsentVideoEvents();

      expect(warn.mock.calls.map(([line]) => line)).toContain(
        "[background] queue=video_events result=skip_item status=400 code=INVALID_FIELD_VALUE id=e1",
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("참여자 등록 게이트 — 팝업을 열지 않아도 알람이 재등록한다", () => {
  const BASE = {
    anonymousId: "a1",
    group: "EXP",
    participantCode: "QWE-AB23",
    installDate: ACTIVE_INSTALL_DATE,
  };

  async function loadBackground(storage) {
    global.chrome = createChromeMock();
    await global.chrome.storage.local.set(storage);
    vi.resetModules();
    return import("../background.js");
  }

  function respond(status, body = {}) {
    return vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }));
  }

  it("등록이 확인되지 않은 상태면 참여코드·설치일을 담아 재등록을 시도한다", async () => {
    const mod = await loadBackground(BASE);
    global.fetch = respond(200, {
      success: true,
      data: { participantToken: "tok" },
    });

    await mod.ensureParticipantSynced();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(String(url)).toContain("/api/participants");
    expect(JSON.parse(options.body)).toEqual({
      anonymousId: "a1",
      participantCode: "QWE-AB23",
      group_code: "EXP",
      installDate: BASE.installDate,
    });

    const all = await global.chrome.storage.local.get(null);
    expect(all.participantSynced).toBe(true);
    expect(all.participantToken).toBe("tok");
    expect(all.participantSyncFailure).toBeUndefined();
  });

  it("이미 등록된 상태면 요청을 보내지 않는다", async () => {
    const mod = await loadBackground({ ...BASE, participantSynced: true });
    global.fetch = respond(200);

    await mod.ensureParticipantSynced();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("온보딩 전이면(group 없음) 요청을 보내지 않는다", async () => {
    const mod = await loadBackground({ anonymousId: "a1" });
    global.fetch = respond(200);

    await mod.ensureParticipantSynced();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  // G1 — 이 작업의 본체. 참여자가 팝업을 한 번도 열지 않아도 다음 틱에 풀려야 한다.
  it("503으로 실패해도 retryable로 남기고, 다음 틱에 성공하면 실패 기록을 지운다", async () => {
    const mod = await loadBackground(BASE);

    global.fetch = respond(503, { success: false });
    await mod.ensureParticipantSynced();

    let all = await global.chrome.storage.local.get(null);
    expect(all.participantSynced).toBeFalsy();
    expect(all.participantSyncFailure).toMatchObject({
      kind: "retryable",
      httpStatus: 503,
      attempts: 1,
    });

    global.fetch = respond(200, {
      success: true,
      data: { participantToken: null },
    });
    await mod.ensureParticipantSynced();

    all = await global.chrome.storage.local.get(null);
    expect(all.participantSynced).toBe(true);
    expect(all.participantToken).toBeNull();
    expect(all.participantSyncFailure).toBeUndefined();
  });

  it("네트워크 오류·타임아웃도 retryable로 남기고 attempts를 누적한다", async () => {
    const mod = await loadBackground(BASE);
    global.fetch = vi.fn(async () => {
      throw new Error("offline");
    });

    await mod.ensureParticipantSynced();
    const first = (await global.chrome.storage.local.get(null))
      .participantSyncFailure;

    // 두 번째 실패의 lastFailedAt이 확실히 달라지도록 시계를 앞으로 돌린다
    vi.setSystemTime(new Date(Date.now() + 60000));
    await mod.ensureParticipantSynced();

    const all = await global.chrome.storage.local.get(null);
    expect(all.participantSyncFailure).toMatchObject({
      kind: "retryable",
      httpStatus: null,
      code: "network",
      attempts: 2,
    });
    // 첫 실패 시각은 그대로 유지되고 마지막 시각만 갱신돼야, 연구자가 참여자 PC에서
    // "이 상태가 얼마나 오래됐는지"를 두 값의 차이로 알 수 있다.
    expect(all.participantSyncFailure.firstFailedAt).toBe(first.firstFailedAt);
    expect(all.participantSyncFailure.lastFailedAt).not.toBe(
      first.lastFailedAt,
    );
  });

  // G2 — 400은 같은 요청을 다시 보내도 영원히 같은 답이 온다.
  it("400이면 permanent로 표시하고 다음 틱에는 요청을 보내지 않는다", async () => {
    const mod = await loadBackground(BASE);
    global.fetch = respond(400, {
      success: false,
      code: "INVALID_FIELD_VALUE",
    });

    await mod.ensureParticipantSynced();

    let all = await global.chrome.storage.local.get(null);
    expect(all.participantSyncFailure).toMatchObject({
      kind: "permanent",
      httpStatus: 400,
      code: "INVALID_FIELD_VALUE",
    });

    global.fetch = respond(400, {
      success: false,
      code: "INVALID_FIELD_VALUE",
    });
    await mod.ensureParticipantSynced();

    expect(global.fetch).not.toHaveBeenCalled();
    all = await global.chrome.storage.local.get(null);
    expect(all.participantSyncFailure.attempts).toBe(1);
  });

  it("SERVER_URL 미설정 환경에서는 실패를 기록하지 않는다", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => ({ SERVER_URL: "YOUR_SERVER_URL_HERE" }));
    try {
      global.chrome = createChromeMock();
      await global.chrome.storage.local.set(BASE);
      global.fetch = respond(200);
      const mod = await import("../background.js");

      await mod.ensureParticipantSynced();

      expect(global.fetch).not.toHaveBeenCalled();
      const all = await global.chrome.storage.local.get(null);
      expect(all.participantSyncFailure).toBeUndefined();
    } finally {
      // doUnmock을 쓰면 파일 상단 vi.mock("../config.js")까지 해제돼, 이후 모든 테스트가
      // 실제 config.js를 보게 된다. CI는 ensure-config.js가 복사한 placeholder를 쓰므로
      // sendToServer가 요청 없이 no_server_url로 끝나 여기서부터 전부 깨진다(로컬 config.js가
      // 우연히 목과 같은 값이면 안 드러난다 — 파일 상단 주석이 경고하는 바로 그 함정).
      // 해제하지 말고 원래 고정값으로 다시 덮어씌운다.
      vi.doMock("../config.js", () => ({
        SERVER_URL: "http://localhost:3000",
      }));
      vi.resetModules();
    }
  });

  // G4 — 게이트가 큐보다 먼저 끝나야 같은 틱에 밀린 데이터가 나간다.
  it("알람 한 틱에서 등록을 먼저 끝내고 그다음 큐를 보낸다", async () => {
    const order = [];
    global.chrome = createChromeMock();
    await global.chrome.storage.local.set({
      ...BASE,
      video__s1__e1: {
        videoId: "v1",
        watchedAt: "2026-01-10T11:00:00Z",
        eventId: "e1",
        sent: false,
      },
    });
    global.fetch = vi.fn(async (url, options = {}) => {
      order.push(`${options.method} ${new URL(String(url)).pathname}`);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: {} }),
      };
    });

    vi.resetModules();
    await import("../background.js");
    const onAlarm = global.chrome.alarms.onAlarm.addListener.mock.calls[0][0];
    onAlarm({ name: "SESSION_TIMEOUT_CHECK" });
    await vi.advanceTimersByTimeAsync(0);

    expect(order[0]).toBe("POST /api/participants");
    expect(order).toContain("POST /api/video-events");
  });
});

describe("토큰 거부 시 등록 무효화 — 큐가 403을 받으면 다음 틱에 재등록한다", () => {
  const BASE = {
    anonymousId: "a1",
    group: "EXP",
    participantCode: "QWE-AB23",
    installDate: ACTIVE_INSTALL_DATE,
    participantSynced: true,
    participantToken: "stale",
    video__s1__e1: {
      videoId: "v1",
      watchedAt: "2026-01-10T11:00:00Z",
      eventId: "e1",
      sent: false,
    },
  };

  async function loadBackground(storage = BASE) {
    global.chrome = createChromeMock();
    await global.chrome.storage.local.set(storage);
    vi.resetModules();
    return import("../background.js");
  }

  function respond(status, body) {
    return vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }));
  }

  // G3 — PARTICIPANT_TOKEN_SECRET을 연구 중간에 켜면 기존 참여자는 토큰이 null인 채
  // 모든 요청이 403이 된다. 이 경로가 없으면 재설치 말고는 복구 수단이 없다.
  it("403 INVALID_PARTICIPANT_TOKEN이면 participantSynced를 내린다", async () => {
    const mod = await loadBackground();
    global.fetch = respond(403, {
      success: false,
      code: "INVALID_PARTICIPANT_TOKEN",
    });

    await mod.retryUnsentVideoEvents();

    const all = await global.chrome.storage.local.get(null);
    expect(all.participantSynced).toBe(false);
    // 토큰은 지우지 않는다 — 재등록 성공 시 새 값으로 덮어쓴다
    expect(all.participantToken).toBe("stale");
    // 영상은 큐에 그대로 남아야 한다
    expect(all.video__s1__e1.sent).toBe(false);
  });

  it("무효화 다음 틱에 게이트가 재등록해 토큰을 갱신하고 큐가 풀린다", async () => {
    const mod = await loadBackground();
    global.fetch = respond(403, {
      success: false,
      code: "INVALID_PARTICIPANT_TOKEN",
    });
    await mod.retryUnsentVideoEvents();

    const paths = [];
    global.fetch = vi.fn(async (url, options = {}) => {
      paths.push(`${options.method} ${new URL(String(url)).pathname}`);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { participantToken: "fresh" },
        }),
      };
    });

    await mod.ensureParticipantSynced();
    await mod.retryUnsentVideoEvents();

    expect(paths).toEqual(["POST /api/participants", "POST /api/video-events"]);
    const all = await global.chrome.storage.local.get(null);
    expect(all.participantSynced).toBe(true);
    expect(all.participantToken).toBe("fresh");
    expect(all.video__s1__e1.sent).toBe(true);
  });

  it("404 참여자 미등록으로는 participantSynced를 내리지 않는다", async () => {
    const mod = await loadBackground();
    global.fetch = respond(404, { success: false, code: "NOT_FOUND" });

    await mod.retryUnsentVideoEvents();

    const all = await global.chrome.storage.local.get(null);
    // 404에 재등록을 붙이면 삭제 요청으로 지운 행이 되살아난다(PRIVACY.md 5절).
    expect(all.participantSynced).toBe(true);
  });

  it("code 없는 403(프록시 오류 등)으로는 내리지 않는다", async () => {
    const mod = await loadBackground();
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => {
        throw new Error("not json");
      },
    }));

    await mod.retryUnsentVideoEvents();

    const all = await global.chrome.storage.local.get(null);
    expect(all.participantSynced).toBe(true);
  });

  it("403이 연속돼도 무효화 로그는 상태가 바뀐 첫 틱에만 남긴다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mod = await loadBackground();
      global.fetch = respond(403, {
        success: false,
        code: "INVALID_PARTICIPANT_TOKEN",
      });

      await mod.retryUnsentVideoEvents();
      await mod.retryUnsentVideoEvents();

      const invalidated = warn.mock.calls
        .map(([line]) => line)
        .filter((line) =>
          String(line).includes("result=participant_invalidated"),
        );
      expect(invalidated).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("storage 실패 — 알람 콜백 밖으로 새어나가지 않는다", () => {
  const BASE = {
    anonymousId: "a1",
    group: "EXP",
    participantCode: "QWE-AB23",
    installDate: ACTIVE_INSTALL_DATE,
  };

  function okResponse() {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { participantToken: "t" } }),
    }));
  }

  // 모듈 최상단의 serverUrl 저장이 아니라 게이트 실행 중의 storage 실패를 보려는 것이므로,
  // import가 끝난 뒤에 set을 바꿔 끼운다(용량 초과도 실제로는 나중에 발생한다).
  async function loadThenBreakSet(message) {
    global.chrome = createChromeMock();
    await global.chrome.storage.local.set(BASE);
    global.fetch = okResponse();
    vi.resetModules();
    const mod = await import("../background.js");
    const realSet = global.chrome.storage.local.set;
    global.chrome.storage.local.set = () => Promise.reject(new Error(message));
    return { mod, realSet };
  }

  // sendToServer는 네트워크 오류를 결과 객체로 바꿔 주지만 chrome.storage 실패는 그 바깥이라
  // 그대로 튀어 오른다. 알람 콜백이 Promise를 받지 않으므로 흡수하지 않으면 unhandled
  // rejection이 되고, 어느 큐가 깨졌는지도 알 수 없다.
  it("등록 게이트의 storage 실패를 흡수하고 큐 이름과 함께 기록한다", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { mod } = await loadThenBreakSet("QUOTA_BYTES quota exceeded");

      // reject하지 않고 정상 종료해야 한다
      await expect(mod.ensureParticipantSynced()).resolves.toBeUndefined();

      expect(errorSpy.mock.calls.map(([line]) => line)).toContain(
        "[background] queue=participants result=crashed error=QUOTA_BYTES quota exceeded",
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("한 큐가 깨져도 락이 풀려 다음 틱이 정상 진입한다", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { mod, realSet } = await loadThenBreakSet("boom");

      await mod.ensureParticipantSynced();
      // 락이 풀리지 않았다면 여기서 reentry_blocked로 빠져 fetch가 늘지 않는다
      global.chrome.storage.local.set = realSet;
      await mod.ensureParticipantSynced();

      expect(global.fetch).toHaveBeenCalledTimes(2);
      const all = await global.chrome.storage.local.get(null);
      expect(all.participantSynced).toBe(true);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("영구 실패는 그 요청 내용에만 적용된다 — 재온보딩을 막지 않는다", () => {
  const BASE = {
    anonymousId: "a1",
    group: "EXP",
    participantCode: "QWE-BAD1",
    installDate: ACTIVE_INSTALL_DATE,
  };

  async function loadBackground(storage) {
    global.chrome = createChromeMock();
    await global.chrome.storage.local.set(storage);
    vi.resetModules();
    return import("../background.js");
  }

  function respond(status, body) {
    return vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }));
  }

  const BAD_CODE = { success: false, code: "INVALID_FIELD_VALUE" };

  it("잘못된 참여코드로 400을 받은 뒤 올바른 코드로 재온보딩하면 다시 시도한다", async () => {
    const mod = await loadBackground(BASE);
    global.fetch = respond(400, BAD_CODE);
    await mod.ensureParticipantSynced();

    // 같은 내용으로는 다시 보내지 않는다
    global.fetch = respond(400, BAD_CODE);
    await mod.ensureParticipantSynced();
    expect(global.fetch).not.toHaveBeenCalled();

    // 팝업 재온보딩 경로는 participantSynced만 되돌리고 participantSyncFailure는 남긴다
    // (viewlens-popup.js의 온보딩·연구자 리셋·재설치 복구 세 경로 모두 그렇다).
    await global.chrome.storage.local.set({
      participantCode: "QWE-GOOD",
      installDate: new Date(2025, 0, 2).toISOString(),
      participantSynced: false,
    });

    global.fetch = respond(200, {
      success: true,
      data: { participantToken: "tok" },
    });
    await mod.ensureParticipantSynced();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).participantCode).toBe(
      "QWE-GOOD",
    );
    const all = await global.chrome.storage.local.get(null);
    expect(all.participantSynced).toBe(true);
    expect(all.participantSyncFailure).toBeUndefined();
  });

  it("requestKey가 없는 옛 기록은 막지 않고 재시도하는 쪽으로 떨어진다", async () => {
    const mod = await loadBackground({
      ...BASE,
      // 이 필드 도입 전 버전이 남긴 기록
      participantSyncFailure: {
        kind: "permanent",
        httpStatus: 400,
        code: "INVALID_FIELD_VALUE",
        attempts: 1,
      },
    });
    global.fetch = respond(200, { success: true, data: {} });

    await mod.ensureParticipantSynced();

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("실패 기록에 requestKey를 남긴다", async () => {
    const mod = await loadBackground(BASE);
    global.fetch = respond(400, BAD_CODE);

    await mod.ensureParticipantSynced();

    const { participantSyncFailure } =
      await global.chrome.storage.local.get(null);
    expect(participantSyncFailure.requestKey).toBe(
      `a1|EXP|${BASE.installDate}|QWE-BAD1`,
    );
  });
});

describe("참여 기간 종료 — 전송 기간이 끝나면 서버 요청을 보내지 않는다", () => {
  const DAY = 86400000;
  // 수집 종료(설치+12일이 속한 KST 날짜의 00:00)로부터 FIXED_NOW까지 1~2일 → grace
  const GRACE_INSTALL_DATE = new Date(FIXED_NOW - 13 * DAY).toISOString();
  // 8~9일 → ended
  const ENDED_INSTALL_DATE = new Date(FIXED_NOW - 20 * DAY).toISOString();

  function backlog(installDate) {
    return {
      anonymousId: "a1",
      group: "EXP",
      installDate,
      participantCode: "QWE-1234",
      participantSynced: false,
      video__s1__e1: {
        videoId: "v1",
        watchedAt: "2026-01-01T11:00:00Z",
        eventId: "e1",
        sent: false,
      },
      video__s1__e2: {
        videoId: "v2",
        eventId: "e2",
        sent: true,
        watchedSeconds: 10,
        watchStatsSent: false,
      },
      sessions: [
        { sessionId: "s0", videos: [{ videoId: "v0" }], syncedToServer: false },
      ],
    };
  }

  async function loadBackground(storage) {
    global.chrome = createChromeMock();
    global.chrome.tabs = { create: vi.fn() };
    await global.chrome.storage.local.set(storage);
    vi.resetModules();
    return import("../background.js");
  }

  function okFetch() {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { participantToken: "t" } }),
    }));
  }

  it("ended면 등록·세션·영상·시청시간 요청을 하나도 보내지 않는다", async () => {
    const mod = await loadBackground(backlog(ENDED_INSTALL_DATE));
    global.fetch = okFetch();

    await mod.runServerTasks();

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("grace면 기존처럼 등록 게이트와 재시도 큐가 동작한다", async () => {
    const mod = await loadBackground(backlog(GRACE_INSTALL_DATE));
    global.fetch = okFetch();

    await mod.runServerTasks();

    const paths = global.fetch.mock.calls.map(
      ([url, options]) => `${options.method} ${new URL(url).pathname}`,
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "POST /api/participants",
        "POST /api/sessions",
        "POST /api/video-events",
        "PATCH /api/video-events/e2",
      ]),
    );
  });

  it("ended 안내 알림은 여러 틱과 서비스워커 재시작을 거쳐도 한 번만 뜬다", async () => {
    let mod = await loadBackground(backlog(ENDED_INSTALL_DATE));
    global.fetch = okFetch();
    await mod.runServerTasks();
    await mod.runServerTasks();

    // 같은 storage로 모듈만 다시 불러와 서비스워커 재시작을 흉내 낸다
    const chromeBeforeRestart = global.chrome;
    vi.resetModules();
    mod = await import("../background.js");
    await mod.runServerTasks();

    expect(chromeBeforeRestart.notifications.create).toHaveBeenCalledTimes(1);
    expect(chromeBeforeRestart.notifications.create).toHaveBeenCalledWith(
      "viewlens-participation-ended",
      expect.objectContaining({
        message: expect.stringContaining("확장 프로그램을 제거해 주세요"),
      }),
    );
  });

  it("종료 알림을 클릭하면 팝업만 열고 세션 열람 기록 요청은 보내지 않는다", async () => {
    const mod = await loadBackground(backlog(ENDED_INSTALL_DATE));
    global.fetch = okFetch();

    await mod.handleNotificationOpen("viewlens-participation-ended");

    expect(global.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("ended에 세션이 닫혀도 서버로 보내지 않고 로컬에 미전송으로 남긴다", async () => {
    const mod = await loadBackground(backlog(ENDED_INSTALL_DATE));
    global.fetch = okFetch();

    await mod.analyzeSession({ sessionId: "s0", videos: [{ videoId: "v0" }] });

    expect(global.fetch).not.toHaveBeenCalled();
    const { sessions } = await global.chrome.storage.local.get("sessions");
    expect(sessions[0].syncedToServer).toBe(false);
  });
});
