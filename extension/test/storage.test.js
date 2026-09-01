import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  endSession,
  getCurrentSession,
  getAllSessions,
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
        remove: (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete store[k];
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

// content.js는 이제 addVideo()를 거치지 않고 영상마다 독립된 storage 키
// (video__<sessionId>__<uuid>)에 직접 쓴다(연구 무결성 점검 항목 3 — 다중 탭 경합으로
// 영상 기록이 사라지던 문제의 후속 조치). endSession()은 그 키들을 모아 최종 세션으로
// 마감하는 쪽만 담당하므로, 테스트도 그 키를 직접 채워 넣어 검증한다.
// 실제 키는 uuid를 쓰지만, 테스트에서는 (sessionId, videoId)가 같아도 다른 시각에 여러 번
// 호출할 수 있어야 하므로(같은 영상을 한참 뒤에 다시 봄 등) 매 호출마다 고유한 접미사를 쓴다
// — videoId를 그대로 키에 쓰면 같은 영상을 두 번 기록할 때 앞의 것을 덮어써버린다.
let videoKeySeq = 0;
function setVideo(sessionId, videoId, watchedAt, title = `제목-${videoId}`) {
  videoKeySeq += 1;
  return global.chrome.storage.local.set({
    [`video__${sessionId}__${videoId}-${videoKeySeq}`]: {
      videoId,
      title,
      watchedAt,
    },
  });
}

describe("endSession — 세션 종료 큐 (P0 ⑦)", () => {
  it("currentSession이 없으면 아무것도 하지 않는다", async () => {
    await endSession();
    expect(await getAllSessions()).toEqual([]);
  });

  it("영상이 0개인 세션은 종료하지 않고 그대로 둔다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "t" },
    });
    await endSession();
    expect(await getCurrentSession()).not.toBeNull();
    expect(await getAllSessions()).toEqual([]);
  });

  it("영상이 있으면 sessions로 옮기고 currentSession·video 키·lastRecordedVideo를 비운다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
      lastRecordedVideo: { videoId: "v1", sessionId: "s1" },
    });
    await setVideo("s1", "v1", "2026-01-01T00:01:00Z");
    await endSession();

    expect(await getCurrentSession()).toBeNull();
    const sessions = await getAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].videos.map((v) => v.videoId)).toEqual(["v1"]);
    expect(sessions[0].endTime).toBeDefined();

    const { lastRecordedVideo, ...rest } =
      await global.chrome.storage.local.get(null);
    expect(lastRecordedVideo).toBeNull();
    expect(Object.keys(rest).some((k) => k.startsWith("video__"))).toBe(false);
  });

  it("영상 여러 개를 시청 순서(watchedAt)대로 정렬해 최종 videos 배열을 만든다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
    });
    // 저장 순서를 일부러 시청 순서와 다르게 넣어, endSession이 watchedAt으로
    // 다시 정렬하는지 확인한다.
    await setVideo("s1", "v3", "2026-01-01T00:03:00Z");
    await setVideo("s1", "v1", "2026-01-01T00:01:00Z");
    await setVideo("s1", "v2", "2026-01-01T00:02:00Z");
    await endSession();

    const sessions = await getAllSessions();
    expect(sessions[0].videos.map((v) => v.videoId)).toEqual([
      "v1",
      "v2",
      "v3",
    ]);
  });

  it("드물게 같은 videoId가 남아 있어도(경합으로 새로고침 중복 방지를 놓친 경우) 마지막으로 한 번 더 걸러낸다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
    });
    await setVideo("s1", "v1", "2026-01-01T00:01:00Z");
    // 키 이름만 다르고(uuid 대신 접미사) videoId·watchedAt이 사실상 같은 중복 기록
    await global.chrome.storage.local.set({
      video__s1__dup: {
        videoId: "v1",
        title: "제목-v1",
        watchedAt: "2026-01-01T00:01:01Z",
      },
    });
    await endSession();

    const sessions = await getAllSessions();
    expect(sessions[0].videos.map((v) => v.videoId)).toEqual(["v1"]);
  });

  it("같은 영상을 여러 탭에서 동시에 열어둬 사이에 다른 영상이 끼어들어도(정렬상 이웃이 아니어도) 중복을 잡아낸다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
    });
    // 탭 A가 v1을 기록 → 그 직후(1초 뒤) 다른 탭에서 v2를 기록 → 다시 1초 뒤 탭 B가
    // (A와 거의 동시에 v1을 열었던) v1을 기록. 정렬하면 v1·v2·v1 순서라 "바로 이웃"
    // 방식이면 두 v1이 서로 안 붙어 있어 중복 제거를 놓친다.
    await setVideo("s1", "v1", "2026-01-01T00:00:00.000Z");
    await setVideo("s1", "v2", "2026-01-01T00:00:01.000Z");
    await global.chrome.storage.local.set({
      video__s1__v1dup: {
        videoId: "v1",
        title: "제목-v1",
        watchedAt: "2026-01-01T00:00:02.000Z",
      },
    });
    await endSession();

    const sessions = await getAllSessions();
    expect(sessions[0].videos.map((v) => v.videoId)).toEqual(["v1", "v2"]);
  });

  it("같은 영상을 한참 뒤에(임계값 밖에서) 다시 보면 별도 시청으로 계속 집계한다(A→B→A, bug-01 명시 케이스)", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
    });
    await setVideo("s1", "v1", "2026-01-01T00:00:00Z");
    await setVideo("s1", "v2", "2026-01-01T00:00:10Z");
    await setVideo("s1", "v1", "2026-01-01T00:05:00Z"); // 5분 뒤 재시청 — 정당한 별도 시청
    await endSession();

    const sessions = await getAllSessions();
    expect(sessions[0].videos.map((v) => v.videoId)).toEqual([
      "v1",
      "v2",
      "v1",
    ]);
  });

  it("임계값 안에서 같은 영상이 연쇄로 여러 번 감지돼도(세 탭 등) 전부 하나로 합친다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
    });
    await setVideo("s1", "v1", "2026-01-01T00:00:00.000Z");
    await global.chrome.storage.local.set({
      video__s1__v1b: {
        videoId: "v1",
        title: "제목-v1",
        watchedAt: "2026-01-01T00:00:04.000Z", // 직전과 4초 차(임계값 10초 이내)
      },
      video__s1__v1c: {
        videoId: "v1",
        title: "제목-v1",
        watchedAt: "2026-01-01T00:00:08.000Z", // 직전(4초)과는 4초 차, 최초(0초)와는 8초 차
      },
    });
    await endSession();

    // 각 인접 간격은 임계값 이내라 전부 한 시청으로 묶인다(최초 기준 누적 8초가
    // 넘더라도, 매번 "직전 유지 항목"과 비교하는 슬라이딩 방식이라 계속 이어진다).
    const sessions = await getAllSessions();
    expect(sessions[0].videos.map((v) => v.videoId)).toEqual(["v1"]);
  });

  it("아주 드물게 두 탭이 동시에 다른 세션을 시작해도(세션 식별 경합) 두 세션 모두 데이터를 잃지 않고 각각 마감된다", async () => {
    // currentSession은 둘 중 나중에 쓴 쪽(s2)만 남아있는 상황을 재현 — 그래도
    // video__ 키는 s1 것도 s2 것도 그대로 남아 있다(영상마다 독립 키라 서로 안 지움).
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s2", startTime: "2026-01-01T00:05:00Z" },
    });
    await setVideo("s1", "vA", "2026-01-01T00:00:00Z");
    await setVideo("s2", "vB", "2026-01-01T00:05:30Z");
    await endSession();

    const sessions = await getAllSessions();
    expect(sessions).toHaveLength(2);
    const ids = sessions.flatMap((s) => s.videos.map((v) => v.videoId)).sort();
    expect(ids).toEqual(["vA", "vB"]); // 둘 다 유실 없이 남는다
  });

  it("get(null) 스냅샷 이후 remove() 이전에 같은 세션으로 새 영상이 도착해도 유실 없이 즉시 병합한다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
    });
    await setVideo("s1", "v1", "2026-01-01T00:00:00Z");

    // content.js(별개 실행 컨텍스트)가 endSession의 get(null) 스냅샷 이후,
    // remove() 직전에 같은 세션(s1)으로 새 영상을 기록하는 상황을 재현한다.
    const originalRemove = global.chrome.storage.local.remove;
    global.chrome.storage.local.remove = vi.fn((keys) => {
      global.chrome.storage.local.set({
        video__s1__late: {
          videoId: "v2",
          title: "제목-v2",
          watchedAt: "2026-01-01T00:00:05Z",
        },
      });
      return originalRemove(keys);
    });

    await endSession();

    const sessions = await getAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].videos.map((v) => v.videoId)).toEqual(["v1", "v2"]);

    const all = await global.chrome.storage.local.get(null);
    expect(Object.keys(all).some((k) => k.startsWith("video__"))).toBe(false);
  });

  it("종료 중 새로 시작된 다른 세션의 영상은 건드리지 않는다(아직 진행 중이라 조기 종료하면 안 됨)", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
    });
    await setVideo("s1", "v1", "2026-01-01T00:00:00Z");

    const originalRemove = global.chrome.storage.local.remove;
    global.chrome.storage.local.remove = vi.fn((keys) => {
      // s1 종료 처리 중, 이미 새로 시작된 s2(다음 세션)의 영상이 끼어든 상황
      global.chrome.storage.local.set({
        video__s2__early: {
          videoId: "v9",
          title: "제목-v9",
          watchedAt: "2026-01-01T00:10:00Z",
        },
      });
      return originalRemove(keys);
    });

    await endSession();

    const sessions = await getAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("s1");
    expect(sessions[0].videos.map((v) => v.videoId)).toEqual(["v1"]);

    // s2의 영상 키는 지워지지 않고 그대로 남아, s2가 실제로 끝날 때 처리된다
    const all = await global.chrome.storage.local.get(null);
    expect(Object.keys(all).some((k) => k.startsWith("video__s2__"))).toBe(
      true,
    );
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
