import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  endSession,
  hasOpenVideoRecords,
  getCurrentSession,
  getAllSessions,
  getOnboarding,
  saveAnalysis,
  getUnsentVideoEvents,
  markVideoEventSent,
  getUnsentWatchStats,
  getSessionCheckpointStats,
  markWatchStatsSent,
  patchVideoRecord,
  pruneWatchCheckpoints,
  pruneTabWatches,
  WATCH_CHECKPOINT_STALE_MS,
  getParticipantSyncState,
  markParticipantSynced,
  invalidateParticipantSync,
  SESSION_TIMEOUT_MS,
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
  it("currentSession도 남은 영상 기록도 없으면 아무것도 하지 않는다", async () => {
    await endSession();
    expect(await getAllSessions()).toEqual([]);
  });

  it("currentSession이 지워졌어도 남은 영상 기록은 세션으로 닫고, 시작 시각은 첫 기록 시각으로 둔다", async () => {
    await setVideo("s1", "v1", "2026-01-01T00:00:00.000Z");
    await setVideo("s1", "v2", "2026-01-01T00:03:00.000Z");
    expect(await hasOpenVideoRecords()).toBe(true);

    const closed = await endSession();

    expect(closed.map((s) => s.sessionId)).toEqual(["s1"]);
    const [session] = await getAllSessions();
    expect(session.startTime).toBe("2026-01-01T00:00:00.000Z");
    expect(session.videos.map((v) => v.videoId)).toEqual(["v1", "v2"]);
    expect(await hasOpenVideoRecords()).toBe(false);
  });

  describe("minIdleMs — 저장 큐 안에서 읽은 마지막 시청 시각으로 다시 판정한다", () => {
    const NOW = new Date("2026-01-01T01:00:00.000Z");
    const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });

    it("마지막 시청이 기준보다 최근이면 닫지 않고 현재 세션과 기록을 그대로 둔다", async () => {
      await global.chrome.storage.local.set({
        currentSession: { sessionId: "s1", startTime: minutesAgo(3) },
        lastWatchedAt: minutesAgo(3),
      });
      await setVideo("s1", "v1", minutesAgo(3));

      const closed = await endSession({ minIdleMs: SESSION_TIMEOUT_MS });

      expect(closed).toEqual([]);
      expect(await getAllSessions()).toEqual([]);
      expect(await getCurrentSession()).toMatchObject({ sessionId: "s1" });
      expect(await hasOpenVideoRecords()).toBe(true);
    });

    it("마지막 시청이 기준보다 오래됐으면 닫는다", async () => {
      await global.chrome.storage.local.set({
        currentSession: { sessionId: "s1", startTime: minutesAgo(11) },
        lastWatchedAt: minutesAgo(11),
      });
      await setVideo("s1", "v1", minutesAgo(11));

      const closed = await endSession({ minIdleMs: SESSION_TIMEOUT_MS });

      expect(closed.map((s) => s.sessionId)).toEqual(["s1"]);
    });

    it("옵션이 없으면 마지막 시청이 최근이어도 지금처럼 닫는다", async () => {
      await global.chrome.storage.local.set({
        currentSession: { sessionId: "s1", startTime: minutesAgo(3) },
        lastWatchedAt: minutesAgo(3),
      });
      await setVideo("s1", "v1", minutesAgo(3));

      const closed = await endSession();

      expect(closed.map((s) => s.sessionId)).toEqual(["s1"]);
    });
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

  // 같은 탭의 새 기록은 실제 이동이라 10초 안이어도 남기고, 다른 탭의 동시 기록만 합친다
  const tabVideo = (eventId, videoId, second, tabId, extra = {}) => ({
    [`video__s1__${eventId}`]: {
      videoId,
      title: `제목-${videoId}`,
      watchedAt: `2026-01-01T00:00:0${second}.000Z`,
      eventId,
      sent: true,
      ...(tabId !== undefined && { tabId }),
      ...extra,
    },
  });

  it("같은 탭에서 10초 안에 A → B → 뒤로 가기 A를 하면 세 기록이 모두 남는다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
      ...tabVideo("a1", "A", 0, 7),
      ...tabVideo("b", "B", 3, 7),
      ...tabVideo("a2", "A", 6, 7),
    });
    await endSession();

    const [session] = await getAllSessions();
    expect(session.videos.map((v) => v.eventId)).toEqual(["a1", "b", "a2"]);
  });

  it("다른 탭에서 10초 안에 같은 영상이 기록되면 사이에 다른 영상이 있어도 하나로 합친다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
      ...tabVideo("a1", "A", 0, 7),
      ...tabVideo("b", "B", 1, 8),
      ...tabVideo("a2", "A", 2, 8),
    });
    await endSession();

    const [session] = await getAllSessions();
    expect(session.videos.map((v) => v.eventId)).toEqual(["a1", "b"]);
  });

  it("탭 번호가 없는 기록은 같은 탭인지 알 수 없어 예전처럼 합친다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
      ...tabVideo("a1", "A", 0, 7),
      ...tabVideo("b", "B", 3, 7),
      ...tabVideo("a2", "A", 6),
    });
    await endSession();

    const [session] = await getAllSessions();
    expect(session.videos.map((v) => v.eventId)).toEqual(["a1", "b"]);
  });

  it("같은 탭에서 다시 본 A의 시청 시간은 세션이 닫힌 뒤에도 재시도 대상에 남는다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
      ...tabVideo("a1", "A", 0, 7),
      ...tabVideo("b", "B", 3, 7),
      ...tabVideo("a2", "A", 6, 7, {
        watchedSeconds: 600,
        watchStatsSent: false,
      }),
    });
    await endSession();

    const stats = await getUnsentWatchStats();
    expect(stats).toEqual([
      expect.objectContaining({
        location: "session",
        eventId: "a2",
        watchedSeconds: 600,
      }),
    ]);
  });

  it("탭 번호가 있는 두 탭이 10초 안에 같은 영상을 기록하면 두 기록이 모두 남는다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
      ...tabVideo("a1", "A", 0, 7),
      ...tabVideo("a2", "A", 2, 8),
    });
    await endSession();

    const [session] = await getAllSessions();
    expect(session.videos.map((v) => v.eventId)).toEqual(["a1", "a2"]);
  });

  it("세션이 닫힌 뒤 두 번째 탭이 남긴 시청 시간도 기록을 찾아 재시도 대상에 남는다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
      ...tabVideo("a1", "A", 0, 7),
      ...tabVideo("a2", "A", 2, 8),
    });
    await endSession();

    // 세션은 기록 10분 뒤 닫혀, 긴 영상을 보던 두 번째 탭은 닫힌 뒤에 최종값을 남긴다
    const applied = await patchVideoRecord(
      { sessionId: "s1", eventId: "a2" },
      { watchedSeconds: 900, watchStatsSent: false, watchStatsSource: "final" },
    );

    expect(applied).toBe(true);
    expect(await getUnsentWatchStats()).toEqual([
      expect.objectContaining({
        location: "session",
        eventId: "a2",
        watchedSeconds: 900,
      }),
    ]);
  });

  it("늦게 온 기록을 합쳐 세션을 다시 정리해도 같은 탭에서 다시 본 A는 남는다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
      ...tabVideo("a1", "A", 0, 7),
      ...tabVideo("b", "B", 3, 7),
      ...tabVideo("a2", "A", 6, 7),
    });
    await endSession();

    // 닫힌 세션으로 늦게 온 기록이 있어, 다음 종료 때 닫힌 목록과 합쳐 중복 제거를 다시 한다
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s2", startTime: "2026-01-01T01:00:00Z" },
      ...tabVideo("late", "C", 9, 7),
      video__s2__x: {
        videoId: "X",
        watchedAt: "2026-01-01T01:00:00.000Z",
        eventId: "x",
        sent: true,
      },
    });
    await endSession();

    const sessions = await getAllSessions();
    expect(sessions[0].videos.map((v) => v.eventId)).toEqual([
      "a1",
      "b",
      "a2",
      "late",
    ]);
  });

  it("다른 탭 기록이 사이에 끼어도 같은 탭에서 10초 안에 다시 본 영상은 남긴다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
      ...tabVideo("a0", "A", 0, 7),
      ...tabVideo("b1", "B", 1, 8),
      ...tabVideo("a2", "A", 2, 8),
      ...tabVideo("b3", "B", 3, 7),
      ...tabVideo("a6", "A", 6, 7),
    });
    await endSession();

    // 탭8의 A·탭7의 B는 다른 탭에 같은 영상이 열린 중복이라 합친다
    const [session] = await getAllSessions();
    expect(session.videos.map((v) => v.eventId)).toEqual(["a0", "b1", "a6"]);
  });

  it("다른 탭이 같은 영상을 기록한 뒤 같은 탭에서 A → B → 뒤로 가기 A를 해도 두 번째 A는 남긴다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
      ...tabVideo("a0", "A", 0, 1),
      ...tabVideo("a1", "A", 1, 2),
      ...tabVideo("b3", "B", 3, 1),
      ...tabVideo("a6", "A", 6, 1),
    });
    await endSession();

    const [session] = await getAllSessions();
    expect(session.videos.map((v) => v.eventId)).toEqual(["a0", "b3", "a6"]);
  });

  it("같은 탭의 같은 영상 기록이 10초보다 오래됐으면 다른 탭 중복은 지금처럼 합친다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
      video__s1__old: {
        videoId: "A",
        watchedAt: "2026-01-01T00:00:00.000Z",
        eventId: "old",
        sent: true,
        tabId: 8,
      },
      video__s1__other: {
        videoId: "A",
        watchedAt: "2026-01-01T00:05:00.000Z",
        eventId: "other",
        sent: true,
        tabId: 7,
      },
      video__s1__again: {
        videoId: "A",
        watchedAt: "2026-01-01T00:05:01.000Z",
        eventId: "again",
        sent: true,
        tabId: 8,
      },
    });
    await endSession();

    const [session] = await getAllSessions();
    expect(session.videos.map((v) => v.eventId)).toEqual(["old", "other"]);
  });

  // 닫힌 세션에 늦은 기록을 합칠 때 이미 저장된 기록은 다시 판정하지 않는다
  const closeThenMergeLate = async (initial, late) => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
      ...initial,
    });
    await endSession();
    const afterFirst = (await getAllSessions())[0].videos.map((v) => v.eventId);
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s2", startTime: "2026-01-01T01:00:00Z" },
      ...late,
      video__s2__x: {
        videoId: "X",
        watchedAt: "2026-01-01T01:00:00.000Z",
        eventId: "x",
        sent: true,
      },
    });
    await endSession();
    const afterMerge = (await getAllSessions())[0].videos.map((v) => v.eventId);
    return { afterFirst, afterMerge };
  };

  it("다른 탭 중복이 지워진 뒤 같은 탭에서 다시 본 기록은 늦은 기록을 합쳐도 남는다", async () => {
    const { afterFirst, afterMerge } = await closeThenMergeLate(
      {
        ...tabVideo("a0", "A", 0, 7),
        ...tabVideo("b1", "B", 1, 8),
        ...tabVideo("a2", "A", 2, 8),
        ...tabVideo("b3", "B", 3, 8),
        ...tabVideo("a6", "A", 6, 8),
      },
      tabVideo("late", "C", 9, 8),
    );

    expect(afterFirst).toEqual(["a0", "b1", "b3", "a6"]);
    expect(afterMerge).toEqual(["a0", "b1", "b3", "a6", "late"]);
  });

  it("늦게 온 기록이 저장된 기록과 다른 탭 중복이면 합친다", async () => {
    const { afterMerge } = await closeThenMergeLate(
      { ...tabVideo("a0", "A", 0, 7), ...tabVideo("b1", "B", 1, 7) },
      tabVideo("late", "A", 2, 8),
    );

    expect(afterMerge).toEqual(["a0", "b1"]);
  });

  it("닫는 중 영상 키 삭제가 끊겨 같은 기록이 다시 들어와도 처음 닫은 결과와 같다", async () => {
    const records = {
      ...tabVideo("a0", "A", 0, 7),
      ...tabVideo("b1", "B", 1, 8),
      ...tabVideo("a2", "A", 2, 8),
      ...tabVideo("b3", "B", 3, 8),
      ...tabVideo("a6", "A", 6, 8),
    };
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
      ...records,
    });
    const { remove } = global.chrome.storage.local;
    global.chrome.storage.local.remove = async () => {
      global.chrome.storage.local.remove = remove;
      throw new Error("QUOTA_BYTES quota exceeded");
    };
    await expect(endSession()).rejects.toThrow("QUOTA_BYTES");

    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s2", startTime: "2026-01-01T01:00:00Z" },
    });
    await endSession();

    const [session] = await getAllSessions();
    expect(session.videos.map((v) => v.eventId)).toEqual([
      "a0",
      "b1",
      "b3",
      "a6",
    ]);
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

