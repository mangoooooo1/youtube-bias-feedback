// @vitest-environment jsdom
/* global Element */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { loadPopup } from "./load-popup.js";
import {
  DAY,
  bootPopup,
  cleanupPopup,
  daysAgo,
  hasFeedbackTabs,
  participant,
  session,
} from "./boot-popup.js";

// 팝업 안에서 화면을 옮겨 다니는 조작(날짜·기간·범례·영상 목록 넘기기·홈으로)을 실제 팝업(boot)으로 확인한다.
let BASELINE_DAYS, TOTAL_DAYS, DAYS_PER_PERIOD;

beforeAll(async () => {
  const g = await loadPopup();
  ({ BASELINE_DAYS, TOTAL_DAYS, DAYS_PER_PERIOD } = g.VL);
  vi.unstubAllGlobals();
});

afterEach(cleanupPopup);

const kst = (iso) =>
  new Date(iso).toLocaleDateString("sv", { timeZone: "Asia/Seoul" });
const click = (root, selector) => root.querySelector(selector).click();

async function bootReady(stored, opts) {
  const p = await bootPopup(stored, opts);
  await vi.waitFor(() => expect(p.data.livePopupEvent).toBeTruthy());
  return p;
}

describe("날짜 이동", () => {
  it("어제로 갔다가 오늘로 돌아올 수 있고, 오늘에서는 다음 날짜로 갈 수 없다", async () => {
    const { root } = await bootReady(
      participant({ group: "EXP", installDate: daysAgo(BASELINE_DAYS + 1) }),
    );
    const { koreanDateLabel } = globalThis;
    const nextBtn = () => root.querySelector("#vl-date-next");
    expect(nextBtn().disabled).toBe(true);
    expect(root.textContent).toContain("오늘");

    click(root, "#vl-date-prev");
    expect(root.textContent).toContain(koreanDateLabel(new Date(daysAgo(1))));
    expect(nextBtn().disabled).toBe(false);

    click(root, "#vl-date-next");
    expect(nextBtn().disabled).toBe(true);
    expect(root.textContent).not.toContain(
      koreanDateLabel(new Date(daysAgo(1))),
    );
  });

  it("설치일보다 앞으로는 가지 않는다", async () => {
    const { root } = await bootReady(
      participant({
        group: "TEST-EXP",
        participantCode: "TEST-EXP",
        installDate: new Date().toISOString(),
      }),
    );
    const { koreanDateLabel } = globalThis;
    click(root, "#vl-date-prev");
    expect(root.textContent).not.toContain(
      koreanDateLabel(new Date(daysAgo(1))),
    );
    expect(root.querySelector("#vl-date-next").disabled).toBe(true);
  });
});

// 베이스라인 동안 만든 리뷰와 자정 크론이 마무리한 전날 리뷰는 세션 응답으로 오지 않아
// 로컬 세션에 없다. 팝업은 열 때마다 서버 이력을 받아 지난 날짜에 보여 줘야 한다.
describe("지난 날짜 리뷰 — 서버 이력", () => {
  const YESTERDAY = () => kst(daysAgo(1));
  const yesterdayReview = (review) => ({
    reviewDate: YESTERDAY(),
    review,
    sessionCount: 1,
  });
  // 어제 로컬 세션은 있지만 리뷰가 없다(베이스라인 날짜). 지난 날짜 슬라이드는 이미 본 것으로 둔다
  const stored = (over) =>
    participant({
      group: "EXP",
      installDate: daysAgo(BASELINE_DAYS + 1),
      sessions: [session("s0", { endTime: daysAgo(1) })],
      todayCumulativeRevealedDate: YESTERDAY(),
      ...over,
    });

  it("오늘 끝난 세션이 없어도 어제로 가면 서버에 저장된 리뷰가 보인다", async () => {
    const { root } = await bootReady(stored(), {
      responses: {
        "/api/today-reviews": { data: [yesterdayReview("어제 리뷰 문장")] },
      },
    });
    click(root, "#vl-date-prev");
    expect(root.textContent).toContain("어제 리뷰 문장");
  });

  it("같은 날 받은 캐시가 있어도 다시 받아 서버의 새 리뷰를 보이고 캐시를 바꾼다", async () => {
    const { root, data } = await bootReady(
      stored({
        sessions: [
          session("s0", { endTime: daysAgo(1) }),
          session("s1", { review: "오늘 리뷰 문장" }),
        ],
        todayReviewsCache: {
          anonymousId: "anon-1",
          reviews: [
            yesterdayReview("세션 때 본 리뷰"),
            {
              reviewDate: kst(new Date().toISOString()),
              review: "오늘 리뷰 문장",
              sessionCount: 1,
            },
          ],
        },
      }),
      {
        responses: {
          "/api/today-reviews": {
            data: [yesterdayReview("자정에 마무리한 리뷰")],
          },
        },
      },
    );
    click(root, "#vl-date-prev");
    expect(root.textContent).toContain("자정에 마무리한 리뷰");
    expect(root.textContent).not.toContain("세션 때 본 리뷰");
    expect(data.todayReviewsCache.reviews).toEqual([
      yesterdayReview("자정에 마무리한 리뷰"),
    ]);
  });

  it("서버 조회가 실패하면 같은 참여자의 캐시로 보인다", async () => {
    const { root } = await bootReady(
      stored({
        todayReviewsCache: {
          anonymousId: "anon-1",
          reviews: [yesterdayReview("캐시에 남은 리뷰")],
        },
      }),
      { responses: { "/api/today-reviews": () => ({ status: 500 }) } },
    );
    click(root, "#vl-date-prev");
    expect(root.textContent).toContain("캐시에 남은 리뷰");
  });

  it("서버 조회가 실패해도 다른 참여자의 캐시는 쓰지 않는다", async () => {
    const { root } = await bootReady(
      stored({
        todayReviewsCache: {
          anonymousId: "someone-else",
          reviews: [yesterdayReview("다른 사람 리뷰")],
        },
      }),
      { responses: { "/api/today-reviews": () => ({ status: 500 }) } },
    );
    click(root, "#vl-date-prev");
    expect(root.textContent).not.toContain("다른 사람 리뷰");
  });
});

