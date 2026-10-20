// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { loadPopup } from "./load-popup.js";
import {
  SERVER,
  bootPopup,
  cleanupPopup,
  daysAgo,
  hasFeedbackTabs,
  hasHome,
  participant,
  session,
} from "./boot-popup.js";

// 팝업을 열면 boot()가 저장소 상태를 읽어 화면을 고르고 서버 요청을 보낸다.
// 저장소·서버를 가짜로 두고 실제 팝업 파일을 불러와, 상태별로 화면과 요청이 맞는지 확인한다.
let BASELINE_DAYS, TOTAL_DAYS, END_GRACE_DAYS;

beforeAll(async () => {
  const g = await loadPopup();
  ({ BASELINE_DAYS, TOTAL_DAYS } = g.VL);
  ({ END_GRACE_DAYS } = g.ViewLensStudy);
  vi.unstubAllGlobals();
});

afterEach(cleanupPopup);

describe("boot — 저장소 상태별 화면과 서버 요청", () => {
  it("온보딩 전이면 코드 입력 화면을 띄우고 서버에 아무것도 보내지 않는다", async () => {
    const { root, data, server } = await bootPopup({ serverUrl: SERVER });
    await vi.waitFor(() =>
      expect(root.querySelector("#vl-onboard-input")).not.toBeNull(),
    );
    expect(server.calls).toEqual([]);
    expect(data.anonymousId).toBeUndefined();
  });

  it("실험군 진행 중이면 피드백 탭을 띄우고 집계·오늘 리뷰·기간 리뷰를 받고 쌓인 사용 기록을 보낸다", async () => {
    const { root, data, server } = await bootPopup(
      participant({
        group: "EXP",
        installDate: daysAgo(BASELINE_DAYS + 1),
        sessions: [session("s1")],
        pendingPopupEvents: [{ eventId: "e1", anonymousId: "anon-1" }],
      }),
    );
    await vi.waitFor(() => expect(data.pendingPopupEvents).toEqual([]));
    expect(hasFeedbackTabs(root)).toBe(true);
    expect(server.paths()).toEqual(
      expect.arrayContaining([
        "/api/viewing-summary",
        "/api/today-reviews",
        "/api/period-reviews",
        "/api/popup-events",
      ]),
    );
    expect(server.paths()).not.toContain("/api/participants");
    const event = server.calls.find((c) => c.path === "/api/popup-events");
    expect(event.body).toMatchObject({
      eventId: "e1",
      participantToken: "tok-1",
    });
    // 이번에 연 기록은 다음에 보내도록 live 슬롯에 남는다
    expect(data.livePopupEvent).toMatchObject({ anonymousId: "anon-1" });
  });

  it("대조군 진행 중이면 오늘 세션이 있어도 홈 화면만 띄우고 오늘 리뷰를 요청하지 않는다", async () => {
    const { root, server } = await bootPopup(
      participant({
        group: "CON",
        installDate: daysAgo(BASELINE_DAYS + 1),
        sessions: [session("s1")],
      }),
    );
    await vi.waitFor(() =>
      expect(server.paths()).toContain("/api/viewing-summary"),
    );
    expect(hasHome(root)).toBe(true);
    expect(hasFeedbackTabs(root)).toBe(false);
    expect(server.paths()).not.toContain("/api/today-reviews");
  });

  it("등록이 확인되지 않았으면 다시 등록하고 받은 토큰을 저장한다", async () => {
    const { data, server } = await bootPopup(
      participant({
        group: "EXP",
        installDate: daysAgo(1),
        participantSynced: false,
        participantToken: null,
      }),
    );
    await vi.waitFor(() => expect(data.participantSynced).toBe(true));
    const reg = server.calls.find((c) => c.path === "/api/participants");
    expect(reg.body).toEqual({
      anonymousId: "anon-1",
      participantCode: "P-001",
      group_code: "EXP",
      installDate: data.installDate,
    });
    expect(data.participantToken).toBe("new-tok");
  });

  it("참여 전송 기간까지 끝났으면 종료 안내를 띄우고 등록을 다시 시도하지 않는다", async () => {
    const { root, server } = await bootPopup(
      participant({
        group: "EXP",
        installDate: daysAgo(TOTAL_DAYS + END_GRACE_DAYS + 2),
        participantSynced: false,
      }),
    );
    await vi.waitFor(() =>
      expect(
        root.querySelector("#vl-participation-ended-banner"),
      ).not.toBeNull(),
    );
    expect(server.paths()).not.toContain("/api/participants");
  });

  it("온보딩은 됐는데 익명 ID가 없으면 새로 만들어 저장하고 그 ID로 등록한다", async () => {
    const { data, server } = await bootPopup(
      participant({
        group: "EXP",
        installDate: daysAgo(1),
        anonymousId: undefined,
        participantSynced: false,
      }),
    );
    await vi.waitFor(() => expect(data.participantSynced).toBe(true));
    expect(data.anonymousId).toMatch(/^[0-9a-f-]{36}$/);
    const reg = server.calls.find((c) => c.path === "/api/participants");
    expect(reg.body.anonymousId).toBe(data.anonymousId);
  });
});