describe("endSession — 기록한 참여자", () => {
  it("세션을 닫아도 세션과 영상 기록에 기록한 참여자가 남는다", async () => {
    await global.chrome.storage.local.set({
      currentSession: {
        sessionId: "s1",
        startTime: "2026-01-01T00:00:00.000Z",
        anonymousId: "a1",
      },
      video__s1__e1: {
        videoId: "v1",
        watchedAt: "2026-01-01T00:00:00.000Z",
        eventId: "e1",
        sent: false,
        anonymousId: "a1",
      },
    });

    await endSession();

    const [session] = await getAllSessions();
    expect(session.anonymousId).toBe("a1");
    expect(session.videos[0].anonymousId).toBe("a1");
  });
});

// 세션은 1분 주기 알람이 닫는데, 브라우저가 꺼져 있으면 알람이 늦게 돈다. 종료 시각은 닫은 순간이 아니라
// 그 세션의 마지막 영상 기록 + SESSION_TIMEOUT_MS여야 한다.
describe("endSession — 세션 종료 시각", () => {
  const at = (iso) => new Date(iso).toISOString();
  const now = (iso) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
  };
  const start = (sessionId, startTime) =>
    global.chrome.storage.local.set({
      currentSession: { sessionId, startTime },
    });

  it("10분 기준은 10분이다", () => {
    expect(SESSION_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  it("브라우저를 닫았다가 이틀 뒤 닫혀도 종료 시각은 마지막 영상 + 10분이다", async () => {
    await start("s1", "2026-10-23T13:50:49Z");
    await setVideo("s1", "v1", "2026-10-23T13:50:49Z");
    await setVideo("s1", "v2", "2026-10-23T13:55:00Z");
    now("2026-10-25T10:56:34Z");

    await endSession();

    expect((await getAllSessions())[0].endTime).toBe(
      at("2026-10-23T14:05:00Z"),
    );
  });

  it("알람이 제때 돌아 11분 뒤 닫혀도 종료 시각은 마지막 영상 + 10분이다", async () => {
    await start("s1", "2026-01-01T00:00:00Z");
    await setVideo("s1", "v1", "2026-01-01T00:00:00Z");
    now("2026-01-01T00:11:00Z");

    await endSession();

    expect((await getAllSessions())[0].endTime).toBe(
      at("2026-01-01T00:10:00Z"),
    );
  });

  it("10분이 지나기 전에 닫히면 지금을 넘지 않는다", async () => {
    await start("s1", "2026-01-01T00:00:00Z");
    await setVideo("s1", "v1", "2026-01-01T00:00:00Z");
    now("2026-01-01T00:03:00Z");

    await endSession();

    expect((await getAllSessions())[0].endTime).toBe(
      at("2026-01-01T00:03:00Z"),
    );
  });

  it("시작 시각보다 이르지 않다", async () => {
    await start("s1", "2026-01-01T01:00:00Z");
    await setVideo("s1", "v1", "2026-01-01T00:00:00Z");
    now("2026-01-02T00:00:00Z");

    await endSession();

    expect((await getAllSessions())[0].endTime).toBe(
      at("2026-01-01T01:00:00Z"),
    );
  });

  it("한 번에 여러 세션을 닫으면 각 세션이 자기 영상 기준으로 종료 시각을 갖고, 닫은 세션을 모두 돌려준다", async () => {
    await start("new", "2026-10-25T10:56:00Z");
    await setVideo("old", "v1", "2026-10-23T13:55:00Z");
    await setVideo("new", "v2", "2026-10-25T10:56:00Z");
    now("2026-10-25T11:07:00Z");

    const closed = await endSession();

    const endOf = (id) => closed.find((s) => s.sessionId === id).endTime;
    expect(closed).toHaveLength(2);
    expect(endOf("old")).toBe(at("2026-10-23T14:05:00Z"));
    expect(endOf("new")).toBe(at("2026-10-25T11:06:00Z"));
    expect(await getAllSessions()).toEqual(closed);
  });

  it("닫을 세션이 없으면 빈 배열을 돌려준다", async () => {
    expect(await endSession()).toEqual([]);
    await start("s1", "2026-01-01T00:00:00Z");
    expect(await endSession()).toEqual([]);
  });

  it("종료 중 늦게 도착한 같은 세션 영상이 있으면 그 영상까지 포함해 종료 시각을 다시 정한다", async () => {
    await start("s1", "2026-01-01T00:00:00Z");
    await setVideo("s1", "v1", "2026-01-01T00:00:00Z");
    now("2026-01-01T00:20:00Z");
    const originalRemove = global.chrome.storage.local.remove;
    global.chrome.storage.local.remove = vi.fn((keys) => {
      global.chrome.storage.local.set({
        video__s1__late: {
          videoId: "v2",
          title: "제목-v2",
          watchedAt: "2026-01-01T00:05:00Z",
        },
      });
      return originalRemove(keys);
    });

    const closed = await endSession();

    expect(closed[0].videos.map((v) => v.videoId)).toEqual(["v1", "v2"]);
    expect(closed[0].endTime).toBe(at("2026-01-01T00:15:00Z"));
    expect((await getAllSessions())[0].endTime).toBe(
      at("2026-01-01T00:15:00Z"),
    );
  });
});

// 저장 작업은 한 줄로 실행된다. 한 번의 실패로 줄 전체가 막히면 서비스워커가 다시 뜰 때까지 세션 종료·분석 저장이 모두 실패한다
describe("저장 큐 — 한 작업이 실패해도 다음 작업은 실행된다", () => {
  // 다음 한 번의 쓰기만 실패시킨다
  function failNextSet() {
    const { set } = global.chrome.storage.local;
    global.chrome.storage.local.set = () => {
      global.chrome.storage.local.set = set;
      return Promise.reject(new Error("QUOTA_BYTES quota exceeded"));
    };
  }

  it("실패한 저장은 부른 쪽에 실패를 돌려주고, 다음 저장은 그대로 반영한다", async () => {
    await global.chrome.storage.local.set({
      sessions: [{ sessionId: "s1", videos: [] }],
    });

    failNextSet();
    await expect(saveAnalysis("s1", { videoCount: 1 })).rejects.toThrow(
      "QUOTA_BYTES",
    );
    await saveAnalysis("s1", { videoCount: 2 });

    const [session] = await getAllSessions();
    expect(session.videoCount).toBe(2);
  });

  it("전송 표시 저장이 실패해도 다음 세션 종료는 세션을 닫아 돌려준다", async () => {
    await global.chrome.storage.local.set({
      sessions: [{ sessionId: "old", videos: [{ eventId: "e0", sent: true }] }],
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
    });
    await setVideo("s1", "v1", "2026-01-01T00:00:00Z");

    failNextSet();
    await expect(
      markWatchStatsSent({
        location: "session",
        sessionId: "old",
        eventId: "e0",
        watchedSeconds: 30,
        playbackRate: 1,
        wasBackgrounded: 0,
        at: 1,
        source: "checkpoint",
      }),
    ).rejects.toThrow("QUOTA_BYTES");
    const closed = await endSession();

    expect(closed.map((session) => session.sessionId)).toEqual(["s1"]);
    expect(await getCurrentSession()).toBeNull();
  });
});

// 세션 종료는 저장과 삭제를 한 번에 할 수 없어 중간에 끊길 수 있다. 다시 닫으면 같은 결과가 돼야 한다
describe("endSession — 중간에 끊겨도 다시 닫으면 같은 세션으로 합친다", () => {
  const T1 = "2026-01-01T10:00:00.000Z";
  const T2 = "2026-01-01T12:00:00.000Z";
  const video = (eventId, watchedAt, extra = {}) => ({
    videoId: `v-${eventId}`,
    watchedAt,
    eventId,
    sent: true,
    ...extra,
  });

  // 다음 한 번의 set/remove만 실패시킨다
  function failNext(method) {
    const original = global.chrome.storage.local[method];
    global.chrome.storage.local[method] = async () => {
      global.chrome.storage.local[method] = original;
      throw new Error("QUOTA_BYTES quota exceeded");
    };
  }

  async function startNextSession() {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s2", startTime: T2 },
      video__s2__e2: video("e2", T2),
    });
  }

  const videoKeys = async () =>
    Object.keys(await global.chrome.storage.local.get(null)).filter((k) =>
      k.startsWith("video__"),
    );

  it("영상 키 삭제가 끊겨도 세션은 전송 대기로 남고, 다음 종료 때 중복 없이 하나로 정리된다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: T1 },
      video__s1__e1: video("e1", T1),
    });
    failNext("remove");
    await expect(endSession()).rejects.toThrow("QUOTA_BYTES");

    expect(await getAllSessions()).toEqual([
      expect.objectContaining({ sessionId: "s1", syncedToServer: false }),
    ]);

    await startNextSession();
    const closed = await endSession();

    const sessions = await getAllSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
    expect(sessions[0].videos.map((v) => v.eventId)).toEqual(["e1"]);
    expect(closed.map((s) => s.sessionId).sort()).toEqual(["s1", "s2"]);
    expect(await videoKeys()).toEqual([]);
  });

  it("늦게 온 영상을 합치는 저장이 끊겨도, 다음 종료 때 그 영상이 기존 세션에 합쳐진다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: T1 },
      video__s1__e1: video("e1", T1),
    });
    // 첫 삭제 직후 content.js가 닫힌 세션으로 영상을 쓰고, 그 영상을 합치는 저장이 실패한다
    const { remove } = global.chrome.storage.local;
    global.chrome.storage.local.remove = async (keys) => {
      global.chrome.storage.local.remove = remove;
      await remove(keys);
      await global.chrome.storage.local.set({
        video__s1__late: video("late", "2026-01-01T10:05:00.000Z"),
      });
      failNext("set");
    };
    await expect(endSession()).rejects.toThrow("QUOTA_BYTES");
    expect((await getAllSessions())[0].videos.map((v) => v.eventId)).toEqual([
      "e1",
    ]);

    await startNextSession();
    await endSession();

    const sessions = await getAllSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
    expect(sessions[0].videos.map((v) => v.eventId)).toEqual(["e1", "late"]);
    expect(sessions[0].syncedToServer).toBe(false);
  });

  it("이미 보낸 세션이 다시 살아나 영상이 생기면 기존 세션에 합치고, 전송 완료와 리뷰를 유지하며 다시 돌려주지 않는다", async () => {
    await global.chrome.storage.local.set({
      sessions: [
        {
          sessionId: "s1",
          startTime: T1,
          endTime: "2026-01-01T10:10:00.000Z",
          videos: [video("e1", T1)],
          syncedToServer: true,
          review: "오늘 리뷰",
        },
      ],
      currentSession: { sessionId: "s1", startTime: T1 },
      video__s1__e2: video("e2", "2026-01-01T10:09:00.000Z"),
    });

    const closed = await endSession();

    expect(closed).toEqual([]);
    const sessions = await getAllSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      syncedToServer: true,
      review: "오늘 리뷰",
      startTime: T1,
    });
    expect(sessions[0].videos.map((v) => v.eventId)).toEqual(["e1", "e2"]);
  });

  it("같은 영상이 양쪽에 있으면 남아 있던 영상 키의 값을 쓴다", async () => {
    await global.chrome.storage.local.set({
      sessions: [{ sessionId: "s1", startTime: T1, videos: [video("e1", T1)] }],
      currentSession: { sessionId: "s1", startTime: T1 },
      video__s1__e1: video("e1", T1, {
        watchedSeconds: 300,
        watchStatsSent: false,
        watchStatsSource: "final",
      }),
    });

    const [closed] = await endSession();

    expect(closed.videos).toEqual([
      expect.objectContaining({
        eventId: "e1",
        watchedSeconds: 300,
        watchStatsSource: "final",
      }),
    ]);
    expect(closed.syncedToServer).toBe(false);
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

  it("participantToken도 저장돼 있으면 함께 반환한다", async () => {
    await global.chrome.storage.local.set({
      anonymousId: "a1",
      group: "EXP",
      installDate: "2026-01-01T00:00:00Z",
      participantToken: "hmac-token-abc",
    });
    expect((await getOnboarding()).participantToken).toBe("hmac-token-abc");
  });
});

