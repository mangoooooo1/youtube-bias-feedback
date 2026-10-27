// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { loadPopup } from "./load-popup.js";
import { DAY, bootPopup, cleanupPopup, participant } from "./boot-popup.js";

// 재설치·저장소 비움으로 기기 기록이 모자란 날은 그날 영상 목록을 서버에서 받아 합친다.
let BASELINE_DAYS;

beforeAll(async () => {
  ({ BASELINE_DAYS } = (await loadPopup()).VL);
  vi.unstubAllGlobals();
});

afterEach(cleanupPopup);

const NOW = Date.parse("2026-03-05T12:00:00+09:00");
const TODAY = "2026-03-05";
const YESTERDAY = "2026-03-04";
const VIDEOS_PATH = "/api/viewing-summary/videos";

const video = (eventId, watchedAt, title = `영상 ${eventId}`) => ({
  eventId,
  videoId: `vid-${eventId}`,
  watchedAt,
  watchedSeconds: 300,
  title,
});
// 그날 서버 기록 수 = validCount + shortCount
const summaryDay = (date, count) => ({
  date,
  validCount: count,
  shortCount: 0,
  confirmedCount: count,
  chartCount: count,
  chartSeconds: 300 * count,
  timeDistribution: { 음악: 1 },
  countDistribution: { 음악: 1 },
  excluded: [],
  correctedTitles: {},
});
const review = (reviewDate, over) => ({
  reviewDate,
  review: `${reviewDate} 리뷰`,
  sessionCount: 1,
  ...over,
});

const stored = (over) =>
  participant({
    group: "EXP",
    installDate: new Date(NOW - (BASELINE_DAYS + 1) * DAY).toISOString(),
    sessions: [],
    ...over,
  });

// days: 집계에 넣을 날짜 → 서버 기록 수, videosByDate: 날짜 → 서버 목록(함수면 응답 그대로)
function responses({ days = {}, videosByDate = {}, reviews = [] }) {
  return {
    "/oembed": { title: "oEmbed 제목" },
    "/api/viewing-summary": {
      data: {
        days: Object.entries(days).map(([date, n]) => summaryDay(date, n)),
        periods: [],
      },
    },
    "/api/today-reviews": { data: reviews },
    [VIDEOS_PATH]:
      typeof videosByDate === "function"
        ? videosByDate
        : (body) => ({
            body: {
              data: { date: body.date, videos: videosByDate[body.date] ?? [] },
            },
          }),
  };
}

async function boot(state, opts) {
  const p = await bootPopup(state, {
    responses: responses(opts),
    now: NOW,
  });
  await vi.waitFor(() => expect(p.data.livePopupEvent).toBeTruthy());
  // 서버 집계가 도착해 다시 그린 뒤부터 요청 여부를 본다
  await vi.waitFor(() =>
    expect(p.server.count("/api/viewing-summary")).toBe(1),
  );
  await new Promise((r) => setTimeout(r, 0));
  return p;
}

const prevDay = (root) => root.querySelector("#vl-date-prev").click();
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("지난 날짜 — 기기에 기록이 없을 때", () => {
  const yesterdayVideos = [
    video("s1", "2026-03-04T10:00:00+09:00", "서버 영상 1"),
    video("s2", "2026-03-04T11:00:00+09:00", "서버 영상 2"),
  ];
  const opts = {
    days: { [YESTERDAY]: 2 },
    videosByDate: { [YESTERDAY]: yesterdayVideos },
    reviews: [review(YESTERDAY)],
  };

  it("서버에서 그날 목록을 받아 보여 주고 저장한다. 다시 열면 요청하지 않고 저장본을 쓴다", async () => {
    const first = await boot(stored(), opts);
    prevDay(first.root);
    await vi.waitFor(() =>
      expect(first.root.textContent).toContain("서버 영상 2"),
    );
    expect(first.root.textContent).toContain("서버 영상 1");
    expect(first.server.calls.find((c) => c.path === VIDEOS_PATH).body).toEqual(
      { anonymousId: "anon-1", participantToken: "tok-1", date: YESTERDAY },
    );
    await vi.waitFor(() =>
      expect(first.data.dayVideosCache).toEqual({
        anonymousId: "anon-1",
        byDate: { [YESTERDAY]: yesterdayVideos },
      }),
    );
    // 받은 목록은 로컬 세션에 넣지 않는다
    expect(first.data.sessions).toEqual([]);

    const saved = structuredClone(first.data);
    cleanupPopup();
    const again = await boot(saved, opts);
    prevDay(again.root);
    await settle();

    expect(again.root.textContent).toContain("서버 영상 1");
    expect(again.root.textContent).toContain("서버 영상 2");
    expect(again.server.count(VIDEOS_PATH)).toBe(0);
  });

  it("다른 참여자의 저장본은 쓰지 않고 내 목록으로 바꾼다", async () => {
    const { root, data } = await boot(
      stored({
        dayVideosCache: {
          anonymousId: "someone-else",
          byDate: {
            [YESTERDAY]: [
              video("x1", "2026-03-04T09:00:00+09:00", "다른 사람 영상"),
            ],
          },
        },
      }),
      opts,
    );
    prevDay(root);
    await vi.waitFor(() => expect(root.textContent).toContain("서버 영상 1"));

    expect(root.textContent).not.toContain("다른 사람 영상");
    await vi.waitFor(() =>
      expect(data.dayVideosCache).toEqual({
        anonymousId: "anon-1",
        byDate: { [YESTERDAY]: yesterdayVideos },
      }),
    );
  });
});

