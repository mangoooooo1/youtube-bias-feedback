import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import { createRequire } from "node:module";
import "../../study-schedule.js";
import { loadPopup } from "./load-popup.js";

const { BASELINE_DAYS } = globalThis.ViewLensStudy;

// 대조군에게 실수로 피드백 화면(screenToday/screenFeedback)이 노출되는지를 가르는 실제 결정 로직을
// 실제 팝업 파일을 불러와 검증한다. _isFeedbackActive는 ViewLensPopup의 메서드라 prototype에서 꺼내
// this._installDate를 .call()로 넣는다. TOTAL_DAYS는 실제 설정(VL.TOTAL_DAYS)을 쓴다.
async function loadStudyGates() {
  const g = await loadPopup();
  return {
    _isStudyEndTimeReached: g._isStudyEndTimeReached,
    _isStudyEndReviewReady: g._isStudyEndReviewReady,
    _isFeedbackActive: g.ViewLensPopup.prototype._isFeedbackActive,
    TOTAL_DAYS: g.VL.TOTAL_DAYS,
  };
}

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("_isFeedbackActive — 실험군(EXP)에게만, 베이스라인 이후에만 피드백을 켠다", () => {
  let gates;
  beforeAll(async () => {
    gates = await loadStudyGates();
  });

  function isFeedbackActive(groupCfg, installDate) {
    return gates._isFeedbackActive.call(
      { _installDate: installDate },
      groupCfg,
    );
  }

  it("EXP + 베이스라인 기간(설치 직후)이면 꺼져 있다", () => {
    const installDate = new Date().toISOString();
    expect(isFeedbackActive({ feedback: true, code: "EXP" }, installDate)).toBe(
      false,
    );
  });

  it(`EXP + 베이스라인(${BASELINE_DAYS}일) 이후면 켜진다`, () => {
    const installDate = new Date(
      Date.now() - (BASELINE_DAYS + 1) * 86400000,
    ).toISOString();
    expect(isFeedbackActive({ feedback: true, code: "EXP" }, installDate)).toBe(
      true,
    );
  });

  it("CON(feedback:false)은 베이스라인 이후여도 항상 꺼져 있다", () => {
    const installDate = new Date(
      Date.now() - (BASELINE_DAYS + 10) * 86400000,
    ).toISOString();
    expect(
      isFeedbackActive({ feedback: false, code: "CON" }, installDate),
    ).toBe(false);
  });

  it("TEST-EXP(연구자 모드)는 베이스라인 기간에도 켜진다", () => {
    const installDate = new Date().toISOString();
    expect(
      isFeedbackActive({ feedback: true, code: "TEST-EXP" }, installDate),
    ).toBe(true);
  });

  it("TEST-CON(연구자 모드)은 feedback:false라 베이스라인 예외와 무관하게 꺼져 있다", () => {
    const installDate = new Date().toISOString();
    expect(
      isFeedbackActive({ feedback: false, code: "TEST-CON" }, installDate),
    ).toBe(false);
  });
});

describe("_isStudyEndReviewReady — 대조군(CON)에게만, 연구 종료 후에만 열람을 켠다", () => {
  let TOTAL_DAYS;
  let gates;
  beforeAll(async () => {
    gates = await loadStudyGates();
    ({ TOTAL_DAYS } = gates);
  });

  it("EXP는 연구가 종료되어도 이 경로로는 절대 켜지지 않는다(isConGroup이 false)", () => {
    const installDate = new Date(
      Date.now() - (TOTAL_DAYS + 5) * 86400000,
    ).toISOString();
    expect(gates._isStudyEndReviewReady({ code: "EXP" }, installDate)).toBe(
      false,
    );
  });

  it("CON은 연구 종료 전에는 꺼져 있다", () => {
    const installDate = new Date().toISOString();
    expect(gates._isStudyEndReviewReady({ code: "CON" }, installDate)).toBe(
      false,
    );
  });

  it("CON은 연구 종료(TOTAL_DAYS 경과 + 09:00 KST) 후에 켜진다", () => {
    const installDate = new Date(
      Date.now() - (TOTAL_DAYS + 5) * 86400000,
    ).toISOString();
    expect(gates._isStudyEndReviewReady({ code: "CON" }, installDate)).toBe(
      true,
    );
  });

  it("TEST-CON도 CON과 동일하게 동작한다", () => {
    const installDate = new Date(
      Date.now() - (TOTAL_DAYS + 5) * 86400000,
    ).toISOString();
    expect(
      gates._isStudyEndReviewReady({ code: "TEST-CON" }, installDate),
    ).toBe(true);
  });

  it("경계값: 종료일 09:00 KST 정각 이전에는 꺼져 있다가, 그 직후 켜진다", () => {
    // installDate를 KST 자정으로 고정 — TOTAL_DAYS일 뒤 09:00 KST가 정확히 판정 경계다.
    const installDate = new Date("2026-01-01T00:00:00+09:00");
    const cutoff = new Date(
      installDate.getTime() + TOTAL_DAYS * 86400000 + 9 * 3600000,
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date(cutoff.getTime() - 1000));
    expect(
      gates._isStudyEndReviewReady({ code: "CON" }, installDate.toISOString()),
    ).toBe(false);

    vi.setSystemTime(cutoff);
    expect(
      gates._isStudyEndReviewReady({ code: "CON" }, installDate.toISOString()),
    ).toBe(true);
  });
});