// 연구 무결성 점검: content.js의 /api/video-events 즉시 전송이 실패하면 sent:false로
// 남는다. background.js의 재시도 큐가 이 두 함수로 그 상태를 읽고 갱신한다.
describe("getUnsentVideoEvents / markVideoEventSent", () => {
  it("세션 종료 전(video__ 키)의 미전송 영상을 찾아낸다(eventId 포함)", async () => {
    await global.chrome.storage.local.set({
      "video__s1__v1-1": {
        videoId: "v1",
        title: "제목-v1",
        watchedAt: "2026-01-01T00:00:00Z",
        sent: false,
        eventId: "v1-1",
      },
    });

    const events = await getUnsentVideoEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      location: "live",
      sessionId: "s1",
      videoId: "v1",
      // 재전송 시 서버의 OR IGNORE 멱등 처리를 타려면 같은 eventId를 그대로 들고 있어야 한다.
      eventId: "v1-1",
    });
  });

  it("재시도 대상 영상(video__ 키)의 isShortsUrl을 그대로 들고 간다(coderabbitai 리뷰: 누락 시 재시도 경로에서 값이 NULL로 저장됨)", async () => {
    await global.chrome.storage.local.set({
      "video__s1__v1-1": {
        videoId: "v1",
        title: "제목-v1",
        watchedAt: "2026-01-01T00:00:00Z",
        sent: false,
        eventId: "v1-1",
        isShortsUrl: 1,
      },
    });

    const [event] = await getUnsentVideoEvents();
    expect(event.isShortsUrl).toBe(1);
  });

  it("세션 종료 후(sessions[].videos)의 재시도 대상도 isShortsUrl을 그대로 들고 간다", async () => {
    await global.chrome.storage.local.set({
      sessions: [
        {
          sessionId: "s1",
          videos: [
            {
              videoId: "v1",
              title: "제목-v1",
              watchedAt: "t1",
              sent: false,
              isShortsUrl: 0,
            },
          ],
        },
      ],
    });

    const [event] = await getUnsentVideoEvents();
    expect(event.isShortsUrl).toBe(0);
  });

  it("다시 재생해 새로 만든 기록이면 재시도 대상에 앞 기록의 eventId(resumedFromEventId)를 그대로 들고 간다", async () => {
    await global.chrome.storage.local.set({
      "video__s2__v1-2": {
        videoId: "v1",
        watchedAt: "2026-01-01T00:20:00Z",
        sent: false,
        eventId: "v1-2",
        resumedFromEventId: "v1-1",
      },
      sessions: [
        {
          sessionId: "s1",
          videos: [
            {
              videoId: "v1",
              watchedAt: "2026-01-01T00:00:00Z",
              sent: false,
              eventId: "v1-3",
              resumedFromEventId: "v1-0",
            },
          ],
        },
      ],
    });

    const events = await getUnsentVideoEvents();
    expect(
      events.map((e) => [e.location, e.eventId, e.resumedFromEventId]),
    ).toEqual([
      ["live", "v1-2", "v1-1"],
      ["session", "v1-3", "v1-0"],
    ]);
  });

  it("sent:true인 영상(세션 종료 전)은 대상에서 제외한다", async () => {
    await global.chrome.storage.local.set({
      "video__s1__v1-1": {
        videoId: "v1",
        title: "제목-v1",
        watchedAt: "2026-01-01T00:00:00Z",
        sent: true,
      },
    });

    expect(await getUnsentVideoEvents()).toEqual([]);
  });

  it("sent 필드 자체가 없는(이 기능 이전에 기록된) 레거시 영상(video__ 키)은 재전송 대상에서 제외한다", async () => {
    // 구버전 content.js는 sent를 아예 기록하지 않았고, fire-and-forget이라 대부분
    // 이미 서버 전송에 성공한 상태다. !== true로 판정하면 이런 레거시 항목까지
    // "미전송"으로 오판해 eventId도 없이 재전송 → video_events에 영구 중복이 쌓인다.
    await global.chrome.storage.local.set({
      video__s1__legacy: {
        videoId: "v1",
        title: "제목-v1",
        watchedAt: "2026-01-01T00:00:00Z",
        // sent 필드 없음
      },
    });

    expect(await getUnsentVideoEvents()).toEqual([]);
  });

  it("세션 종료 후(sessions[].videos)의 미전송 영상도 찾아낸다", async () => {
    await global.chrome.storage.local.set({
      sessions: [
        {
          sessionId: "s1",
          videos: [
            { videoId: "v1", title: "제목-v1", watchedAt: "t1", sent: true },
            { videoId: "v2", title: "제목-v2", watchedAt: "t2", sent: false },
            // sent 필드 자체가 없는 레거시 영상 — 재전송 대상이 아니다.
            { videoId: "v3", title: "제목-v3", watchedAt: "t3" },
          ],
        },
      ],
    });

    const events = await getUnsentVideoEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      location: "session",
      sessionId: "s1",
      videoId: "v2",
    });
  });

  it("markVideoEventSent(live)는 video__ 키를 sent:true로 갱신한다", async () => {
    await global.chrome.storage.local.set({
      "video__s1__v1-1": {
        videoId: "v1",
        title: "제목-v1",
        watchedAt: "2026-01-01T00:00:00Z",
        sent: false,
      },
    });
    const [event] = await getUnsentVideoEvents();

    await markVideoEventSent(event);

    const all = await global.chrome.storage.local.get(null);
    expect(all["video__s1__v1-1"].sent).toBe(true);
  });

  it("markVideoEventSent(session)는 sessions[].videos 안의 해당 영상만 sent:true로 갱신한다", async () => {
    await global.chrome.storage.local.set({
      sessions: [
        {
          sessionId: "s1",
          videos: [
            { videoId: "v1", title: "제목-v1", watchedAt: "t1", sent: true },
            { videoId: "v2", title: "제목-v2", watchedAt: "t2", sent: false },
          ],
        },
      ],
    });
    const [event] = await getUnsentVideoEvents();

    await markVideoEventSent(event);

    const { sessions } = await global.chrome.storage.local.get("sessions");
    const videos = sessions[0].videos;
    expect(videos.find((v) => v.videoId === "v1").sent).toBe(true);
    expect(videos.find((v) => v.videoId === "v2").sent).toBe(true);
  });
});

