import { describe, it, expect, vi, afterEach } from "vitest";
import { loadPopup } from "./load-popup.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// 실제 팝업 파일을 불러온 뒤 이 테스트의 chrome·fetch를 넣는다(팝업 함수는 호출 시점에 전역을 찾는다).
// console은 전역 console의 warn·log를 가로채 돌려준다.
function stubConsole() {
  return {
    warn: vi.spyOn(globalThis.console, "warn").mockImplementation(() => {}),
    log: vi.spyOn(globalThis.console, "log").mockImplementation(() => {}),
  };
}

// 팝업 사용 기록 큐 — 큐에 들어갈 때의 토큰이 아니라 보낼 때의 토큰을 써야, 토큰 기능 이전(2.2.0)이나
// 등록 전에 쌓인 기록이 403에 막혀 큐 전체가 영원히 멈추지 않는다.
describe("flushPendingPopupEvents — 팝업 사용 기록 큐 전송", () => {
  const ID = "697236fb-5dd0-420f-aaae-c42128e1950a";

  async function load(initialStorage, respond) {
    const { flushPendingPopupEvents: flush } = await loadPopup();
    let store = { ...initialStorage };
    const chrome = {
      storage: {
        local: {
          get: async (keys) =>
            Object.fromEntries([].concat(keys).map((k) => [k, store[k]])),
          set: async (obj) => {
            store = { ...store, ...structuredClone(obj) };
          },
        },
      },
    };
    const sent = [];
    const fetch = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      sent.push(body);
      return respond(body);
    });
    vi.stubGlobal("chrome", chrome);
    vi.stubGlobal("fetch", fetch);
    const console = stubConsole();
    return { flush, sent, fetch, console, dump: () => store };
  }

  const ok = () => ({ ok: true, status: 201, json: async () => ({}) });
  const events = (n, extra = {}) =>
    Array.from({ length: n }, (_, i) => ({
      eventId: `e${i}`,
      anonymousId: ID,
      ...extra,
    }));

  it("토큰 없이 쌓인 옛 기록(2.2.0)을 지금 토큰으로 보내 큐를 비운다", async () => {
    const { flush, sent, dump } = await load(
      {
        pendingPopupEvents: events(7),
        anonymousId: ID,
        participantToken: "tok",
      },
      ok,
    );

    await flush("https://srv.example");

    expect(sent).toHaveLength(7);
    expect(sent.every((e) => e.participantToken === "tok")).toBe(true);
    expect(dump().pendingPopupEvents).toEqual([]);
  });

  it("다른 anonymousId로 쌓인 기록은 요청 없이 건너뛰고 뒤 기록은 정상 전송한다", async () => {
    const { flush, sent, dump, console } = await load(
      {
        pendingPopupEvents: [
          { eventId: "old", anonymousId: "other-id" },
          ...events(2),
        ],
        anonymousId: ID,
        participantToken: "tok",
      },
      ok,
    );

    await flush("https://srv.example");

    expect(sent.map((e) => e.eventId)).toEqual(["e0", "e1"]);
    expect(dump().pendingPopupEvents).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("skip_foreign_identity eventId=old"),
    );
  });

  it("403 INVALID_PARTICIPANT_TOKEN이면 등록 게이트가 토큰을 다시 받도록 되돌리고 큐는 남긴다", async () => {
    const { flush, sent, dump } = await load(
      {
        pendingPopupEvents: events(3),
        anonymousId: ID,
        participantSynced: true,
      },
      () => ({
        ok: false,
        status: 403,
        json: async () => ({ code: "INVALID_PARTICIPANT_TOKEN" }),
      }),
    );

    await flush("https://srv.example");

    expect(sent).toHaveLength(1);
    expect(dump().participantSynced).toBe(false);
    expect(dump().pendingPopupEvents).toHaveLength(3);
  });

  it.each([
    [
      "404",
      () => ({
        ok: false,
        status: 404,
        json: async () => ({ code: "NOT_FOUND" }),
      }),
    ],
    [
      "네트워크 오류",
      () => {
        throw new TypeError("network down");
      },
    ],
  ])("%s면 등록 상태는 그대로 두고 큐도 남긴다", async (_label, respond) => {
    const { flush, dump } = await load(
      {
        pendingPopupEvents: events(3),
        anonymousId: ID,
        participantToken: "tok",
        participantSynced: true,
      },
      respond,
    );

    await flush("https://srv.example");

    expect(dump().participantSynced).toBe(true);
    expect(dump().pendingPopupEvents).toHaveLength(3);
  });
});

