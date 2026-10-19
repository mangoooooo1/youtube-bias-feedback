import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { isConGroup as isConGroupShared } from "../../pipeline/study-period.js";
import { isBaselinePeriod as isBaselinePeriodShared } from "../../pipeline/baseline.js";
import { loadPopup } from "./load-popup.js";

async function loadVL() {
  return (await loadPopup()).VL;
}

afterAll(() => {
  vi.unstubAllGlobals();
});

// viewlens-data.js는 모듈 경계(classic script) 때문에 pipeline/baseline.js의
// isBaselinePeriod를 그대로 import하지 못하고 동일 로직을 다시 정의한다 — 두 사본이
// 갈라져도 아무 테스트도 실패하지 않던 사각지대라, 소스를 실행해 직접 대조한다.
describe("VL.isBaselinePeriod — pipeline/baseline.js와 동치성", () => {
  let VL;

  beforeAll(async () => {
    VL = await loadVL();
  });

  it("경과일이 BASELINE_DAYS 경계 전/당일/후에서 공유 구현과 동일한 결과를 낸다", () => {
    const install = new Date("2026-01-01T00:00:00Z");
    for (const elapsedDays of [
      0,
      VL.BASELINE_DAYS - 1,
      VL.BASELINE_DAYS,
      VL.BASELINE_DAYS + 7,
    ]) {
      const now = new Date(install.getTime() + elapsedDays * 86400000);
      expect(VL.isBaselinePeriod(install.toISOString(), now)).toBe(
        isBaselinePeriodShared(install.toISOString(), now),
      );
    }
  });

  it("installDate가 없으면 두 구현 모두 베이스라인으로 취급한다", () => {
    expect(VL.isBaselinePeriod(null)).toBe(isBaselinePeriodShared(null));
    expect(VL.isBaselinePeriod(undefined)).toBe(
      isBaselinePeriodShared(undefined),
    );
  });
});

// isConGroup도 isBaselinePeriod와 동일한 이유(모듈 경계)로 viewlens-data.js에
// 중복 정의되어 있다 — pipeline/study-period.js와 동치성을 대조한다.
describe("VL.isConGroup — pipeline/study-period.js와 동치성", () => {
  let VL;

  beforeAll(async () => {
    VL = await loadVL();
  });

  it.each(["CON", "TEST-CON", "EXP", "TEST-EXP", undefined, null, ""])(
    "%s에 대해 공유 구현과 동일한 결과를 낸다",
    (code) => {
      expect(VL.isConGroup(code)).toBe(isConGroupShared(code));
    },
  );
});

// 일수를 인자로 넘겨 실제 설정값과 무관하게 두 표기 분기를 고정 검증한다.
describe("VL.studyDurationLabel — 연구 기간 표기", () => {
  let VL;

  beforeAll(async () => {
    VL = await loadVL();
  });

  it("7의 배수가 아니면(파일럿 12일) 일 단위로 표기한다", () => {
    expect(VL.studyDurationLabel(12)).toBe("12일간");
  });

  it("7의 배수가 아니면(15일로 바꿔 테스트할 때) 일 단위로 표기한다", () => {
    expect(VL.studyDurationLabel(15)).toBe("15일간");
  });

  it("7의 배수(본 연구 42일)면 주 단위로 표기한다", () => {
    expect(VL.studyDurationLabel(42)).toBe("6주간");
  });

  it("인자 없이 부르면 현재 설정(TOTAL_DAYS)으로 표기한다", () => {
    expect(VL.studyDurationLabel()).toBe(VL.studyDurationLabel(VL.TOTAL_DAYS));
  });
});