// 시청시간 원시 데이터 — getUnsentVideoEvents/markVideoEventSent와 동일한
// dual-location(live video__ 키 / sessions[].videos[]) 구조를 검증한다.
describe("getUnsentWatchStats / markWatchStatsSent", () => {
  it("watchedSeconds가 있고 watchStatsSent가 false인 live 영상만 찾아낸다", async () => {
    await global.chrome.storage.local.set({
      "video__s1__v1-1": {
        videoId: "v1",
        eventId: "v1-1",
        watchedSeconds: 42,
        playbackRate: 1,
        wasBackgrounded: 0,
        watchStatsSent: false,
      },
    });

    const items = await getUnsentWatchStats();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      location: "live",
      sessionId: "s1",
      eventId: "v1-1",
      watchedSeconds: 42,
    });
  });

  it("watchedSeconds가 아직 없으면(계측 전) 대상에서 제외한다", async () => {
    await global.chrome.storage.local.set({
      "video__s1__v1-1": {
        videoId: "v1",
        eventId: "v1-1",
        watchStatsSent: false,
      },
    });

    expect(await getUnsentWatchStats()).toEqual([]);
  });

  it("watchStatsSent가 true면(이미 반영됨) 대상에서 제외한다", async () => {
    await global.chrome.storage.local.set({
      "video__s1__v1-1": {
        videoId: "v1",
        eventId: "v1-1",
        watchedSeconds: 42,
        watchStatsSent: true,
      },
    });

    expect(await getUnsentWatchStats()).toEqual([]);
  });

  it("영상 POST가 확정되지 않은(sent:false) 항목은 PATCH가 404가 되므로 제외하고, sent:true·레거시(sent 없음)는 포함한다", async () => {
    await global.chrome.storage.local.set({
      video__s1__pending: {
        eventId: "pending",
        watchedSeconds: 10,
        watchStatsSent: false,
        sent: false,
      },
      video__s1__posted: {
        eventId: "posted",
        watchedSeconds: 20,
        watchStatsSent: false,
        sent: true,
      },
      video__s1__legacy: {
        eventId: "legacy",
        watchedSeconds: 30,
        watchStatsSent: false,
      },
      sessions: [
        {
          sessionId: "s0",
          videos: [
            {
              eventId: "closed-pending",
              watchedSeconds: 40,
              watchStatsSent: false,
              sent: false,
            },
            {
              eventId: "closed-posted",
              watchedSeconds: 50,
              watchStatsSent: false,
              sent: true,
            },
          ],
        },
      ],
    });

    const eventIds = (await getUnsentWatchStats()).map((i) => i.eventId);
    expect(eventIds.sort()).toEqual(["closed-posted", "legacy", "posted"]);
  });

  it("세션 종료 후(sessions[].videos)의 미반영 시청시간도 찾아낸다", async () => {
    await global.chrome.storage.local.set({
      sessions: [
        {
          sessionId: "s1",
          videos: [
            {
              videoId: "v1",
              eventId: "e1",
              watchedSeconds: 10,
              watchStatsSent: true,
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

    const items = await getUnsentWatchStats();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      location: "session",
      sessionId: "s1",
      eventId: "e2",
      watchedSeconds: 55,
    });
  });

  it("markWatchStatsSent(live)는 video__ 키를 watchStatsSent:true로 갱신한다", async () => {
    await global.chrome.storage.local.set({
      "video__s1__v1-1": {
        videoId: "v1",
        eventId: "v1-1",
        watchedSeconds: 42,
        watchStatsSent: false,
      },
    });
    const [item] = await getUnsentWatchStats();

    await markWatchStatsSent(item);

    const all = await global.chrome.storage.local.get(null);
    expect(all["video__s1__v1-1"].watchStatsSent).toBe(true);
  });

  it("markWatchStatsSent(session)는 sessions[].videos 안의 해당 영상만 watchStatsSent:true로 갱신한다", async () => {
    await global.chrome.storage.local.set({
      sessions: [
        {
          sessionId: "s1",
          videos: [
            {
              videoId: "v1",
              eventId: "e1",
              watchedSeconds: 55,
              watchStatsSent: false,
            },
          ],
        },
      ],
    });
    const [item] = await getUnsentWatchStats();

    await markWatchStatsSent(item);

    const { sessions } = await global.chrome.storage.local.get("sessions");
    expect(sessions[0].videos[0].watchStatsSent).toBe(true);
  });

  it("전송하는 동안 더 새로운 시청시간이 기록되면 watchStatsSent를 true로 바꾸지 않는다", async () => {
    await global.chrome.storage.local.set({
      "video__s1__v1-1": {
        eventId: "v1-1",
        watchedSeconds: 42,
        watchStatsSent: false,
      },
    });
    const [item] = await getUnsentWatchStats();
    // 전송 중에 content.js가 최종값을 다시 썼다
    await global.chrome.storage.local.set({
      "video__s1__v1-1": {
        eventId: "v1-1",
        watchedSeconds: 60,
        watchStatsSent: false,
      },
    });

    await markWatchStatsSent(item);

    const all = await global.chrome.storage.local.get(null);
    expect(all["video__s1__v1-1"]).toMatchObject({
      watchedSeconds: 60,
      watchStatsSent: false,
    });
  });
});

// 탭을 닫아 최종값을 남기지 못한 영상 — content.js가 남긴 체크포인트(watchcp__<eventId>)를 대신 보낸다
describe("시청시간 체크포인트", () => {
  const NOW = Date.parse("2026-10-20T12:00:00Z");
  const STALE = NOW - WATCH_CHECKPOINT_STALE_MS - 1000;

  function checkpoint(eventId, at, watchedSeconds = 37) {
    return {
      [`watchcp__${eventId}`]: {
        sessionId: "s1",
        eventId,
        watchedSeconds,
        playbackRate: 1,
        wasBackgrounded: 0,
        at,
      },
    };
  }

  it("시청시간이 없는 영상의 오래된 체크포인트는 그 값으로 전송 대상에 넣는다", async () => {
    await global.chrome.storage.local.set({
      video__s1__e1: { eventId: "e1", sent: true },
      ...checkpoint("e1", STALE),
    });

    expect(await getUnsentWatchStats(NOW)).toEqual([
      {
        location: "live",
        key: "video__s1__e1",
        sessionId: "s1",
        eventId: "e1",
        watchedSeconds: 37,
        playbackRate: 1,
        wasBackgrounded: 0,
        at: STALE,
        source: "checkpoint",
      },
    ]);
  });

  it("세션이 닫혀 sessions[]로 옮겨간 영상도 체크포인트로 찾는다", async () => {
    await global.chrome.storage.local.set({
      sessions: [{ sessionId: "s1", videos: [{ eventId: "e1", sent: true }] }],
      ...checkpoint("e1", STALE),
    });

    const [item] = await getUnsentWatchStats(NOW);
    expect(item).toMatchObject({
      location: "session",
      sessionId: "s1",
      eventId: "e1",
      watchedSeconds: 37,
      source: "checkpoint",
    });
  });

  it("최근에 갱신된 체크포인트는(아직 보는 중) 보내지 않는다", async () => {
    await global.chrome.storage.local.set({
      video__s1__e1: { eventId: "e1", sent: true },
      ...checkpoint("e1", NOW - 10_000),
    });

    expect(await getUnsentWatchStats(NOW)).toEqual([]);
  });

  it("영상 기록에 최종값이 있거나, 영상 POST가 아직이거나, 영구 실패면 체크포인트를 보내지 않는다", async () => {
    await global.chrome.storage.local.set({
      video__s1__final: {
        eventId: "final",
        sent: true,
        watchedSeconds: 50,
        watchStatsSent: true,
      },
      video__s1__unposted: { eventId: "unposted", sent: false },
      video__s1__invalid: {
        eventId: "invalid",
        sent: true,
        watchStatsSent: "invalid",
      },
      ...checkpoint("final", STALE),
      ...checkpoint("unposted", STALE),
      ...checkpoint("invalid", STALE),
    });

    expect(await getUnsentWatchStats(NOW)).toEqual([]);
  });

  it("체크포인트로 보내면 그 값과 watchStatsSent:true를 영상 기록에 남긴다", async () => {
    await global.chrome.storage.local.set({
      video__s1__e1: { eventId: "e1", sent: true },
      ...checkpoint("e1", STALE),
    });
    const [item] = await getUnsentWatchStats(NOW);

    await markWatchStatsSent(item);

    const all = await global.chrome.storage.local.get(null);
    expect(all.video__s1__e1).toMatchObject({
      watchedSeconds: 37,
      playbackRate: 1,
      wasBackgrounded: 0,
      watchStatsSent: true,
    });
  });

  it("체크포인트를 보내는 동안 최종값이 들어오면 체크포인트 값으로 덮어쓰지 않는다", async () => {
    await global.chrome.storage.local.set({
      video__s1__e1: { eventId: "e1", sent: true },
      ...checkpoint("e1", STALE),
    });
    const [item] = await getUnsentWatchStats(NOW);
    await global.chrome.storage.local.set({
      video__s1__e1: {
        eventId: "e1",
        sent: true,
        watchedSeconds: 90,
        watchStatsSent: false,
      },
    });

    await markWatchStatsSent(item);

    const all = await global.chrome.storage.local.get(null);
    expect(all.video__s1__e1).toMatchObject({
      watchedSeconds: 90,
      watchStatsSent: false,
    });
  });

  it("최종값이 확정·영구 실패한 체크포인트와 하루 넘게 주인 없는 체크포인트만 지운다", async () => {
    await global.chrome.storage.local.set({
      video__s1__final: { eventId: "final", sent: true, watchedSeconds: 50 },
      video__s1__invalid: {
        eventId: "invalid",
        sent: true,
        watchStatsSent: "invalid",
      },
      video__s1__watching: { eventId: "watching", sent: true },
      ...checkpoint("final", STALE),
      ...checkpoint("invalid", STALE),
      ...checkpoint("watching", NOW - 10_000),
      ...checkpoint("orphan-old", NOW - 25 * 60 * 60 * 1000),
      ...checkpoint("orphan-new", NOW - 10_000),
    });

    await pruneWatchCheckpoints(NOW);

    const keys = Object.keys(await global.chrome.storage.local.get(null))
      .filter((k) => k.startsWith("watchcp__"))
      .sort();
    expect(keys).toEqual(["watchcp__orphan-new", "watchcp__watching"]);
  });
});

// 탭이 얼었다 깨어나면 체크포인트로 대신 보낸 뒤에도 같은 영상의 더 큰 체크포인트가 다시 쓰인다
describe("시청시간 체크포인트 — 체크포인트로 보낸 값은 확정값이 아니다", () => {
  const NOW = Date.parse("2026-10-20T12:00:00Z");
  const STALE = NOW - WATCH_CHECKPOINT_STALE_MS - 1000;
  const sentByCheckpoint = (checkpointAt, watchedSeconds = 30) => ({
    eventId: "e1",
    sent: true,
    watchedSeconds,
    watchStatsSent: true,
    watchStatsSource: "checkpoint",
    checkpointAt,
  });
  const checkpoint = (at, watchedSeconds) => ({
    watchcp__e1: {
      sessionId: "s1",
      eventId: "e1",
      watchedSeconds,
      playbackRate: 1,
      wasBackgrounded: 0,
      at,
    },
  });

  it("체크포인트로 보낸 뒤 더 새로운 체크포인트가 쓰이면 그 값을 다시 보낸다", async () => {
    await global.chrome.storage.local.set({
      video__s1__e1: sentByCheckpoint(STALE - 60_000),
      ...checkpoint(STALE, 90),
    });

    const items = await getUnsentWatchStats(NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      watchedSeconds: 90,
      at: STALE,
      source: "checkpoint",
    });
  });

  it("이미 보낸 체크포인트는 다시 보내지 않고 정리한다", async () => {
    await global.chrome.storage.local.set({
      video__s1__e1: sentByCheckpoint(STALE),
      ...checkpoint(STALE, 30),
    });

    expect(await getUnsentWatchStats(NOW)).toEqual([]);
    await pruneWatchCheckpoints(NOW);
    const all = await global.chrome.storage.local.get(null);
    expect(all.watchcp__e1).toBeUndefined();
  });

  it("체크포인트로 보낸 기록에 최종값이 오면 최종값만 보내고, 더 새로운 체크포인트는 보내지 않는다", async () => {
    await global.chrome.storage.local.set({
      video__s1__e1: {
        ...sentByCheckpoint(STALE - 60_000),
        watchedSeconds: 120,
        watchStatsSent: false,
        watchStatsSource: "final",
      },
      ...checkpoint(STALE, 90),
    });

    const items = await getUnsentWatchStats(NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ watchedSeconds: 120 });
    expect(items[0].source).toBeUndefined();
  });

  it("보내는 동안 더 새로운 체크포인트 값이 기록됐으면 오래된 전송 결과로 덮지 않는다", async () => {
    await global.chrome.storage.local.set({
      video__s1__e1: sentByCheckpoint(STALE + 5000, 90),
    });

    await markWatchStatsSent({
      location: "live",
      key: "video__s1__e1",
      sessionId: "s1",
      eventId: "e1",
      watchedSeconds: 30,
      playbackRate: 1,
      wasBackgrounded: 0,
      at: STALE,
      source: "checkpoint",
    });

    const all = await global.chrome.storage.local.get(null);
    expect(all.video__s1__e1).toMatchObject({
      watchedSeconds: 90,
      checkpointAt: STALE + 5000,
    });
  });

  it("체크포인트로 보내면 출처와 체크포인트 시각을 기록에 남긴다", async () => {
    await global.chrome.storage.local.set({
      video__s1__e1: { eventId: "e1", sent: true },
      ...checkpoint(STALE, 37),
    });
    const [item] = await getUnsentWatchStats(NOW);

    await markWatchStatsSent(item);

    const all = await global.chrome.storage.local.get(null);
    expect(all.video__s1__e1).toMatchObject({
      watchedSeconds: 37,
      watchStatsSent: true,
      watchStatsSource: "checkpoint",
      checkpointAt: STALE,
    });
  });

  it("세션이 닫혀도 체크포인트 출처·시각을 sessions[]로 옮긴다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
      video__s1__e1: {
        videoId: "v1",
        title: "제목-v1",
        watchedAt: "2026-01-01T00:00:00Z",
        ...sentByCheckpoint(STALE),
      },
    });

    await endSession();

    const [session] = await getAllSessions();
    expect(session.videos[0]).toMatchObject({
      watchStatsSource: "checkpoint",
      checkpointAt: STALE,
    });
  });
});

