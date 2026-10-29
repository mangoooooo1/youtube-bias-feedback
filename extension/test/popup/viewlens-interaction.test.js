// @vitest-environment jsdom
/* global KeyboardEvent, Element */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { loadPopup } from "./load-popup.js";
import {
  bootPopup,
  cleanupPopup,
  daysAgo,
  hasFeedbackTabs,
  participant,
  session,
} from "./boot-popup.js";

// 팝업을 연 뒤 참여자가 누르는 것(탭·버튼·코드 입력)과 팝업이 열린 채 저장소가 바뀌는 경우,
// 화면·저장소·서버 요청이 맞게 바뀌는지 실제 팝업(boot)으로 확인한다.
let BASELINE_DAYS, TOTAL_DAYS;

beforeAll(async () => {
  const g = await loadPopup();
  ({ BASELINE_DAYS, TOTAL_DAYS } = g.VL);
  vi.unstubAllGlobals();
});

afterEach(cleanupPopup);

const kst = (iso) =>
  new Date(iso).toLocaleDateString("sv", { timeZone: "Asia/Seoul" });
const TODAY = () => kst(new Date().toISOString());
const todayReview = (review) => ({
  reviewDate: TODAY(),
  review,
  sessionCount: 1,
});

const IN_PROGRESS = () => daysAgo(BASELINE_DAYS + 1);
const STUDY_ENDED = () => daysAgo(TOTAL_DAYS + 1);

// 클릭 기록 리스너는 boot 마지막에 붙는다. 이번 사용 기록이 live 슬롯에 생기면 준비된 것
async function bootReady(stored, opts) {
  const p = await bootPopup(stored, opts);
  await vi.waitFor(() => expect(p.data.livePopupEvent).toBeTruthy());
  return p;
}

const click = (root, selector) => root.querySelector(selector).click();
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("탭 전환 — 사용 기록", () => {
  it("기간 탭을 누르면 화면이 바뀌고 클릭 수를 남기며, 2초 이상 머물러야 기간 피드백을 본 것으로 센다", async () => {
    const { root, data } = await bootReady(
      participant({ group: "EXP", installDate: IN_PROGRESS() }),
    );
    click(root, '[data-tab="feedback"]');
    expect(root.querySelector("#vl-week-btns")).not.toBeNull();
    expect(data.livePopupEvent.tabWeekClicks).toBe(1);

    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0 + 1500);
    vi.advanceTimersByTime(1000);
    expect(data.livePopupEvent.periodFeedbackViewed).toBe(0);

    now.mockReturnValue(t0 + 2500);
    vi.advanceTimersByTime(1000);
    expect(data.livePopupEvent.periodFeedbackViewed).toBe(1);

    click(root, '[data-tab="today"]');
    expect(root.querySelector("#vl-week-btns")).toBeNull();
    expect(data.livePopupEvent.tabTodayClicks).toBe(1);
  });
});

describe("피드백 확인하기", () => {
  it("가려진 오늘 리뷰를 누르면 블러가 풀리고, 확인을 기기·서버에 기록하고, 아이콘 표시를 지운다", async () => {
    const { root, data, server, chrome } = await bootReady(
      participant({
        group: "EXP",
        installDate: IN_PROGRESS(),
        sessions: [session("s1", { review: "오늘 리뷰 문장" })],
      }),
      {
        responses: {
          "/api/today-reviews": { data: [todayReview("오늘 리뷰 문장")] },
        },
      },
    );
    expect(data.livePopupEvent.todayFeedbackViewed).toBe(0);
    expect(chrome.action.setIcon).not.toHaveBeenCalled();

    click(root, "#vl-feedback-confirm-btn");
    await vi.waitFor(() =>
      expect(server.paths()).toContain("/api/sessions/s1/feedback-confirmed"),
    );
    expect(root.querySelector("#vl-feedback-confirm-btn")).toBeNull();
    expect(data.confirmedFeedbackSessionIds).toEqual(["s1"]);
    expect(data.livePopupEvent.todayFeedbackViewed).toBe(1);
    expect(chrome.action.setIcon).toHaveBeenCalled();
    const patch = server.calls.find((c) => c.path.startsWith("/api/sessions/"));
    expect(patch).toMatchObject({
      method: "PATCH",
      body: { anonymousId: "anon-1", participantToken: "tok-1" },
    });
  });

  it("이미 확인한 세션의 리뷰는 다시 가리지 않는다", async () => {
    const { root, data } = await bootReady(
      participant({
        group: "EXP",
        installDate: IN_PROGRESS(),
        sessions: [session("s1", { review: "오늘 리뷰 문장" })],
        confirmedFeedbackSessionIds: ["s1"],
      }),
      {
        responses: {
          "/api/today-reviews": { data: [todayReview("오늘 리뷰 문장")] },
        },
      },
    );
    expect(root.querySelector("#vl-feedback-confirm-btn")).toBeNull();
    expect(root.textContent).toContain("오늘 리뷰 문장");
    expect(data.livePopupEvent.todayFeedbackViewed).toBe(1);
  });
});