describe("기기 기록이 충분하거나 받기에 실패했을 때", () => {
  const localSession = (videos) => ({
    sessionId: "s-local",
    endTime: "2026-03-04T12:00:00+09:00",
    syncedToServer: true,
    videos,
  });

  it("기기 기록 수가 그날 서버 기록 수 이상이면 요청하지 않는다", async () => {
    const { root, server } = await boot(
      stored({
        sessions: [
          localSession([
            video("l1", "2026-03-04T10:00:00+09:00", "기기 영상 1"),
            video("l2", "2026-03-04T11:00:00+09:00", "기기 영상 2"),
          ]),
        ],
      }),
      { days: { [YESTERDAY]: 2 }, reviews: [review(YESTERDAY)] },
    );
    prevDay(root);
    await settle();

    expect(root.textContent).toContain("기기 영상 2");
    expect(server.count(VIDEOS_PATH)).toBe(0);
  });

  it("받기에 실패하면 기기 기록만 보이고, 그 팝업에서는 같은 날짜를 다시 요청하지 않는다", async () => {
    const { root, server, data } = await boot(
      stored({
        sessions: [
          localSession([
            video("l1", "2026-03-04T10:00:00+09:00", "기기 영상 1"),
          ]),
        ],
      }),
      {
        days: { [YESTERDAY]: 2 },
        videosByDate: () => ({ status: 500 }),
        reviews: [review(YESTERDAY)],
      },
    );
    prevDay(root);
    await vi.waitFor(() => expect(server.count(VIDEOS_PATH)).toBe(1));
    await settle();
    expect(root.textContent).toContain("기기 영상 1");

    // 다른 날로 갔다가 돌아와도 다시 요청하지 않는다
    root.querySelector("#vl-date-next").click();
    prevDay(root);
    await settle();
    expect(server.count(VIDEOS_PATH)).toBe(1);
    expect(data.dayVideosCache).toBeUndefined();
  });
});

describe("오늘 — 같은 날 재설치", () => {
  // 재설치 뒤 본 영상(진행 중인 세션)과 재설치 전 서버 기록
  const liveKey = {
    "video__s-after__l1": {
      ...video("l1", "2026-03-05T11:00:00+09:00", "재설치 뒤 영상"),
      sent: true,
    },
  };
  const todayServer = [
    video("s1", "2026-03-05T09:00:00+09:00", "재설치 전 영상"),
    video("l1", "2026-03-05T11:00:00+09:00", "서버에 보낸 같은 영상"),
  ];
  const opts = (over) => ({
    days: { [TODAY]: 2 },
    videosByDate: { [TODAY]: todayServer },
    reviews: [
      review(TODAY, {
        reviewSessionId: "s-before",
        reviewConfirmed: true,
        ...over,
      }),
    ],
  });

  it("기기 기록을 기준으로 서버에만 있는 영상을 합쳐 보여 주고, 오늘 목록은 저장하지 않는다", async () => {
    const { root, data, server } = await boot(stored(liveKey), opts());
    await vi.waitFor(() =>
      expect(root.textContent).toContain("재설치 전 영상"),
    );

    expect(root.textContent).toContain("재설치 뒤 영상");
    expect(root.textContent).not.toContain("서버에 보낸 같은 영상");
    expect(server.count(VIDEOS_PATH)).toBe(1);
    expect(data.dayVideosCache).toBeUndefined();
  });

  it("서버 목록을 합쳐도 블러와 확인 기록은 서버가 알려 준 리뷰 세션을 따른다", async () => {
    const { root, data, server } = await boot(
      stored(liveKey),
      opts({ reviewConfirmed: false }),
    );
    await vi.waitFor(() => expect(server.count(VIDEOS_PATH)).toBe(1));
    await vi.waitFor(() =>
      expect(root.querySelector("#vl-feedback-confirm-btn")).not.toBeNull(),
    );

    root.querySelector("#vl-feedback-confirm-btn").click();
    await vi.waitFor(() =>
      expect(server.paths()).toContain(
        "/api/sessions/s-before/feedback-confirmed",
      ),
    );
    expect(data.sessions).toEqual([]);
  });
});

describe("서버에서 받은 영상의 제목", () => {
  const opts = (videos) => ({
    days: { [YESTERDAY]: videos.length },
    videosByDate: { [YESTERDAY]: videos },
    reviews: [review(YESTERDAY)],
  });

  it("보낸 제목도 메타데이터 제목도 없으면 oEmbed로 받아 보여 주고 기기에 둔다", async () => {
    const { root, server, data } = await boot(
      stored(),
      opts([video("s1", "2026-03-04T10:00:00+09:00", null)]),
    );
    prevDay(root);
    await vi.waitFor(() => expect(root.textContent).toContain("oEmbed 제목"));

    expect(server.count("/oembed")).toBe(1);
    expect(data.videoTitleCache).toEqual({ "vid-s1": "oEmbed 제목" });
  });

  it("보낸 제목이 있으면 oEmbed에 묻지 않는다", async () => {
    const { root, server } = await boot(
      stored(),
      opts([video("s1", "2026-03-04T10:00:00+09:00", "보낸 제목")]),
    );
    prevDay(root);
    await vi.waitFor(() => expect(root.textContent).toContain("보낸 제목"));
    await settle();

    expect(server.count("/oembed")).toBe(0);
  });
});