// ── 서버 집계(/api/viewing-summary) → 화면 값 (Task 5) ─────────────────────────
describe("VL.serverDist — 유튜브 분야 15종 + 기타", () => {
  let VL;
  beforeAll(async () => {
    VL = await loadVL();
  });

  it("업로더가 고를 수 있는 15종은 서로 다른 고정 색, 그 밖의 이름은 기타 색", () => {
    const fifteen = [
      "영화 & 애니메이션",
      "자동차 & 차량",
      "음악",
      "애완동물 & 동물",
      "스포츠",
      "여행 & 이벤트",
      "게임",
      "인물 & 블로그",
      "코미디",
      "엔터테인먼트",
      "뉴스 & 정치",
      "노하우 & 스타일",
      "교육",
      "과학 & 기술",
      "비영리 & 사회운동",
    ];
    const colors = fifteen.map((name) => VL.CATS[name]?.color);
    expect(colors.every(Boolean)).toBe(true);
    expect(new Set(colors).size).toBe(15);
    expect(colors).not.toContain(VL.CATS.기타.color);
    // 색은 VL_CATS 한 곳에서만 정한다 — 15종 + 기타 외의 항목이 없다
    expect(Object.keys(VL.CATS).sort()).toEqual([...fifteen, "기타"].sort());

    const [other] = VL.serverDist({ 단편영화: 1 });
    expect(other.color).toBe(VL.CATS.기타.color);
  });

  it("서버 이름을 그대로 키·이름으로 쓰고 비중 큰 순으로 정렬한다", () => {
    expect(
      VL.serverDist({ 게임: 0.3, "인물 & 블로그": 0.7 }).map((d) => [
        d.key,
        d.name,
        d.p,
      ]),
    ).toEqual([
      ["인물 & 블로그", "인물 & 블로그", 0.7],
      ["게임", "게임", 0.3],
    ]);
    expect(VL.serverDist(undefined)).toEqual([]);
  });
});

describe("VL.titleSentence — 탭 맨 위 제목 문장", () => {
  let VL;
  beforeAll(async () => {
    VL = await loadVL();
  });
  const sentence = (time, count) =>
    VL.titleSentence(VL.serverDist(time), VL.serverDist(count));

  it("시간 1위와 개수 1위가 같으면 한 번에 말한다", () => {
    expect(sentence({ 음악: 0.6, 게임: 0.4 }, { 음악: 0.5, 게임: 0.3 })).toBe(
      "시청 시간과 영상 개수 모두 음악 분야가 가장 많았어요.",
    );
  });

  it("갈리면 둘 다 말하고, 받침에 맞춰 조사를 붙인다", () => {
    expect(sentence({ 음악: 0.6, 게임: 0.4 }, { 게임: 0.7, 음악: 0.3 })).toBe(
      "시청 시간이 가장 긴 분야는 음악이었지만, 영상을 가장 많이 본 분야는 게임이었어요.",
    );
    expect(
      sentence({ 스포츠: 0.6, 게임: 0.4 }, { 코미디: 0.7, 스포츠: 0.3 }),
    ).toBe(
      "시청 시간이 가장 긴 분야는 스포츠였지만, 영상을 가장 많이 본 분야는 코미디였어요.",
    );
  });

  it("1위가 동점이면 함께 말한다(반올림한 퍼센트 기준)", () => {
    expect(
      sentence({ 음악: 0.4, 게임: 0.4, 교육: 0.2 }, { 교육: 0.6, 음악: 0.4 }),
    ).toBe(
      "시청 시간이 가장 긴 분야는 게임·음악이었지만, 영상을 가장 많이 본 분야는 교육이었어요.",
    );
    expect(sentence({ 음악: 0.5, 게임: 0.5 }, { 게임: 0.5, 음악: 0.5 })).toBe(
      "시청 시간과 영상 개수 모두 게임·음악 분야가 가장 많았어요.",
    );
  });

  it("분포가 비어 있으면 문장을 만들지 않는다", () => {
    expect(sentence({}, {})).toBeNull();
  });
});

