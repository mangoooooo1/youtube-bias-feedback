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

  // 큐에 넣을 때(buildPopupEventPayload) 그 시점의 토큰도 함께 저장된다. 등록 전이면 null,
  // 이후 토큰이 바뀌었으면 옛 값이라, 보낼 때 지금 토큰으로 덮어써야 403에 막히지 않는다.
  it.each([
    ["등록 전에 쌓여 토큰이 null인 기록", null],
    ["예전 토큰이 남은 기록", "old-tok"],
  ])("%s도 지금 토큰으로 보낸다", async (_label, queuedToken) => {
    const { flush, sent, dump } = await load(
      {
        pendingPopupEvents: events(2, { participantToken: queuedToken }),
        anonymousId: ID,
        participantToken: "tok",
      },
      ok,
    );

    await flush("https://srv.example");

    expect(sent.map((e) => e.participantToken)).toEqual(["tok", "tok"]);
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

// 기록한 제목도 서버 제목도 없는 영상만 oEmbed로 제목을 받아 기기에 둔다
describe("fillMissingTitles — 제목이 없는 영상의 oEmbed 제목", () => {
  async function load(initialStorage, respond) {
    const { fillMissingTitles } = await loadPopup();
    let store = { ...initialStorage };
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (keys) =>
            Object.fromEntries([].concat(keys).map((k) => [k, store[k]])),
          set: async (obj) => {
            store = { ...store, ...structuredClone(obj) };
          },
        },
      },
    });
    const fetch = vi.fn(async (url) =>
      respond(new URL(url).searchParams.get("url")),
    );
    vi.stubGlobal("fetch", fetch);
    return { fillMissingTitles, fetch, dump: () => store };
  }
  const idOf = (watchUrl) => new URL(watchUrl).searchParams.get("v");
  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  it("받은 제목을 저장하고, 비공개·삭제 영상은 null로 남겨 다시 묻지 않는다", async () => {
    const { fillMissingTitles, fetch, dump } = await load({}, (watchUrl) => {
      const id = idOf(watchUrl);
      if (id === "ok") return json(200, { title: "받은 제목" });
      if (id === "private") return json(401);
      return json(404);
    });

    const titles = await fillMissingTitles(["ok", "private", "gone", "ok"]);

    expect(titles).toEqual({ ok: "받은 제목", private: null, gone: null });
    expect(dump().videoTitleCache).toEqual(titles);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0][0]).toBe(
      "https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dok",
    );

    await fillMissingTitles(["ok", "private", "gone"]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("네트워크 오류·서버 오류는 저장하지 않아 다음에 다시 묻는다", async () => {
    const { fillMissingTitles, dump } = await load(
      { videoTitleCache: { old: "이전 제목" } },
      (watchUrl) => {
        if (idOf(watchUrl) === "offline")
          throw new TypeError("Failed to fetch");
        return json(500);
      },
    );

    const titles = await fillMissingTitles(["offline", "busy"]);

    expect(titles).toEqual({ old: "이전 제목" });
    expect(dump().videoTitleCache).toEqual({ old: "이전 제목" });
  });

  it("팝업을 한 번 열 때 20개까지만 묻는다", async () => {
    const { fillMissingTitles, fetch } = await load({}, () =>
      json(200, { title: "제목" }),
    );

    await fillMissingTitles(Array.from({ length: 25 }, (_, i) => `v${i}`));

    expect(fetch).toHaveBeenCalledTimes(20);
  });
});

describe("videoIdsWithoutTitle — oEmbed로 물어볼 영상", () => {
  it("기록한 제목이 비어 있고 서버 제목도 없는 영상만 고른다", async () => {
    const { videoIdsWithoutTitle } = await loadPopup();
    const sessions = [
      {
        videos: [
          { eventId: "e1", videoId: "has-title", title: "제목" },
          { eventId: "e2", videoId: "server-fixed", title: null },
        ],
      },
    ];
    const live = [
      { eventId: "e3", videoId: "blank", title: "  " },
      { eventId: "e4", videoId: null, title: null },
    ];
    const summary = { days: [{ correctedTitles: { e2: "서버 제목" } }] };

    expect(videoIdsWithoutTitle(sessions, live, summary)).toEqual(["blank"]);
    expect(videoIdsWithoutTitle(sessions, live, null)).toEqual([
      "server-fixed",
      "blank",
    ]);
  });

  it("서버에서 받아 둔 목록의 영상도 같은 기준으로 고른다", async () => {
    const { videoIdsWithoutTitle } = await loadPopup();
    const serverVideos = [
      { eventId: "s1", videoId: "server-sent", title: "보낸 제목" },
      { eventId: "s2", videoId: "server-meta", title: null },
      { eventId: "s3", videoId: "server-none", title: null },
    ];
    const summary = { days: [{ correctedTitles: { s2: "메타데이터 제목" } }] };

    expect(videoIdsWithoutTitle([], [], summary, serverVideos)).toEqual([
      "server-none",
    ]);
  });
});