// boot().catch 블록과 보고 함수만 떼어 내고, boot는 인자로 바꿔 끼워 실패를 재현한다
// 불러오는 순간 실행되는 실제 boot()를 저장소 읽기 실패로 실패시켜, 맨 아래 boot().catch 경로를 탄다
async function runBootCatch({ chrome, bootError }) {
  const consoleMock = {
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
  await loadPopup({
    chrome: {
      ...chrome,
      storage: { local: { get: () => Promise.reject(bootError) } },
    },
    quietBoot: false,
  });
  return consoleMock;
}

describe("boot 실패 — 빈 팝업을 오류 보고로 넘긴다", () => {
  it("POPUP_BOOT_FAILED를 코드·위치만 담아 background에 보낸다", async () => {
    const sendMessage = vi.fn(() => Promise.resolve());
    const chrome = { storage: { local: {} }, runtime: { sendMessage } };

    await runBootCatch({
      chrome,
      bootError: new Error("render failed: 참여코드 VL-ABCD 민감한 영상 제목"),
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    expect(sendMessage.mock.calls[0][0]).toEqual({
      type: "client-error",
      code: "POPUP_BOOT_FAILED",
      where: "popup.boot",
    });
    const sent = JSON.stringify(sendMessage.mock.calls);
    expect(sent).not.toContain("VL-ABCD");
    expect(sent).not.toContain("민감한");
  });

  it("메시지 전송이 실패해도 예외가 새어 나가지 않는다", async () => {
    const sendMessage = vi.fn(() => {
      throw new Error("Could not establish connection");
    });
    const chrome = { storage: { local: {} }, runtime: { sendMessage } };

    const consoleMock = await runBootCatch({
      chrome,
      bootError: new Error("x"),
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());

    expect(consoleMock.error).toHaveBeenCalledTimes(1);
  });
});

// 화면 그래프의 원천(서버 집계) — 저장본으로 바로 그리고, 열 때마다 새로 받아 덮어쓴다
describe("viewing-summary 조회와 저장본", () => {
  const ID = "697236fb-5dd0-420f-aaae-c42128e1950a";
  const SUMMARY = { days: [{ date: "2026-03-05" }], periods: [] };

  async function load(initialStorage, fetchImpl) {
    const { loadViewingSummaryCache, refreshViewingSummary } =
      await loadPopup();
    let store = { ...initialStorage };
    const chrome = {
      storage: {
        local: {
          get: async (keys) =>
            Object.fromEntries([].concat(keys).map((k) => [k, store[k]])),
          set: async (obj) => {
            store = { ...store, ...structuredClone(obj) };
          },
        },
      },
    };
    const fetch = vi.fn(fetchImpl);
    vi.stubGlobal("chrome", chrome);
    vi.stubGlobal("fetch", fetch);
    stubConsole();
    return {
      loadViewingSummaryCache,
      refreshViewingSummary,
      fetch,
      dump: () => store,
    };
  }

  const ok = (data) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data }),
  });

  it("새로 받으면 저장본을 덮어쓰고, 다음에 같은 참여자로 읽을 수 있다", async () => {
    const { refreshViewingSummary, loadViewingSummaryCache, fetch } =
      await load({}, ok(SUMMARY));

    const fresh = await refreshViewingSummary("https://srv", ID, "tok");
    const cached = await loadViewingSummaryCache(ID);

    expect(fresh.data).toEqual(SUMMARY);
    expect(cached).toEqual({ fetchedAt: fresh.fetchedAt, data: SUMMARY });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("https://srv/api/viewing-summary");
    expect(JSON.parse(options.body)).toEqual({
      anonymousId: ID,
      participantToken: "tok",
    });
  });

  it("서버가 실패하면 null을 돌려주고 기존 저장본을 지우지 않는다", async () => {
    const saved = {
      anonymousId: ID,
      fetchedAt: "2026-03-05T00:00:00Z",
      data: SUMMARY,
    };
    const { refreshViewingSummary, dump } = await load(
      { viewingSummaryCache: saved },
      async () => ({ ok: false, status: 500 }),
    );

    expect(await refreshViewingSummary("https://srv", ID, "tok")).toBeNull();
    expect(dump().viewingSummaryCache).toEqual(saved);
  });

  it("네트워크 오류·형식이 다른 응답도 null", async () => {
    const offline = await load({}, async () => {
      throw new TypeError("Failed to fetch");
    });
    const malformed = await load({}, ok({ days: "x" }));

    expect(
      await offline.refreshViewingSummary("https://srv", ID, "tok"),
    ).toBeNull();
    expect(
      await malformed.refreshViewingSummary("https://srv", ID, "tok"),
    ).toBeNull();
  });

  it("다른 참여자의 저장본은 쓰지 않는다(재설치·코드 복구)", async () => {
    const { loadViewingSummaryCache } = await load(
      {
        viewingSummaryCache: {
          anonymousId: "someone-else",
          fetchedAt: "2026-03-05T00:00:00Z",
          data: SUMMARY,
        },
      },
      ok(SUMMARY),
    );

    expect(await loadViewingSummaryCache(ID)).toBeNull();
  });

  it("서버 주소나 참여자 id가 없으면 요청하지 않는다", async () => {
    const { refreshViewingSummary, fetch } = await load({}, ok(SUMMARY));

    expect(
      await refreshViewingSummary("YOUR_SERVER_URL", ID, "tok"),
    ).toBeNull();
    expect(await refreshViewingSummary("https://srv", null, "tok")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

// 서버는 유효 시청 영상이 늘지 않은 세션에서 리뷰를 다시 만들지 않는다
describe("resolveTodayCumulative — 오늘 리뷰 카드 상태", () => {
  const TODAY = "2026-03-05";

  // dateStr는 같은 파일 안의 함수라 바꿔 끼울 수 없어 시스템 날짜를 TODAY(KST)로 고정한다.
  // 확인한 세션은 실제 isFeedbackConfirmed가 읽는 저장소(confirmedFeedbackSessionIds)에 넣는다.
  async function load(confirmed = []) {
    const { resolveTodayCumulative: resolve } = await loadPopup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${TODAY}T12:00:00+09:00`));
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async () => ({ confirmedFeedbackSessionIds: confirmed }),
          set: async () => {},
        },
      },
    });
    return { resolve };
  }
  const row = {
    reviewDate: TODAY,
    review: "오늘 리뷰",
    reviewTopic: "음악",
    generatedAt: "2026-03-05T05:32:00Z",
    sessionCount: 1,
  };

  it("대상이 아니면 빈 상태", async () => {
    const { resolve } = await load();
    expect(await resolve(false, [row], [])).toMatchObject({
      eligible: false,
      generating: false,
    });
  });

  it("서버 응답을 아직 못 받은 오늘 세션이 있으면 생성 중", async () => {
    const { resolve } = await load();
    const result = await resolve(
      true,
      [row],
      [
        { sessionId: "s1", syncedToServer: true, review: "오늘 리뷰" },
        { sessionId: "s2", syncedToServer: false },
      ],
    );
    expect(result.generating).toBe(true);
  });

  it("세션 종료 직후 전송 상태가 아직 없으면 생성 중", async () => {
    const { resolve } = await load();
    const result = await resolve(true, [row], [{ sessionId: "s1" }]);
    expect(result.generating).toBe(true);
  });

  it("서버가 거절한 세션(invalid)은 생성 중으로 남기지 않는다", async () => {
    const { resolve } = await load(["s1"]);
    expect(
      await resolve(
        true,
        [row],
        [
          { sessionId: "s1", syncedToServer: true, review: "오늘 리뷰" },
          { sessionId: "s2", syncedToServer: "invalid" },
        ],
      ),
    ).toMatchObject({
      generating: false,
      review: "오늘 리뷰",
      sessionId: "s1",
    });
    expect(
      await resolve(true, [], [{ sessionId: "s1", syncedToServer: "invalid" }]),
    ).toMatchObject({ generating: false, noReview: true });
  });

  it("리뷰를 건너뛴 세션(응답은 받았지만 리뷰 없음) 뒤에도 생성 중이 아니고 기존 리뷰를 보여 준다", async () => {
    const { resolve } = await load(["s1"]);
    const result = await resolve(
      true,
      [row],
      [
        { sessionId: "s1", syncedToServer: true, review: "오늘 리뷰" },
        { sessionId: "s2", syncedToServer: true },
      ],
    );
    expect(result).toMatchObject({
      generating: false,
      noReview: false,
      review: "오늘 리뷰",
      generatedAt: "2026-03-05T05:32:00Z",
      // 잠금·확인은 리뷰를 받은 세션 기준 — 이미 확인했으니 다시 잠기지 않는다
      sessionId: "s1",
      locked: false,
    });
  });

  it("리뷰를 받은 세션을 아직 확인하지 않았으면 잠근다", async () => {
    const { resolve } = await load([]);
    const result = await resolve(
      true,
      [row],
      [{ sessionId: "s1", syncedToServer: true, review: "오늘 리뷰" }],
    );
    expect(result).toMatchObject({ sessionId: "s1", locked: true });
  });

  it("기기에 리뷰를 받은 세션 기록이 없으면(재설치 등) 마지막 세션으로 대신한다", async () => {
    const { resolve } = await load([]);
    const result = await resolve(
      true,
      [row],
      [
        { sessionId: "s1", syncedToServer: true },
        { sessionId: "s2", syncedToServer: true },
      ],
    );
    expect(result.sessionId).toBe("s2");
  });

  it("모든 세션이 응답을 받았는데 오늘 리뷰가 없으면 noReview(생성 중 아님)", async () => {
    const { resolve } = await load();
    const result = await resolve(
      true,
      [],
      [{ sessionId: "s1", syncedToServer: true }],
    );
    expect(result).toMatchObject({
      generating: false,
      noReview: true,
      review: null,
    });
  });
});