describe("VL.dayView — 하루치 화면 값", () => {
  let VL;
  beforeAll(async () => {
    VL = await loadVL();
  });

  it("영상 수(확인됨)·확인 중·잠깐 본 영상 수와 영상별 제외 사유를 정리한다", () => {
    const view = VL.dayView({
      date: "2026-03-05",
      confirmedCount: 3,
      unconfirmedCount: 1,
      shortCount: 2,
      chartCount: 2,
      timeDistribution: { 음악: 0.7, 게임: 0.3 },
      countDistribution: { 음악: 0.5, 게임: 0.5 },
      excluded: [
        { eventId: "e1", reason: "short" },
        { eventId: "e2", reason: "pending_time" },
      ],
    });

    expect(view).toMatchObject({
      confirmedCount: 3,
      unconfirmedCount: 1,
      shortCount: 2,
      chartCount: 2,
      excludedReasons: { e1: "short", e2: "pending_time" },
    });
    expect(view.timeDist.map((d) => d.key)).toEqual(["음악", "게임"]);
    expect(view.title).toBe(
      "시청 시간이 가장 긴 분야는 음악이었지만, 영상을 가장 많이 본 분야는 게임·음악이었어요.",
    );
  });

  it("기록이 없는 날은 0과 빈 값으로 채운다", () => {
    expect(VL.dayView(undefined)).toMatchObject({
      confirmedCount: 0,
      unconfirmedCount: 0,
      timeDist: [],
      title: null,
      excludedReasons: {},
    });
  });
});

describe("VL.periodLines — 기간 탭 꺾은선", () => {
  let VL;
  beforeAll(async () => {
    VL = await loadVL();
  });
  const period = {
    start: "2026-03-05",
    end: "2026-03-08",
    timeDistribution: {
      음악: 0.4,
      게임: 0.3,
      교육: 0.2,
      스포츠: 0.06,
      코미디: 0.04,
    },
  };

  it("선은 구간 시청 시간 상위 3개 분야와 '그 밖'", () => {
    const { lines } = VL.periodLines(period, [], "2026-03-08");
    expect(lines.map((l) => l.name)).toEqual(["음악", "게임", "교육", "그 밖"]);
  });

  it("분야가 3개 이하면 '그 밖' 선을 두지 않는다", () => {
    const { lines } = VL.periodLines(
      { ...period, timeDistribution: { 음악: 0.6, 게임: 0.4 } },
      [],
      "2026-03-08",
    );
    expect(lines.map((l) => l.name)).toEqual(["음악", "게임"]);
  });

  it("날마다 각 선의 %(그 밖은 나머지 합), 기록 없는 날은 모든 선 0%와 표시", () => {
    const { points } = VL.periodLines(
      period,
      [
        {
          date: "2026-03-05",
          confirmedCount: 5,
          timeDistribution: { 음악: 0.5, 코미디: 0.3, 스포츠: 0.2 },
        },
      ],
      "2026-03-08",
    );

    expect(points.map((p) => p.date)).toEqual([
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
    ]);
    expect(points[0].values).toEqual({
      음악: 50,
      게임: 0,
      교육: 0,
      __others: 50,
    });
    expect(points[0].noRecord).toBe(false);
    expect(points[1]).toMatchObject({
      noRecord: true,
      values: { 음악: 0, 게임: 0, 교육: 0, __others: 0 },
    });
  });

  it("오늘은 표시하고 오늘 이후는 그리지 않는다", () => {
    const { points } = VL.periodLines(
      period,
      [
        {
          date: "2026-03-05",
          confirmedCount: 1,
          timeDistribution: { 음악: 1 },
        },
        {
          date: "2026-03-06",
          confirmedCount: 2,
          timeDistribution: { 음악: 1 },
        },
      ],
      "2026-03-06",
    );

    expect(points.map((p) => [p.date, p.isToday])).toEqual([
      ["2026-03-05", false],
      ["2026-03-06", true],
    ]);
  });
});