describe("참여 종료 배너와 팝업 등록 재시도", () => {
  const DAY = 86400000;
  const NOW = Date.parse("2026-01-20T03:00:00Z");
  const ACTIVE = new Date(NOW - 5 * DAY).toISOString();
  const GRACE = new Date(NOW - 13 * DAY).toISOString();
  const ENDED = new Date(NOW - 20 * DAY).toISOString();

  let gates;
  beforeAll(async () => {
    const g = await loadPopup();
    gates = {
      _isParticipationEnded: g._isParticipationEnded,
      screenParticipationEndedBanner: g.screenParticipationEndedBanner,
      shouldRetryParticipantSync: g.shouldRetryParticipantSync,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["active", ACTIVE, false],
    ["grace", GRACE, false],
    ["ended", ENDED, true],
  ])("%s면 배너 표시 여부는 %s이다", (_label, installDate, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(gates._isParticipationEnded(installDate)).toBe(expected);
  });

  it("배너는 종료·설문 대기를 안내하고 삭제·제거는 안내하지 않는다", () => {
    const html = gates.screenParticipationEndedBanner();
    expect(html).toContain("연구 참여 기간이 종료되었습니다.");
    expect(html).toContain("설문 안내를 기다려 주세요");
    expect(html).not.toMatch(/삭제|제거/);
  });

  it("ended면 팝업 boot에서 등록을 다시 시도하지 않는다(옛 참여코드 재등록 방지)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const unsynced = {
      group: "CON",
      anonymousId: "a1",
      participantSynced: false,
    };
    expect(
      gates.shouldRetryParticipantSync({ ...unsynced, installDate: GRACE }),
    ).toBe(true);
    expect(
      gates.shouldRetryParticipantSync({ ...unsynced, installDate: ENDED }),
    ).toBe(false);
    expect(
      gates.shouldRetryParticipantSync({
        ...unsynced,
        installDate: ACTIVE,
        participantSynced: true,
      }),
    ).toBe(false);
  });
});

describe("연구 종료 시점 — 팝업(_isStudyEndTimeReached)과 서버(isStudyEnded)가 같다", () => {
  // 팝업이 대조군 코드 입력 화면을 여는 순간 서버도 코드를 받아줘야 한다.
  // 어긋나면 맞는 코드를 넣은 대조군이 "코드가 올바르지 않아요"를 보게 된다.
  const require = createRequire(import.meta.url);
  const { TOTAL_DAYS } = require("../../../server/pipeline/study-constants.js");
  const {
    isStudyEnded,
  } = require("../../../server/routes/period-reviews-query.js");
  const DAY = 86400000;
  const HOUR = 3600000;

  it.each([
    ["오전 설치(07:00 KST)", "2026-06-01T07:00:00+09:00"],
    ["오후 설치(15:00 KST)", "2026-06-01T15:00:00+09:00"],
    ["자정 직전 설치(23:59 KST)", "2026-06-01T23:59:00+09:00"],
    ["자정 직후 설치(00:01 KST)", "2026-06-02T00:01:00+09:00"],
  ])("%s: 종료 전후 여러 시각에서 판정이 같다", async (_label, installDate) => {
    const gates = await loadStudyGates();
    const base = Date.parse(installDate) + TOTAL_DAYS * DAY;
    for (const offset of [
      -24 * HOUR,
      -12 * HOUR,
      -1,
      0,
      1,
      6 * HOUR,
      24 * HOUR,
    ]) {
      // 팝업 경계(다음 날 09:00 KST)를 정확히 지나도록 설치 시각 기준 ±하루를 촘촘히 훑는다
      for (const hour of [0, 8, 9, 10, 15]) {
        const now = new Date(base + offset + hour * HOUR);
        vi.useFakeTimers();
        vi.setSystemTime(now);
        expect(gates._isStudyEndTimeReached(installDate)).toBe(
          isStudyEnded(installDate, now),
        );
      }
    }
    // 정확한 경계(09:00 KST)에서도 같다
    const boundary = Date.parse(
      `${new Date(base).toLocaleDateString("sv", { timeZone: "Asia/Seoul" })}T09:00:00+09:00`,
    );
    for (const now of [new Date(boundary - 1), new Date(boundary)]) {
      vi.useFakeTimers();
      vi.setSystemTime(now);
      expect(gates._isStudyEndTimeReached(installDate)).toBe(
        isStudyEnded(installDate, now),
      );
    }
  });
});