describe("대조군 연구 종료 코드 입력", () => {
  async function openCodeInput(responses) {
    const p = await bootReady(
      participant({ group: "CON", installDate: STUDY_ENDED() }),
      { responses },
    );
    click(p.root, "#vl-study-end-cta");
    const input = p.root.querySelector("#vl-study-end-code-input");
    const errText = () => p.root.querySelector("#vl-study-end-code-err");
    return { ...p, input, errText };
  }

  it("빈 칸으로 누르면 서버에 묻지 않고 입력을 요청한다", async () => {
    const { root, server, errText } = await openCodeInput();
    click(root, "#vl-study-end-code-btn");
    expect(errText().textContent).toBe("코드를 입력해 주세요.");
    expect(server.paths()).not.toContain("/api/study-end-code/validate");
  });

  it.each([
    [
      "틀린 코드",
      { data: { valid: false } },
      "코드가 올바르지 않아요. 설문에서 안내받은 코드를 확인해 주세요.",
    ],
    [
      "서버 오류",
      () => ({ status: 500 }),
      "지금은 확인할 수 없어요. 잠시 후 다시 시도해 주세요.",
    ],
  ])("%s면 리뷰를 열지 않고 안내를 보여 준다", async (_, response, message) => {
    const { root, data, server, input, errText } = await openCodeInput({
      "/api/study-end-code/validate": response,
    });
    input.value = " CODE-1 ";
    click(root, "#vl-study-end-code-btn");
    await vi.waitFor(() => expect(errText().textContent).toBe(message));
    expect(hasFeedbackTabs(root)).toBe(false);
    expect(data.studyEndCodeVerified).toBeUndefined();
    const req = server.calls.find(
      (c) => c.path === "/api/study-end-code/validate",
    );
    expect(req.body).toEqual({
      code: "CODE-1",
      anonymousId: "anon-1",
      participantToken: "tok-1",
    });
  });

  it("맞는 코드를 Enter로 내면 리뷰 탭이 열리고 인증과 열람을 기록한다", async () => {
    const { root, data, server, input } = await openCodeInput({
      "/api/study-end-code/validate": { data: { valid: true } },
    });
    input.value = "CODE-1";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() => expect(hasFeedbackTabs(root)).toBe(true));
    expect(data.studyEndCodeVerified).toBe(true);
    await vi.waitFor(() =>
      expect(
        server.calls.find(
          (c) => c.path === "/api/participants/study-end-review-event",
        )?.body,
      ).toEqual({
        anonymousId: "anon-1",
        participantToken: "tok-1",
        event: "review_viewed",
      }),
    );
  });

  // 실제 서버처럼 코드를 검증하기 전에는 빈 값, 검증한 뒤에는 리뷰·집계를 준다
  const YESTERDAY = () => kst(new Date(Date.now() - 86400000).toISOString());
  const viewingDay = (category) => ({
    date: YESTERDAY(),
    confirmedCount: 1,
    chartCount: 1,
    chartSeconds: 120,
    timeDistribution: { [category]: 1 },
    countDistribution: { [category]: 1 },
  });
  // failSummary: 검증 뒤 집계 요청이 실패한다
  // daysBeforeVerify: 검증 전에도 집계에 날짜 기록이 있다(재설치 전에 이미 검증한 경우)
  // holdSummaryBeforeVerify: 검증 전(팝업을 열 때)의 집계 응답을 붙잡아 두었다가 releaseEarlySummary로 늦게 보낸다
  function verifyingServer({
    holdSummary = false,
    failSummary = false,
    daysBeforeVerify = [],
    holdSummaryBeforeVerify = false,
  } = {}) {
    const state = { verified: false };
    let releaseSummary;
    const summaryHeld = new Promise((r) => (releaseSummary = r));
    let releaseEarlySummary;
    const earlySummaryHeld = new Promise((r) => (releaseEarlySummary = r));
    const summary = () =>
      state.verified && failSummary
        ? { status: 500 }
        : {
            body: {
              data: {
                days: state.verified ? [viewingDay("음악")] : daysBeforeVerify,
                periods: [],
              },
            },
          };
    const responses = {
      "/api/study-end-code/validate": () => {
        state.verified = true;
        return { body: { data: { valid: true } } };
      },
      "/api/today-reviews": () => ({
        body: {
          data: state.verified
            ? [{ reviewDate: YESTERDAY(), review: "연구 기간의 하루 리뷰" }]
            : [],
        },
      }),
      "/api/viewing-summary": () => {
        if (state.verified && holdSummary) return summaryHeld.then(summary);
        if (!state.verified && holdSummaryBeforeVerify) {
          // 응답 내용은 요청한 시점(검증 전)의 것이다
          const early = summary();
          return earlySummaryHeld.then(() => early);
        }
        return summary();
      },
    };
    return { responses, releaseSummary, releaseEarlySummary };
  }
  const REFETCHED = [
    "/api/today-reviews",
    "/api/period-reviews",
    "/api/viewing-summary",
  ];
  const countsOf = (server) => REFETCHED.map((path) => server.count(path));
  const submitCode = (input) => {
    input.value = "CODE-1";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  };
  // 같은 기기로 참여한 대조군은 연구 기간의 세션이 기기에 남아 있다. 어제 날짜를 띄운 채 코드를 검증한다
  async function verifyOnYesterday(responses) {
    const yesterdaySession = session("s-yesterday", {
      endTime: daysAgo(1),
      videos: [{ eventId: "e-1", videoId: "v-1", watchedAt: daysAgo(1) }],
    });
    const p = await bootReady(
      participant({
        group: "CON",
        installDate: STUDY_ENDED(),
        sessions: [yesterdaySession],
      }),
      { responses },
    );
    click(p.root, "#vl-study-end-cta");
    submitCode(p.root.querySelector("#vl-study-end-code-input"));
    await vi.waitFor(() => expect(hasFeedbackTabs(p.root)).toBe(true));
    click(p.root, "#vl-date-prev");
    return p;
  }

  it("검증에 성공하면 같은 팝업에서 리뷰 이력·기간 리뷰·시청 집계를 다시 받아, 지난 날짜의 리뷰가 바로 보인다", async () => {
    const { responses } = verifyingServer();
    const { root, server, input } = await openCodeInput(responses);
    const before = countsOf(server);
    submitCode(input);
    await vi.waitFor(() =>
      expect(countsOf(server)).toEqual([
        before[0] + 1,
        before[1] + 1,
        before[2] + 1,
      ]),
    );
    expect(hasFeedbackTabs(root)).toBe(true);
    click(root, "#vl-date-prev");
    await vi.waitFor(() =>
      expect(root.textContent).toContain("연구 기간의 하루 리뷰"),
    );
  });

  it("다시 받는 동안에는 시청 기록을 불러오고 있다고 보이고, 받은 뒤에는 그 날 기록을 보여 준다", async () => {
    const { responses, releaseSummary } = verifyingServer({
      holdSummary: true,
    });
    const { root } = await verifyOnYesterday(responses);
    expect(root.textContent).toContain("시청 기록을 불러오고 있어요.");
    releaseSummary();
    await vi.waitFor(() =>
      expect(root.textContent).not.toContain("시청 기록을 불러오고 있어요."),
    );
    expect(root.textContent).toContain("연구 기간의 하루 리뷰");
    expect(root.textContent).toContain("음악");
  });

  it("재설치로 기기에 세션이 없어도, 다시 받는 동안 지난 날짜를 기록 없음이 아니라 불러오는 중으로 보이고 받은 뒤 리뷰를 보여 준다", async () => {
    const { responses, releaseSummary } = verifyingServer({
      holdSummary: true,
    });
    const { root, input } = await openCodeInput(responses);
    submitCode(input);
    await vi.waitFor(() => expect(hasFeedbackTabs(root)).toBe(true));
    click(root, "#vl-date-prev");
    expect(root.textContent).toContain("시청 기록을 불러오고 있어요.");
    expect(root.textContent).not.toContain("이 날 시청 기록이 없어요");
    releaseSummary();
    await vi.waitFor(() =>
      expect(root.textContent).toContain("연구 기간의 하루 리뷰"),
    );
    expect(root.textContent).not.toContain("시청 기록을 불러오고 있어요.");
  });

  it("팝업을 열 때 보낸 집계 요청의 빈 응답이 검증 뒤에 늦게 와도, 다시 받은 집계를 화면과 저장본에서 덮어쓰지 않는다", async () => {
    const { responses, releaseEarlySummary } = verifyingServer({
      holdSummaryBeforeVerify: true,
    });
    const { root, data } = await verifyOnYesterday(responses);
    await vi.waitFor(() => expect(root.textContent).toContain("음악"));
    releaseEarlySummary();
    await settle();
    expect(root.textContent).toContain("음악");
    expect(root.textContent).not.toContain("시청 기록을 불러오");
    expect(data.viewingSummaryCache.data.days.map((d) => d.date)).toEqual([
      YESTERDAY(),
    ]);
  });

  it("다시 받은 집계가 실패하면 리뷰 탭은 열린 채 불러오지 못했다고 안내한다(빈 집계로 되돌리지 않는다)", async () => {
    const { responses } = verifyingServer({ failSummary: true });
    const { root } = await verifyOnYesterday(responses);
    await vi.waitFor(() =>
      expect(root.textContent).toContain(
        "시청 기록을 불러오지 못했어요. 잠시 후 다시 열어 주세요.",
      ),
    );
    expect(hasFeedbackTabs(root)).toBe(true);
    expect(root.textContent).toContain("연구 기간의 하루 리뷰");
  });

  it("검증 전에 받아 둔 집계에 기록이 있으면, 다시 받기가 실패해도 그 기록을 그대로 보여 준다", async () => {
    const { responses } = verifyingServer({
      failSummary: true,
      daysBeforeVerify: [viewingDay("게임")],
    });
    const { root } = await verifyOnYesterday(responses);
    await vi.waitFor(() => expect(root.textContent).toContain("게임"));
    expect(root.textContent).not.toContain("시청 기록을 불러오지 못했어요");
    expect(root.textContent).not.toContain("시청 기록을 불러오고 있어요");
  });

  it.each([
    ["틀린 코드", { data: { valid: false } }],
    ["서버 오류", () => ({ status: 500 })],
  ])("%s면 리뷰·집계를 다시 받지 않는다", async (_label, validate) => {
    const { root, server, input } = await openCodeInput({
      "/api/study-end-code/validate": validate,
    });
    const before = countsOf(server);
    submitCode(input);
    await vi.waitFor(() =>
      expect(root.querySelector("#vl-study-end-code-err").style.display).toBe(
        "block",
      ),
    );
    await settle();
    expect(countsOf(server)).toEqual(before);
  });
});

