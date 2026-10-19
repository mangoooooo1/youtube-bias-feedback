// @vitest-environment jsdom
/* global KeyboardEvent */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
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

describe("어제 돌아보기", () => {
  it("어제 리뷰를 보여 주고, 닫으면 그 날짜를 저장해 다시 띄우지 않는다", async () => {
    const yesterday = daysAgo(1);
    const stored = participant({
      group: "EXP",
      installDate: IN_PROGRESS(),
      sessions: [session("y1", { endTime: yesterday, review: "어제 리뷰" })],
    });
    const { root, data } = await bootReady(stored);
    expect(root.querySelector("#vl-reveal-review-card").textContent).toContain(
      "어제 리뷰",
    );

    click(root, "#vl-reveal-dismiss");
    expect(root.querySelector("#vl-reveal-dismiss")).toBeNull();
    expect(data.todayCumulativeRevealedDate).toBe(kst(yesterday));

    cleanupPopup();
    const again = await bootReady({
      ...stored,
      todayCumulativeRevealedDate: kst(yesterday),
    });
    expect(again.root.querySelector("#vl-reveal-dismiss")).toBeNull();
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
