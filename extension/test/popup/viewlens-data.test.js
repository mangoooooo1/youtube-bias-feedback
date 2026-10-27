import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import { isConGroup as isConGroupShared } from "../../pipeline/study-period.js";
import { loadPopup } from "./load-popup.js";

async function loadVL() {
  return (await loadPopup()).VL;
}

afterAll(() => {
  vi.unstubAllGlobals();
});

// 팝업은 사본을 두지 않고 백그라운드와 같은 study-schedule.js 구현을 쓴다
describe("VL.isBaselinePeriod — study-schedule.js 구현을 그대로 쓴다", () => {
  it("VL의 판정 함수와 상수가 ViewLensStudy의 것과 같다", async () => {
    const g = await loadPopup();
    expect(g.VL.isBaselinePeriod).toBe(g.ViewLensStudy.isBaselinePeriod);
    expect(g.VL.BASELINE_DAYS).toBe(g.ViewLensStudy.BASELINE_DAYS);
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

describe("VL.titleSentence — 탭 맨 위 제목과 보조 줄", () => {
  let VL;
  beforeAll(async () => {
    VL = await loadVL();
  });
  // 조각을 글자로 합치고, 굵은 조각만 따로 모은다
  const lines = (time, count, chartCount) => {
    const t = VL.titleSentence(
      VL.serverDist(time),
      VL.serverDist(count),
      chartCount,
    );
    if (!t) return null;
    const text = (line) => line?.map((p) => p.text).join("") ?? null;
    const strong = (line) =>
      line?.filter((p) => p.strong).map((p) => p.text) ?? [];
    return {
      title: text(t.title),
      sub: text(t.sub),
      strong: [...strong(t.title), ...strong(t.sub)],
    };
  };

  it("시간과 개수에서 가장 많은 분야가 같으면 제목 한 줄만", () => {
    expect(
      lines({ 음악: 0.6, 게임: 0.4 }, { 음악: 0.6, 게임: 0.4 }, 10),
    ).toEqual({
      title: "음악 영상을 가장 많이 봤어요",
      sub: null,
      strong: ["음악"],
    });
  });

  it("다르면 제목은 시간, 보조 줄은 영상 수와 실제 개수", () => {
    expect(
      lines(
        { "인물 & 블로그": 0.6, 엔터테인먼트: 0.4 },
        { 엔터테인먼트: 0.6, "인물 & 블로그": 0.4 },
        5,
      ),
    ).toEqual({
      title: "인물 & 블로그에 시간을 가장 많이 썼어요",
      sub: "엔터테인먼트 영상을 가장 많이 봤어요 (3개)",
      strong: ["인물 & 블로그", "엔터테인먼트"],
    });
  });

  it("영상 수가 동점이면 함께 말하고 'N개씩', 시간 쪽 분야가 섞여 있어도 보조 줄을 붙인다", () => {
    expect(
      lines(
        { "인물 & 블로그": 0.7, 엔터테인먼트: 0.3 },
        { 엔터테인먼트: 0.5, "인물 & 블로그": 0.5 },
        2,
      ),
    ).toEqual({
      title: "인물 & 블로그에 시간을 가장 많이 썼어요",
      sub: "엔터테인먼트·인물 & 블로그 영상을 가장 많이 봤어요 (1개씩)",
      strong: ["인물 & 블로그", "엔터테인먼트·인물 & 블로그"],
    });
  });

  it("시간이 동점이면 반올림한 퍼센트 기준으로 함께 말한다", () => {
    expect(
      lines({ 음악: 0.4, 게임: 0.4, 교육: 0.2 }, { 교육: 0.6, 음악: 0.4 }, 5),
    ).toMatchObject({
      title: "게임·음악에 시간을 가장 많이 썼어요",
      sub: "교육 영상을 가장 많이 봤어요 (3개)",
    });
    expect(
      lines({ 음악: 0.5, 게임: 0.5 }, { 게임: 0.5, 음악: 0.5 }, 4),
    ).toMatchObject({ title: "게임·음악 영상을 가장 많이 봤어요", sub: null });
  });

  it("영상 수 1위는 반올림 퍼센트가 아니라 실제 개수로 정한다", () => {
    // 500개 중 102·100·98개 — 셋 다 반올림하면 20%
    expect(
      lines(
        { 음악: 0.6, 게임: 0.4 },
        { 게임: 0.204, 음악: 0.2, 교육: 0.196 },
        500,
      ),
    ).toMatchObject({ sub: "게임 영상을 가장 많이 봤어요 (102개)" });
  });

  it("개수를 모르면(chartCount 없음) 반올림 퍼센트로 정하고 개수는 쓰지 않는다", () => {
    expect(
      lines({ 음악: 0.6, 게임: 0.4 }, { 게임: 0.7, 음악: 0.3 }),
    ).toMatchObject({ sub: "게임 영상을 가장 많이 봤어요" });
  });

  it("분포가 비어 있으면 제목·보조 줄을 만들지 않는다", () => {
    expect(lines({}, {}, 0)).toBeNull();
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
      correctedTitles: { e3: "실제 제목" },
    });

    expect(view).toMatchObject({
      confirmedCount: 3,
      unconfirmedCount: 1,
      shortCount: 2,
      chartCount: 2,
      excludedReasons: { e1: "short", e2: "pending_time" },
      correctedTitles: { e3: "실제 제목" },
    });
    expect(view.timeDist.map((d) => d.key)).toEqual(["음악", "게임"]);
    // chartCount로 영상 수를 되살려 제목을 만든다
    const text = (line) => line.map((p) => p.text).join("");
    expect(text(view.title.title)).toBe("음악에 시간을 가장 많이 썼어요");
    expect(text(view.title.sub)).toBe(
      "게임·음악 영상을 가장 많이 봤어요 (1개씩)",
    );
  });

  it("기록이 없는 날은 0과 빈 값으로 채운다", () => {
    expect(VL.dayView(undefined)).toMatchObject({
      confirmedCount: 0,
      unconfirmedCount: 0,
      timeDist: [],
      title: null,
      excludedReasons: {},
      correctedTitles: {},
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

  it("오늘은 표시하고, 오늘 이후 날짜도 넣되 아직 오지 않은 날로 표시한다(기록 없음 아님)", () => {
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

    expect(
      points.map((p) => [p.date, p.isToday, p.isFuture, p.noRecord]),
    ).toEqual([
      ["2026-03-05", false, false, false],
      ["2026-03-06", true, false, false],
      ["2026-03-07", false, true, false],
      ["2026-03-08", false, true, false],
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
  // 오늘/지난 날짜 판정에 쓰는 가짜 시계를 테스트가 어떻게 끝나든 되돌린다
  afterEach(() => {
    vi.useRealTimers();
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
    // "확인 중"은 오늘 목록에만 붙는다
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-05T12:00:00+09:00"));
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

  it("지난 날짜 목록은 시청 시간이 없는 영상에 시청 시간 미확인을 붙인다(그날 시청 시간은 더 오지 않음)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-06T12:00:00+09:00"));
    const list = VL.playedVideos(
      [],
      [
        v("short", "2026-03-05T10:00:00+09:00"),
        v("pending", "2026-03-05T10:02:00+09:00"),
        v("local-null", "2026-03-05T10:03:00+09:00", { watchedSeconds: null }),
        v("ok", "2026-03-05T10:04:00+09:00"),
      ],
      "2026-03-05",
      { short: "short", pending: "pending_time" },
    );

    expect(list.map((x) => [x.eventId, x.mark])).toEqual([
      ["short", "거의 안 봄"],
      ["pending", "시청 시간 미확인"],
      ["local-null", "시청 시간 미확인"],
      ["ok", null],
    ]);
  });

  it("제목은 서버 메타데이터 제목 → 기록한 제목 → oEmbed 제목 → 제목 없음 순으로 고른다", () => {
    const list = VL.playedVideos(
      [],
      [
        v("shifted", "2026-03-05T10:00:00+09:00", { title: "직전 영상 제목" }),
        v("local", "2026-03-05T10:01:00+09:00"),
        v("fetched", "2026-03-05T10:02:00+09:00", { title: null }),
        v("blank", "2026-03-05T10:03:00+09:00", { title: "  " }),
        v("none", "2026-03-05T10:04:00+09:00", { title: null }),
      ],
      "2026-03-05",
      {},
      {
        correctedTitles: { shifted: "실제 제목", local: "  " },
        fetchedTitles: {
          "vid-fetched": "oEmbed 제목",
          "vid-local": "쓰이지 않는 oEmbed 제목",
          "vid-none": null,
        },
      },
    );

    expect(list.map((x) => [x.eventId, x.title])).toEqual([
      ["shifted", "실제 제목"],
      ["local", "영상 local"],
      ["fetched", "oEmbed 제목"],
      ["blank", VL.UNKNOWN_VIDEO_TITLE],
      ["none", VL.UNKNOWN_VIDEO_TITLE],
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