// 세션은 영상을 재생하는 중에도 닫혀, 닫는 순간의 체크포인트는 대개 막 갱신된 상태다
describe("getSessionCheckpointStats — 방금 닫은 세션의 체크포인트", () => {
  const NOW = Date.parse("2026-10-20T12:00:00Z");
  const checkpoint = (eventId, at, watchedSeconds = 600) => ({
    [`watchcp__${eventId}`]: {
      sessionId: "s1",
      eventId,
      watchedSeconds,
      playbackRate: 1,
      wasBackgrounded: 0,
      at,
    },
  });

  it("막 갱신된 체크포인트도 그 세션 영상의 체크포인트 항목으로 고른다", async () => {
    await global.chrome.storage.local.set({
      sessions: [{ sessionId: "s1", videos: [{ eventId: "e1", sent: true }] }],
      ...checkpoint("e1", NOW - 5_000),
    });

    expect(await getSessionCheckpointStats("s1")).toEqual([
      {
        location: "session",
        sessionId: "s1",
        eventId: "e1",
        watchedSeconds: 600,
        playbackRate: 1,
        wasBackgrounded: 0,
        at: NOW - 5_000,
        source: "checkpoint",
      },
    ]);
  });

  it("최종값이 있거나, 영상 POST가 아직이거나 영구 실패했거나, 시청시간이 영구 실패한 영상은 고르지 않는다", async () => {
    await global.chrome.storage.local.set({
      sessions: [
        {
          sessionId: "s1",
          videos: [
            {
              eventId: "final",
              sent: true,
              watchedSeconds: 50,
              watchStatsSent: false,
              watchStatsSource: "final",
            },
            { eventId: "unposted", sent: false },
            { eventId: "postInvalid", sent: "invalid" },
            { eventId: "statsInvalid", sent: true, watchStatsSent: "invalid" },
          ],
        },
      ],
      ...checkpoint("final", NOW),
      ...checkpoint("unposted", NOW),
      ...checkpoint("postInvalid", NOW),
      ...checkpoint("statsInvalid", NOW),
    });

    expect(await getSessionCheckpointStats("s1")).toEqual([]);
  });

  it("이미 보낸 체크포인트는 고르지 않고, 그보다 새로운 체크포인트는 고른다", async () => {
    const sentAt = NOW - 60_000;
    await global.chrome.storage.local.set({
      sessions: [
        {
          sessionId: "s1",
          videos: [
            {
              eventId: "e1",
              sent: true,
              watchedSeconds: 300,
              watchStatsSent: true,
              watchStatsSource: "checkpoint",
              checkpointAt: sentAt,
            },
          ],
        },
      ],
      ...checkpoint("e1", sentAt),
    });
    expect(await getSessionCheckpointStats("s1")).toEqual([]);

    await global.chrome.storage.local.set(checkpoint("e1", NOW, 360));
    const items = await getSessionCheckpointStats("s1");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ watchedSeconds: 360, at: NOW });
  });

  it("다른 세션 영상과 영상 기록이 없는 체크포인트는 고르지 않는다", async () => {
    await global.chrome.storage.local.set({
      sessions: [{ sessionId: "s1", videos: [{ eventId: "e1", sent: true }] }],
      video__s2__e2: { eventId: "e2", sent: true },
      ...checkpoint("e2", NOW),
      ...checkpoint("orphan", NOW),
    });

    expect(await getSessionCheckpointStats("s1")).toEqual([]);
  });

  it("고른 항목을 보낸 것으로 표시하면 세션 영상에 값·출처·체크포인트 시각이 남는다", async () => {
    await global.chrome.storage.local.set({
      sessions: [{ sessionId: "s1", videos: [{ eventId: "e1", sent: true }] }],
      ...checkpoint("e1", NOW),
    });
    const [item] = await getSessionCheckpointStats("s1");

    await markWatchStatsSent(item);

    const [session] = await getAllSessions();
    expect(session.videos[0]).toMatchObject({
      watchedSeconds: 600,
      watchStatsSent: true,
      watchStatsSource: "checkpoint",
      checkpointAt: NOW,
    });
  });
});

