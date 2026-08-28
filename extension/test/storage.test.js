import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  addVideo,
  endSession,
  getCurrentSession,
  getAllSessions,
  getRecentSessions,
  getLastWatchedAt,
  getOnboarding,
  saveAnalysis,
} from "../storage.js";

// 프로젝트에 chrome.storage.local 목이 없어 이번에 처음 만든다.
// 실제 chrome API처럼 get(string|string[]|null)을 지원하는 최소한의 인메모리 구현
function createChromeStorageMock() {
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
  };
}

beforeEach(() => {
  global.chrome = createChromeStorageMock();
});

afterEach(() => {
  delete global.chrome;
  vi.useRealTimers();
});

describe("addVideo — 세션 큐 직렬화 (P0 ⑦)", () => {
  it("세션이 없으면 새 세션을 만들고 첫 영상을 기록한다", async () => {
    await addVideo("v1", "제목1");
    const session = await getCurrentSession();
    expect(session.videos).toEqual([
      expect.objectContaining({ videoId: "v1", title: "제목1" }),
    ]);
  });

  it("await 없이 연달아 호출해도 큐가 직렬화해 모든 영상이 순서대로 쌓인다", async () => {
    // 큐 직렬화가 없으면 세 호출이 같은 시점의 stale currentSession을 읽어
    // 마지막 쓰기만 반영되는 레이스(가장 마지막 영상만 남는 손실)가 발생한다.
    const p1 = addVideo("v1", "제목1");
    const p2 = addVideo("v2", "제목2");
    const p3 = addVideo("v3", "제목3");
    await Promise.all([p1, p2, p3]);

    const session = await getCurrentSession();
    expect(session.videos.map((v) => v.videoId)).toEqual(["v1", "v2", "v3"]);
  });

  it("바로 직전 영상과 videoId가 같으면 중복 기록하지 않는다", async () => {
    await addVideo("v1", "제목1");
    await addVideo("v1", "제목1");
    const session = await getCurrentSession();
    expect(session.videos).toHaveLength(1);
  });

  it("직전이 아니라 더 이전에 봤던 영상으로 되돌아가면 다시 기록한다(알려진 동작, 08-테스트전략.md 엣지케이스)", async () => {
    await addVideo("v1", "제목1");
    await addVideo("v2", "제목2");
    await addVideo("v1", "제목1"); // v1으로 복귀 — 직전(v2)과만 비교하므로 다시 기록됨
    const session = await getCurrentSession();
    expect(session.videos.map((v) => v.videoId)).toEqual(["v1", "v2", "v1"]);
  });

  it("중복이라 videos에는 안 쌓여도 lastWatchedAt은 갱신한다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await addVideo("v1", "제목1");

    vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));
    await addVideo("v1", "제목1");

    expect(await getLastWatchedAt()).toBe("2026-01-01T00:05:00.000Z");
  });
});

describe("endSession — 세션 종료 큐 (P0 ⑦)", () => {
  it("currentSession이 없으면 아무것도 하지 않는다", async () => {
    await endSession();
    expect(await getAllSessions()).toEqual([]);
  });

  it("영상이 0개인 세션은 종료하지 않고 그대로 둔다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "t", videos: [] },
    });
    await endSession();
    expect(await getCurrentSession()).not.toBeNull();
    expect(await getAllSessions()).toEqual([]);
  });

  it("영상이 있으면 sessions로 옮기고 currentSession을 비운다", async () => {
    await addVideo("v1", "제목1");
    await endSession();

    expect(await getCurrentSession()).toBeNull();
    const sessions = await getAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].videos.map((v) => v.videoId)).toEqual(["v1"]);
    expect(sessions[0].endTime).toBeDefined();
  });

  it("addVideo와 endSession이 뒤섞여 호출돼도 같은 큐를 공유해 순서가 보장된다", async () => {
    const p1 = addVideo("v1", "제목1");
    const p2 = endSession();
    await Promise.all([p1, p2]);

    expect(await getCurrentSession()).toBeNull();
    const sessions = await getAllSessions();
    expect(sessions[0]?.videos.map((v) => v.videoId)).toEqual(["v1"]);
  });
});

describe("getRecentSessions", () => {
  it("endTime이 없는(진행 중) 세션은 제외한다", async () => {
    await global.chrome.storage.local.set({
      sessions: [{ sessionId: "s1", videos: [] }],
    });
    expect(await getRecentSessions(7)).toEqual([]);
  });

  it("cutoff보다 오래된 세션은 제외하고, 정확히 경계인 세션은 포함한다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 10, 12, 0, 0));

    // days=7 → cutoff는 오늘(1/10) 포함 7일 전 자정 = 1/4 00:00
    await global.chrome.storage.local.set({
      sessions: [
        {
          sessionId: "old",
          endTime: new Date(2026, 0, 3, 23, 59).toISOString(),
        },
        {
          sessionId: "boundary",
          endTime: new Date(2026, 0, 4, 0, 0).toISOString(),
        },
      ],
    });

    const result = await getRecentSessions(7);
    expect(result.map((s) => s.sessionId)).toEqual(["boundary"]);
  });
});

describe("saveAnalysis", () => {
  it("sessions 자체가 없으면 아무것도 하지 않는다", async () => {
    await saveAnalysis("s1", { entropy: 1 });
    expect(await getAllSessions()).toEqual([]);
  });

  it("일치하는 sessionId에만 분석 결과를 병합한다", async () => {
    await global.chrome.storage.local.set({
      sessions: [
        { sessionId: "s1", videos: [] },
        { sessionId: "s2", videos: [] },
      ],
    });
    await saveAnalysis("s1", { entropy: 0.5 });

    const sessions = await getAllSessions();
    expect(sessions.find((s) => s.sessionId === "s1").entropy).toBe(0.5);
    expect(sessions.find((s) => s.sessionId === "s2").entropy).toBeUndefined();
  });
});

describe("getOnboarding", () => {
  it("group이 없으면 null을 반환한다", async () => {
    expect(await getOnboarding()).toBeNull();
  });

  it("group이 있으면 onboarding 정보를 반환한다", async () => {
    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "EXP",
      installDate: "2026-01-01T00:00:00Z",
    });
    expect(await getOnboarding()).toEqual({
      anonymousId: "a1",
      group: "EXP",
      installDate: "2026-01-01T00:00:00Z",
    });
  });
});