// 서버는 끝난 구간의 리뷰를 매일 04:00 KST에 만든다. 그 전에 연 팝업이 "리뷰 없음"을 오늘 캐시로
// 남겨도, 끝난 구간의 리뷰가 빠져 있으면 다시 물어 같은 날 리뷰가 보이게 한다.
describe("boot — 기간 리뷰 캐시", () => {
  const DAYS_PER_PERIOD = 4;
  const todayKst = () =>
    new Date().toLocaleDateString("sv", { timeZone: "Asia/Seoul" });
  const cache = (reviews) => ({
    anonymousId: "anon-1",
    dateStr: todayKst(),
    reviews,
  });
  const review1 = { periodIndex: 1, review: "1구간 리뷰" };

  // 기간 리뷰 조회는 첫 화면을 그리기 전에 끝나므로, 화면이 그려지면 조회 여부가 정해진 것이다
  async function bootWithCache(over, responses) {
    const booted = await bootPopup(participant(over), { responses });
    await vi.waitFor(() =>
      expect(booted.root.textContent.length).toBeGreaterThan(0),
    );
    return booted;
  }

  it("끝난 구간의 리뷰가 없는 오늘 캐시면 서버에 다시 묻고 받은 리뷰로 캐시를 바꾼다", async () => {
    const { data, server } = await bootWithCache(
      {
        group: "EXP",
        installDate: daysAgo(DAYS_PER_PERIOD + 1),
        periodReviewsCache: cache([]),
      },
      { "/api/period-reviews": { data: [review1] } },
    );

    await vi.waitFor(() =>
      expect(data.periodReviewsCache.reviews).toEqual([review1]),
    );
    expect(server.count("/api/period-reviews")).toBe(1);
  });

  it("끝난 구간의 리뷰가 모두 있는 오늘 캐시면 서버에 묻지 않는다", async () => {
    const { root, server } = await bootWithCache({
      group: "EXP",
      installDate: daysAgo(DAYS_PER_PERIOD + 1),
      periodReviewsCache: cache([review1]),
    });

    expect(hasFeedbackTabs(root)).toBe(true);
    expect(server.count("/api/period-reviews")).toBe(0);
  });

  it("아직 끝난 구간이 없으면 빈 오늘 캐시를 그대로 쓴다", async () => {
    const { server } = await bootWithCache({
      group: "EXP",
      installDate: daysAgo(1),
      periodReviewsCache: cache([]),
    });

    expect(server.count("/api/period-reviews")).toBe(0);
  });

  it("다시 물었는데 서버가 실패하면 이전 캐시를 그대로 쓴다", async () => {
    const { root, data, server } = await bootWithCache(
      {
        group: "EXP",
        installDate: daysAgo(DAYS_PER_PERIOD + 1),
        periodReviewsCache: cache([]),
      },
      { "/api/period-reviews": () => ({ status: 500, body: {} }) },
    );

    expect(hasFeedbackTabs(root)).toBe(true);
    expect(server.count("/api/period-reviews")).toBe(1);
    expect(data.periodReviewsCache).toEqual(cache([]));
  });

  it("대조군은 리뷰가 다 차지 않은 캐시를 쓰지 않고, 다 차지 않은 응답은 캐시에 저장하지 않는다(기존 동작)", async () => {
    const { root, data, server } = await bootWithCache(
      {
        group: "CON",
        installDate: daysAgo(DAYS_PER_PERIOD + 1),
        periodReviewsCache: cache([]),
      },
      { "/api/period-reviews": { data: [review1] } },
    );

    expect(hasHome(root)).toBe(true);
    expect(server.count("/api/period-reviews")).toBe(1);
    expect(data.periodReviewsCache.reviews).toEqual([]);
  });
});