describe("기간 탭", () => {
  // 1구간에 분야 4개 → 상위 3개 + "그 밖" 범례
  async function bootFeedbackTab() {
    const installDate = daysAgo(BASELINE_DAYS + 1);
    const lastDay = Date.parse(installDate) + (DAYS_PER_PERIOD - 1) * DAY;
    const period = {
      periodIndex: 1,
      start: kst(installDate),
      end: kst(lastDay),
      timeDistribution: { 뉴스: 0.4, 게임: 0.3, 음악: 0.2, 교육: 0.1 },
    };
    const p = await bootReady(participant({ group: "EXP", installDate }), {
      responses: {
        "/api/viewing-summary": { data: { days: [], periods: [period] } },
      },
    });
    click(p.root, '[data-tab="feedback"]');
    await vi.waitFor(() =>
      expect(p.root.querySelector("#vl-period-legend")).not.toBeNull(),
    );
    return p;
  }

  const pressed = (root) =>
    [...root.querySelectorAll("[data-legend-key]")]
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.dataset.legendKey);

  it("범례를 누르면 그 분야만 강조하고, 다시 누르면 강조를 푼다", async () => {
    const { root } = await bootFeedbackTab();
    expect(pressed(root)).toEqual([]);
    click(root, '[data-legend-key="뉴스"]');
    expect(pressed(root)).toEqual(["뉴스"]);
    click(root, '[data-legend-key="게임"]');
    expect(pressed(root)).toEqual(["게임"]);
    click(root, '[data-legend-key="게임"]');
    expect(pressed(root)).toEqual([]);
  });

  it("지난 기간 버튼을 누르면 그 기간을 보여 주고 강조를 푼다. 아직 안 온 기간은 누를 수 없다", async () => {
    const { root } = await bootFeedbackTab();
    const { VL } = globalThis;
    click(root, '[data-legend-key="뉴스"]');

    click(root, '#vl-week-btns [data-week="2"]');
    expect(root.textContent).toContain(VL.weeks[1].range);
    expect(root.querySelector("#vl-period-legend")).toBeNull();

    click(root, '#vl-week-btns [data-week="1"]');
    expect(pressed(root)).toEqual([]);

    const future = root.querySelector(
      `#vl-week-btns [data-week="${VL.TOTAL_WEEKS}"]`,
    );
    expect(future.disabled).toBe(true);
  });
});

describe("영상 목록 넘기기", () => {
  it("10개가 넘으면 페이지로 나누고, 화살표로 한 페이지씩 앞뒤로 넘긴다", async () => {
    const now = new Date().toISOString();
    const videos = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [
        `video__v${i}`,
        {
          eventId: `e${i}`,
          videoId: `vid${i}`,
          title: `영상 ${i}`,
          watchedAt: now,
          watchedSeconds: 60,
        },
      ]),
    );
    const scrollBy = vi.fn();
    Object.defineProperty(Element.prototype, "scrollBy", {
      value: scrollBy,
      configurable: true,
    });
    try {
      const { root } = await bootReady({
        ...participant({
          group: "EXP",
          installDate: daysAgo(BASELINE_DAYS + 1),
          sessions: [session("s1", { review: "리뷰" })],
        }),
        ...videos,
      });
      const pager = root.querySelector(".vl-vid-pager");
      expect(pager.querySelector(".vl-vid-page-label").textContent).toBe("1/2");
      const scroller = pager.querySelector(".vl-vid-scroll");
      Object.defineProperty(scroller, "clientWidth", { value: 300 });

      pager.querySelector(".vl-vid-next").click();
      pager.querySelector(".vl-vid-prev").click();
      expect(scrollBy.mock.calls).toEqual([
        [{ left: 300, behavior: "smooth" }],
        [{ left: -300, behavior: "smooth" }],
      ]);
    } finally {
      delete Element.prototype.scrollBy;
    }
  });
});

describe("대조군 종료 후 리뷰 화면", () => {
  it("홈으로 돌아가면 리뷰 탭을 닫고 다시 열람 버튼을 보여 준다", async () => {
    const { root } = await bootReady(
      participant({
        group: "CON",
        installDate: daysAgo(TOTAL_DAYS + 1),
        studyEndCodeVerified: true,
      }),
    );
    click(root, "#vl-study-end-cta");
    expect(hasFeedbackTabs(root)).toBe(true);

    click(root, "#vl-study-end-back");
    expect(hasFeedbackTabs(root)).toBe(false);
    expect(root.querySelector("#vl-study-end-cta")).not.toBeNull();
  });
});