describe("pruneTabWatches — 이어 쓸 수 없게 된 탭별 마지막 기록을 지운다", () => {
  const NOW = Date.parse("2026-01-01T12:00:00Z");

  it("마지막 재생 후 10분이 된 기록부터 지우고, 10분 안의 기록과 다른 키는 남긴다", async () => {
    await global.chrome.storage.local.set({
      tabwatch__1: { videoId: "v1", endedAt: NOW - SESSION_TIMEOUT_MS },
      tabwatch__2: { videoId: "v2", endedAt: NOW - SESSION_TIMEOUT_MS + 1 },
      watchcp__e1: { eventId: "e1", at: NOW - SESSION_TIMEOUT_MS * 2 },
    });

    await pruneTabWatches(NOW);

    const all = await global.chrome.storage.local.get(null);
    expect(Object.keys(all).sort()).toEqual(["tabwatch__2", "watchcp__e1"]);
  });

  it("endedAt을 읽을 수 없는 기록은 지운다", async () => {
    await global.chrome.storage.local.set({
      tabwatch__1: null,
      tabwatch__2: { videoId: "v2" },
      tabwatch__3: { videoId: "v3", endedAt: "2026-01-01T12:00:00Z" },
    });

    await pruneTabWatches(NOW);

    expect(await global.chrome.storage.local.get(null)).toEqual({});
  });
});