// 오늘 탭 그래프의 데이터와 불러오기 상태
describe("_dayViewForDate — 서버 집계 불러오기 상태", () => {
  // _dayViewForDate는 호출 시점에 전역 VL을 찾으므로, 그 자리에 테스트용 VL을 넣는다
  let dayViewForDate;
  beforeAll(async () => {
    dayViewForDate = (await loadPopup())._dayViewForDate;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  function load(VL) {
    vi.stubGlobal("VL", VL);
    return dayViewForDate;
  }
  const fakeVL = (summary, status) => ({
    _viewingSummary: summary,
    _viewingSummaryStatus: status,
    dayView: (day) => ({ day }),
  });
  const summary = {
    data: { days: [{ date: "2026-03-05", confirmedCount: 2 }], periods: [] },
  };

  it("선택한 날짜의 서버 값을 찾아 넘긴다", () => {
    const view = load(fakeVL(summary, "ok"))("2026-03-05");
    expect(view).toMatchObject({ day: { confirmedCount: 2 }, status: "ok" });
    expect(load(fakeVL(summary, "ok"))("2026-03-06").day).toBeUndefined();
  });

  it.each([
    [summary, "loading", "ok"],
    [summary, "failed", "ok"],
    [null, "loading", "loading"],
    [null, "failed", "failed"],
  ])("저장본 %#: 불러오기 %s → 화면 상태 %s", (s, loadStatus, expected) => {
    expect(load(fakeVL(s, loadStatus))("2026-03-05").status).toBe(expected);
  });
});

// 서버 오늘 집계는 영상을 본 시각(KST)으로 센다. 세션 종료 시각(마지막 영상 + 10분)으로 세면
// 23:55에 본 영상이 다음 날로 넘어간다.
describe("_controlTodayCount — 대조군 홈 오늘 시청한 영상 수", () => {
  const kst = (time) => new Date(`${time}+09:00`).toISOString();
  const video = (eventId, time) => ({ eventId, watchedAt: kst(time) });
  let g;
  beforeAll(async () => {
    g = await loadPopup();
  });
  function count({ sessions = [], live = [] }) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(kst("2026-03-06T00:30:00")));
    g.VL._allSessions = sessions;
    g.VL._liveVideos = live;
    return g._controlTodayCount();
  }

  it("자정 직전에 본 영상만 있는 세션은 다음 날 수에 넣지 않는다", () => {
    const lateNight = {
      sessionId: "late",
      endTime: kst("2026-03-06T00:05:00"),
      videoCount: 1,
      videos: [video("e1", "2026-03-05T23:55:00")],
    };
    expect(count({ sessions: [lateNight] })).toBe(0);
  });

  it("자정을 걸친 세션은 오늘 본 영상만 센다", () => {
    const across = {
      sessionId: "across",
      endTime: kst("2026-03-06T00:12:00"),
      videoCount: 2,
      videos: [
        video("e1", "2026-03-05T23:50:00"),
        video("e2", "2026-03-06T00:02:00"),
      ],
    };
    expect(count({ sessions: [across] })).toBe(1);
  });

  it("자정을 넘겨 열려 있는 세션은 오늘 본 영상만 센다", () => {
    const live = [
      video("e1", "2026-03-05T23:58:00"),
      video("e2", "2026-03-06T00:03:00"),
    ];
    expect(count({ live })).toBe(1);
  });

  it("자정과 무관한 끝난 세션과 진행 중 세션은 모두 센다", () => {
    const morning = {
      sessionId: "s1",
      endTime: kst("2026-03-06T00:25:00"),
      videoCount: 2,
      videos: [
        video("e1", "2026-03-06T00:10:00"),
        video("e2", "2026-03-06T00:15:00"),
      ],
    };
    // 세션 종료 직후 같은 영상 기록이 두 곳에 잠깐 함께 있어도 한 번만 센다
    const live = [
      video("e2", "2026-03-06T00:15:00"),
      video("e3", "2026-03-06T00:28:00"),
    ];
    expect(count({ sessions: [morning], live })).toBe(3);
  });

  it("영상 기록이 없는 세션은 종료 시각의 날짜로 videoCount를 센다", () => {
    const sessions = [
      { sessionId: "s1", endTime: kst("2026-03-06T00:20:00"), videoCount: 2 },
      { sessionId: "s0", endTime: kst("2026-03-05T22:00:00"), videoCount: 5 },
    ];
    expect(count({ sessions })).toBe(2);
  });
});