describe("연구 종료 안내 확인", () => {
  it("대조군이 확인하면 다시 띄우지 않게 저장하고, 안내를 본 것을 서버에 기록하고, 리뷰 열람 버튼을 보여 준다", async () => {
    const { root, data, server } = await bootReady(
      participant({
        group: "CON",
        installDate: STUDY_ENDED(),
        studyEndNoticeShown: false,
      }),
    );
    click(root, "#vl-study-end-notice-confirm");
    expect(data.studyEndNoticeShown).toBe(true);
    expect(root.querySelector("#vl-study-end-notice-confirm")).toBeNull();
    expect(root.querySelector("#vl-study-end-cta")).not.toBeNull();
    await vi.waitFor(() =>
      expect(
        server.calls.find(
          (c) => c.path === "/api/participants/study-end-review-event",
        )?.body.event,
      ).toBe("modal_shown"),
    );
  });

  it("실험군은 확인만 저장하고 서버에는 기록하지 않는다", async () => {
    const { root, data, server } = await bootReady(
      participant({
        group: "EXP",
        installDate: STUDY_ENDED(),
        studyEndNoticeShown: false,
      }),
    );
    click(root, "#vl-study-end-notice-confirm");
    expect(data.studyEndNoticeShown).toBe(true);
    await settle();
    expect(server.paths()).not.toContain(
      "/api/participants/study-end-review-event",
    );
  });
});