describe("endSession — sent·eventId를 세션 종료 이후에도 보존한다", () => {
  it("전송 성공/실패 여부(sent)를 videos 배열로 그대로 옮긴다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
    });
    await global.chrome.storage.local.set({
      video__s1__v1: {
        videoId: "v1",
        title: "제목-v1",
        watchedAt: "2026-01-01T00:00:00Z",
        sent: true,
      },
      video__s1__v2: {
        videoId: "v2",
        title: "제목-v2",
        watchedAt: "2026-01-01T00:01:00Z",
        sent: false,
      },
    });
    await endSession();

    const sessions = await getAllSessions();
    const videos = sessions[0].videos;
    expect(videos.find((v) => v.videoId === "v1").sent).toBe(true);
    expect(videos.find((v) => v.videoId === "v2").sent).toBe(false);
  });

  it("eventId(서버 멱등 키)도 그대로 옮긴다 — 세션 종료 후 재시도해도 같은 eventId로 나가야 한다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
    });
    await global.chrome.storage.local.set({
      video__s1__v1: {
        videoId: "v1",
        title: "제목-v1",
        watchedAt: "2026-01-01T00:00:00Z",
        sent: false,
        eventId: "evt-v1",
      },
    });
    await endSession();

    const sessions = await getAllSessions();
    expect(sessions[0].videos[0].eventId).toBe("evt-v1");
  });

  it("isShortsUrl도 그대로 옮긴다(coderabbitai 리뷰: 누락되면 세션 종료 후 재시도 시 NULL로 저장됨)", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
    });
    await global.chrome.storage.local.set({
      video__s1__v1: {
        videoId: "v1",
        title: "제목-v1",
        watchedAt: "2026-01-01T00:00:00Z",
        sent: false,
        eventId: "evt-v1",
        isShortsUrl: 1,
      },
    });
    await endSession();

    const sessions = await getAllSessions();
    expect(sessions[0].videos[0].isShortsUrl).toBe(1);
  });

  it("resumedFromEventId도 그대로 옮긴다(누락되면 세션 종료 후 재시도 시 이어진 기록인지 알 수 없음)", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
      video__s1__v1: {
        videoId: "v1",
        watchedAt: "2026-01-01T00:00:00Z",
        sent: false,
        eventId: "evt-v1-2",
        resumedFromEventId: "evt-v1-1",
      },
    });
    await endSession();

    const sessions = await getAllSessions();
    expect(sessions[0].videos[0].resumedFromEventId).toBe("evt-v1-1");
  });
});