describe("VL.formatDuration·VL.donutPair — 오늘 탭 도넛 툴팁", () => {
  let VL;
  beforeAll(async () => {
    VL = await loadVL();
  });

  it("초를 시간·분으로 바꾼다", () => {
    expect(VL.formatDuration(20)).toBe("1분 미만");
    expect(VL.formatDuration(45 * 60)).toBe("45분");
    expect(VL.formatDuration(2 * 3600)).toBe("2시간");
    expect(VL.formatDuration(5400)).toBe("1시간 30분");
  });

  it("조각마다 퍼센트와 시간(합계 × 비중)·개수를 툴팁으로 단다", () => {
    const { time, count } = VL.donutPair(
      VL.dayView({
        chartCount: 12,
        chartSeconds: 5400,
        timeDistribution: { 음악: 0.6, 스포츠: 0.4 },
        countDistribution: { 스포츠: 0.75, 음악: 0.25 },
      }),
    );
    expect(time.map((d) => d.tip)).toEqual([
      "음악 60% · 54분",
      "스포츠 40% · 36분",
    ]);
    expect(count.map((d) => d.tip)).toEqual([
      "스포츠 75% · 9개",
      "음악 25% · 3개",
    ]);
  });

  it("영상 수(확인됨)와 도넛 개수의 차이를 분야 미확인 수로 준다", () => {
    expect(
      VL.dayView({ confirmedCount: 13, chartCount: 12 })
        .uncategorizedConfirmedCount,
    ).toBe(1);
    expect(VL.dayView(undefined).uncategorizedConfirmedCount).toBe(0);
  });
});

describe("VL.playedVideos — 그날 재생한 영상 목록", () => {
  let VL;
  beforeAll(async () => {
    VL = await loadVL();
  });
  const v = (eventId, watchedAt, extra = {}) => ({
    eventId,
    videoId: `vid-${eventId}`,
    title: `영상 ${eventId}`,
    watchedAt,
    watchedSeconds: 300,
    ...extra,
  });

  it("끝난 세션과 진행 중인 세션의 영상을 모아 본 시각 순으로, 그날(KST) 것만", () => {
    const sessions = [
      {
        videos: [
          v("e2", "2026-03-05T11:00:00+09:00"),
          v("old", "2026-03-04T23:00:00+09:00"),
        ],
      },
    ];
    const live = [
      v("e3", "2026-03-05T12:00:00+09:00"),
      v("e1", "2026-03-05T00:10:00+09:00"),
    ];

    expect(
      VL.playedVideos(sessions, live, "2026-03-05").map((x) => x.eventId),
    ).toEqual(["e1", "e2", "e3"]);
  });

  it("세션 종료 직전·직후 두 곳에 같이 있는 영상은 한 번만", () => {
    const same = v("e1", "2026-03-05T10:00:00+09:00");
    expect(
      VL.playedVideos([{ videos: [same] }], [same], "2026-03-05"),
    ).toHaveLength(1);
  });

  it("서버 사유로 거의 안 봄·분야 미확인·확인 중, 기기에 시청 시간이 없으면 확인 중을 붙인다", () => {
    const list = VL.playedVideos(
      [],
      [
        v("short", "2026-03-05T10:00:00+09:00"),
        v("uncat", "2026-03-05T10:01:00+09:00"),
        v("pending", "2026-03-05T10:02:00+09:00"),
        v("local-null", "2026-03-05T10:03:00+09:00", { watchedSeconds: null }),
        v("ok", "2026-03-05T10:04:00+09:00"),
      ],
      "2026-03-05",
      { short: "short", uncat: "uncategorized", pending: "pending_time" },
    );

    expect(list.map((x) => [x.eventId, x.mark])).toEqual([
      ["short", "거의 안 봄"],
      ["uncat", "분야 미확인"],
      ["pending", "확인 중"],
      ["local-null", "확인 중"],
      ["ok", null],
    ]);
  });
});

describe("VL.reviewAsOfLabel — 리뷰 카드의 기준 시각", () => {
  let VL;
  beforeAll(async () => {
    VL = await loadVL();
  });

  it("리뷰를 만든 시각을 KST 시:분으로, 만든 날이 리뷰 날짜와 다르면 날짜도 붙인다", () => {
    expect(VL.reviewAsOfLabel("2026-10-16T05:32:00Z", "2026-10-16")).toBe(
      "14:32 기준",
    );
    expect(VL.reviewAsOfLabel("2026-10-15T15:31:00Z", "2026-10-15")).toBe(
      "10/16 00:31 기준",
    );
  });

  it("값이 없으면 빈 문자열", () => {
    expect(VL.reviewAsOfLabel(null, "2026-10-16")).toBe("");
  });
});