describe("팝업을 열 때", () => {
  // jsdom에는 scrollIntoView가 없어, 어느 요소로 스크롤했는지 기록하는 가짜를 둔다
  let scrolledIds;
  beforeEach(() => {
    scrolledIds = [];
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value() {
        scrolledIds.push(this.id);
      },
    });
  });
  afterEach(() => {
    delete Element.prototype.scrollIntoView;
  });

  const withTodayReview = (over) =>
    bootReady(
      participant({
        group: "EXP",
        installDate: IN_PROGRESS(),
        sessions: [
          session("y1", { endTime: daysAgo(1), review: "어제 리뷰" }),
          session("s1", { review: "오늘 리뷰 문장" }),
        ],
        ...over,
      }),
      {
        responses: {
          "/api/today-reviews": {
            data: [
              {
                reviewDate: kst(daysAgo(1)),
                review: "어제 리뷰",
                sessionCount: 1,
              },
              todayReview("오늘 리뷰 문장"),
            ],
          },
        },
      },
    );

  it("어제 리뷰가 있어도 지난 날짜 슬라이드를 띄우지 않는다", async () => {
    const { root } = await withTodayReview();
    expect(root.querySelector("#vl-reveal-review-card")).toBeNull();
    expect(root.textContent).not.toContain("확인했어요");
    expect(root.textContent).not.toContain("어제 리뷰");
  });

  it("확인하지 않은 오늘 리뷰가 있으면 열자마자 그 리뷰 카드로 스크롤한다", async () => {
    const { root, runFrames } = await withTodayReview();
    expect(root.querySelector("#vl-feedback-confirm-btn")).not.toBeNull();
    runFrames();
    expect(scrolledIds).toEqual(["vl-review-card"]);
  });

  it("이미 확인한 오늘 리뷰면 스크롤하지 않는다", async () => {
    const { runFrames } = await withTodayReview({
      confirmedFeedbackSessionIds: ["s1"],
    });
    runFrames();
    expect(scrolledIds).toEqual([]);
  });
});