// 다시 그리면 스크롤·입력값이 사라져, 화면에 새로 보일 제목이 생겼을 때만 다시 그린다
describe("hasNewDisplayTitle — oEmbed 조회 뒤 다시 그릴지", () => {
  it("새 제목이 생기거나 제목이 바뀌면 true", async () => {
    const { hasNewDisplayTitle } = await loadPopup();

    expect(hasNewDisplayTitle({}, { a: "제목" })).toBe(true);
    expect(hasNewDisplayTitle({ a: null }, { a: "제목" })).toBe(true);
    expect(hasNewDisplayTitle({ a: "옛 제목" }, { a: "새 제목" })).toBe(true);
  });

  it("비공개·삭제 영상(null)·빈 제목만 추가되면 false", async () => {
    const { hasNewDisplayTitle } = await loadPopup();

    expect(hasNewDisplayTitle({ a: "제목" }, { a: "제목", b: null })).toBe(
      false,
    );
    expect(hasNewDisplayTitle({}, { b: "  " })).toBe(false);
  });

  it("내용이 같은 다른 객체·조회할 게 없어 같은 저장본이 돌아오면 false", async () => {
    const { hasNewDisplayTitle } = await loadPopup();
    const cache = { a: "제목", b: null };

    expect(hasNewDisplayTitle(cache, { ...cache })).toBe(false);
    expect(hasNewDisplayTitle(cache, cache)).toBe(false);
    expect(hasNewDisplayTitle(undefined, {})).toBe(false);
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

// 세션 종료 시각은 마지막 영상 + 10분이라, 23:55에 본 세션은 다음 날 00:05에 끝난다.
// 서버는 영상을 본 시각으로 날짜를 정하므로 이 세션은 전날 것이다.
describe("세션 날짜 — 영상을 본 시각 기준", () => {
  const kst = (time) => new Date(`${time}+09:00`).toISOString();
  const NOW = kst("2026-03-06T00:30:00");
  // 23:55 영상 하나, 00:05 종료
  const lateNight = (over) => ({
    sessionId: "late",
    endTime: kst("2026-03-06T00:05:00"),
    categoryDistribution: { 뉴스: 1 },
    syncedToServer: true,
    videos: [{ eventId: "e1", watchedAt: kst("2026-03-05T23:55:00") }],
    ...over,
  });
  // 23:50·00:02 영상, 00:12 종료 — 자정을 걸쳤다
  const acrossMidnight = (over) => ({
    sessionId: "across",
    endTime: kst("2026-03-06T00:12:00"),
    categoryDistribution: { 뉴스: 1 },
    syncedToServer: true,
    videos: [
      { eventId: "e2", watchedAt: kst("2026-03-05T23:50:00") },
      { eventId: "e3", watchedAt: kst("2026-03-06T00:02:00") },
    ],
    ...over,
  });
  const todayRow = {
    reviewDate: "2026-03-06",
    review: "오늘 리뷰",
    reviewTopic: "음악",
    generatedAt: kst("2026-03-06T00:20:00"),
    sessionCount: 1,
  };

  async function load() {
    const popup = await loadPopup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async () => ({ confirmedFeedbackSessionIds: [] }),
          set: async () => {},
        },
      },
    });
    return popup;
  }

  it("자정 직전에 본 세션은 다음 날 오늘 세션·리뷰 대상에 들지 않고 전날 세션이 된다", async () => {
    const { todaySessionsOf, buildDataForDate } = await load();
    const sessions = [lateNight()];

    expect(todaySessionsOf(sessions)).toEqual([]);
    expect(buildDataForDate(sessions, new Date(NOW))).toMatchObject({
      isEmpty: true,
      sessionIds: [],
    });
    expect(
      buildDataForDate(sessions, new Date(kst("2026-03-05T12:00:00")))
        .sessionIds,
    ).toEqual(["late"]);
  });

  it("자정 직전에 본 세션이 서버 응답을 기다려도 다음 날 오늘 탭은 생성 중이 아니다", async () => {
    const { todaySessionsOf, resolveTodayCumulative } = await load();
    const result = await resolveTodayCumulative(
      true,
      [],
      todaySessionsOf([lateNight({ syncedToServer: false })]),
    );
    expect(result.generating).toBe(false);
  });

  it("자정 직전에 본 세션을 다음 날 리뷰의 잠금 세션으로 쓰지 않는다", async () => {
    const { todaySessionsOf, resolveTodayCumulative } = await load();
    const result = await resolveTodayCumulative(
      true,
      [todayRow],
      todaySessionsOf([lateNight()]),
    );
    expect(result.sessionId).toBeNull();
  });

  it("자정을 걸친 세션은 마지막 영상을 본 다음 날의 오늘 세션이다", async () => {
    const { todaySessionsOf, buildDataForDate, resolveTodayCumulative } =
      await load();
    const sessions = [lateNight(), acrossMidnight({ review: "오늘 리뷰" })];

    expect(todaySessionsOf(sessions).map((s) => s.sessionId)).toEqual([
      "across",
    ]);
    expect(buildDataForDate(sessions, new Date(NOW)).sessionIds).toEqual([
      "across",
    ]);
    expect(
      await resolveTodayCumulative(true, [todayRow], todaySessionsOf(sessions)),
    ).toMatchObject({ sessionId: "across", locked: true });
  });

  it("영상 시각이 없는 세션은 종료 시각으로 날짜를 정한다", async () => {
    const { todaySessionsOf } = await load();
    const sessions = [lateNight({ videos: undefined })];
    expect(todaySessionsOf(sessions).map((s) => s.sessionId)).toEqual(["late"]);
  });
});