describe("참여자 등록 게이트 상태", () => {
  const BASE = {
    anonymousId: "a1",
    group: "EXP",
    installDate: "2026-01-01T00:00:00.000Z",
  };

  it("참여코드가 없어도 읽되 null로 채운다(구버전 설치 하위호환)", async () => {
    await global.chrome.storage.local.set(BASE);

    expect(await getParticipantSyncState()).toEqual({
      ...BASE,
      participantCode: null,
      synced: false,
      tokenMissing: true,
      failure: null,
      // 참여코드가 없으면 빈 문자열 자리로 들어간다 — 나중에 코드가 생기면 키가 달라져
      // 그때 기록된 permanent 판정이 자동으로 무효가 된다.
      requestKey: `a1|EXP|${BASE.installDate}|`,
    });
  });

  it.each([
    ["group 없음", { anonymousId: "a1", installDate: BASE.installDate }],
    ["anonymousId 없음", { group: "EXP", installDate: BASE.installDate }],
    ["installDate 없음", { anonymousId: "a1", group: "EXP" }],
  ])("%s이면 null을 반환해 요청 자체를 막는다", async (_label, stored) => {
    await global.chrome.storage.local.set(stored);

    expect(await getParticipantSyncState()).toBeNull();
  });

  it("등록 성공을 기록하면 남아 있던 실패 기록을 지운다", async () => {
    await global.chrome.storage.local.set({
      ...BASE,
      participantSyncFailure: { kind: "retryable", attempts: 3 },
    });

    await markParticipantSynced("tok");

    const state = await getParticipantSyncState();
    expect(state.synced).toBe(true);
    expect(state.failure).toBeNull();
  });

  it("무효화는 상태가 실제로 바뀐 경우에만 true를 반환한다", async () => {
    await global.chrome.storage.local.set({ ...BASE, participantSynced: true });

    expect(await invalidateParticipantSync()).toBe(true);
    // 403이 연속될 때 매 틱 storage를 쓰지 않도록 두 번째부터는 false
    expect(await invalidateParticipantSync()).toBe(false);
    expect((await getParticipantSyncState()).synced).toBe(false);
  });
});

// 필드를 하나씩 적어 옮기는 곳마다 빠지면, 그 경로로 보낸 기록만 서버에서 조용히 비게 된다
describe("실제 재생 시간(playedSeconds) — 세션을 닫거나 다시 보낼 때도 함께 옮긴다", () => {
  const NOW = Date.parse("2026-10-20T12:00:00Z");
  const STALE = NOW - WATCH_CHECKPOINT_STALE_MS - 1000;

  it("세션을 닫아 sessions[]로 옮겨도 남는다", async () => {
    await global.chrome.storage.local.set({
      currentSession: { sessionId: "s1", startTime: "2026-01-01T00:00:00Z" },
      video__s1__v1: {
        videoId: "v1",
        watchedAt: "2026-01-01T00:00:00Z",
        sent: true,
        eventId: "e1",
        watchedSeconds: 300,
        playedSeconds: 240,
        watchStatsSent: false,
      },
    });
    await endSession();

    const [session] = await getAllSessions();
    expect(session.videos[0]).toMatchObject({
      eventId: "e1",
      watchedSeconds: 300,
      playedSeconds: 240,
    });
  });

  it("재시도 큐 항목에 열린 기록과 닫힌 세션 기록 모두 실린다", async () => {
    await global.chrome.storage.local.set({
      video__s1__e1: {
        eventId: "e1",
        sent: true,
        watchedSeconds: 30,
        playedSeconds: 25,
        watchStatsSent: false,
      },
      sessions: [
        {
          sessionId: "s0",
          videos: [
            {
              eventId: "e0",
              sent: true,
              watchedSeconds: 60,
              playedSeconds: 50,
              watchStatsSent: false,
            },
          ],
        },
      ],
    });

    const items = await getUnsentWatchStats(NOW);
    expect(items).toHaveLength(2);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: "live",
          eventId: "e1",
          playedSeconds: 25,
        }),
        expect.objectContaining({
          location: "session",
          eventId: "e0",
          playedSeconds: 50,
        }),
      ]),
    );
  });

  it("탭을 닫아 대신 보내는 체크포인트 항목에 실리고, 보낸 뒤 영상 기록에도 남는다", async () => {
    await global.chrome.storage.local.set({
      video__s1__e1: { eventId: "e1", sent: true },
      watchcp__e1: {
        sessionId: "s1",
        eventId: "e1",
        watchedSeconds: 37,
        playbackRate: 1,
        wasBackgrounded: 0,
        playedSeconds: 30,
        at: STALE,
      },
    });

    const [item] = await getUnsentWatchStats(NOW);
    expect(item).toMatchObject({ source: "checkpoint", playedSeconds: 30 });

    await markWatchStatsSent(item);
    const { video__s1__e1: record } =
      await global.chrome.storage.local.get("video__s1__e1");
    expect(record).toMatchObject({
      watchedSeconds: 37,
      playedSeconds: 30,
      watchStatsSource: "checkpoint",
      watchStatsSent: true,
    });
  });

  it("방금 닫은 세션의 체크포인트 항목에도 실린다", async () => {
    await global.chrome.storage.local.set({
      sessions: [{ sessionId: "s1", videos: [{ eventId: "e1", sent: true }] }],
      watchcp__e1: {
        sessionId: "s1",
        eventId: "e1",
        watchedSeconds: 37,
        playedSeconds: 30,
        at: NOW,
      },
    });

    const [item] = await getSessionCheckpointStats("s1");
    expect(item).toMatchObject({ eventId: "e1", playedSeconds: 30 });
  });
});