describe("팝업이 열린 채 저장소가 바뀔 때", () => {
  it("오늘 리뷰가 도착하면 그 리뷰를 가린 채 보여 준다. 다른 참여자의 저장본은 무시한다", async () => {
    const { root, emitChange } = await bootReady(
      participant({
        group: "EXP",
        installDate: IN_PROGRESS(),
        sessions: [session("s1", { review: "새 리뷰" })],
      }),
    );
    const cache = (anonymousId) => ({
      todayReviewsCache: {
        newValue: { anonymousId, reviews: [todayReview("새 리뷰")] },
      },
    });

    await emitChange(cache("someone-else"));
    expect(root.textContent).not.toContain("새 리뷰");

    await emitChange(cache("anon-1"));
    expect(root.textContent).toContain("새 리뷰");
    expect(root.querySelector("#vl-feedback-confirm-btn")).not.toBeNull();
  });

  it("오늘 첫 세션이 끝나면 오늘 리뷰 대상이 되어 '분석 중'을 보여 주고 집계를 다시 받는다", async () => {
    const { root, server, emitChange } = await bootReady(
      participant({ group: "EXP", installDate: IN_PROGRESS(), sessions: [] }),
    );
    await vi.waitFor(() =>
      expect(server.count("/api/viewing-summary")).toBe(1),
    );
    const ANALYZING = "오늘 하루 전체 시청을 분석하고 있어요";
    expect(root.textContent).not.toContain(ANALYZING);

    // 다른 저장 영역의 변경은 무시한다
    const changes = {
      sessions: { newValue: [session("s1", { syncedToServer: false })] },
    };
    await emitChange(changes, "sync");
    expect(root.textContent).not.toContain(ANALYZING);

    await emitChange(changes);
    expect(root.textContent).toContain(ANALYZING);
    await vi.waitFor(() =>
      expect(server.count("/api/viewing-summary")).toBe(2),
    );
  });
});
