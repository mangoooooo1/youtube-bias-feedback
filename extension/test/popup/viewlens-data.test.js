import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { isConGroup as isConGroupShared } from "../../pipeline/study-period.js";
import { isBaselinePeriod as isBaselinePeriodShared } from "../../pipeline/baseline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWLENS_DATA_PATH = path.join(__dirname, "../../popup/viewlens-data.js");

// viewlens-data.js는 classic script(window.VL = {...})라 그냥 import할 수 없다.
// window 스텁 위에서 실제 파일 소스를 그대로 평가(eval)해 VL을 꺼낸다.
// 로직을 다시 옮겨 적으면 실제ㅡ팝업이 로드하는 코드와 몰래 달라질 수 있어, 소스 자체를 실행해서 검증한다.
function loadVL() {
  const src = readFileSync(VIEWLENS_DATA_PATH, "utf8");
  const sandbox = {};
  sandbox.window = sandbox;
  const evaluate = new Function("window", `${src}\nreturn window.VL;`);
  return evaluate(sandbox);
}

// viewlens-data.js는 모듈 경계(classic script) 때문에 pipeline/baseline.js의
// isBaselinePeriod를 그대로 import하지 못하고 동일 로직을 다시 정의한다 — 두 사본이
// 갈라져도 아무 테스트도 실패하지 않던 사각지대라, 소스를 실행해 직접 대조한다.
describe("VL.isBaselinePeriod — pipeline/baseline.js와 동치성", () => {
  let VL;

  beforeAll(() => {
    VL = loadVL();
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

  beforeAll(() => {
    VL = loadVL();
  });

  it.each(["CON", "TEST-CON", "EXP", "TEST-EXP", undefined, null, ""])(
    "%s에 대해 공유 구현과 동일한 결과를 낸다",
    (code) => {
      expect(VL.isConGroup(code)).toBe(isConGroupShared(code));
    },
  );
});

// TOTAL_DAYS를 치환해 로드 — 실제 설정값과 무관하게 두 표기 분기를 고정 검증한다.
function loadVLWithTotalDays(days) {
  const src = readFileSync(VIEWLENS_DATA_PATH, "utf8").replace(
    /const TOTAL_DAYS = \d+;/,
    `const TOTAL_DAYS = ${days};`,
  );
  const sandbox = {};
  sandbox.window = sandbox;
  return new Function(
    "window",
    `${src}
return window.VL;`,
  )(sandbox);
}

describe("VL.studyDurationLabel — 연구 기간 표기", () => {
  it("7의 배수가 아니면(파일럿 12일) 일 단위로 표기한다", () => {
    expect(loadVLWithTotalDays(12).studyDurationLabel()).toBe("12일간");
  });

  it("7의 배수(본 연구 42일)면 주 단위로 표기한다", () => {
    expect(loadVLWithTotalDays(42).studyDurationLabel()).toBe("6주간");
  });
});

describe("VL.periodFactSentence — 기간별 리뷰 사실 문장", () => {
  let VL;
  beforeAll(() => {
    VL = loadVL();
  });

  const period = (label, videoCount, obj) => ({
    label,
    videoCount,
    dist: VL.dist(obj),
  });

  it("영상이 0개면 시청 기록이 없다고만 쓴다", () => {
    expect(VL.periodFactSentence(period("2구간", 0, { etc: 1 }), null)).toEqual(
      { main: "2구간에는 시청 기록이 없어요.", note: null },
    );
  });

  it("영상이 1개면 비율·변화 없이 분야만 쓴다", () => {
    const prev = period("1구간", 20, { game: 1 });
    expect(
      VL.periodFactSentence(period("2구간", 1, { music: 1 }), prev),
    ).toEqual({
      main: "2구간에 본 영상 1개는 음악 관련 영상이었어요.",
      note: null,
    });
    // 받침 없는 분야도 같은 어미
    expect(
      VL.periodFactSentence(period("2구간", 1, { game: 1 }), null).main,
    ).toBe("2구간에 본 영상 1개는 게임 관련 영상이었어요.");
  });

  it("상위 2개 분야와 직전 기간 대비 변화를 쓴다", () => {
    const prev = period("1구간", 20, { music: 0.46, game: 0.54 });
    const cur = period("2구간", 24, { music: 0.58, game: 0.21, edu: 0.21 });

    expect(VL.periodFactSentence(cur, prev)).toEqual({
      main: "2구간에 본 영상 24개 중 음악이 58%, 게임이 21%였어요. 1구간보다 음악 비중이 12%p 늘었어요.",
      note: null,
    });
  });

  it("줄었으면 줄었다고, 반올림해 같으면 같았다고 쓴다", () => {
    const cur = period("3주차", 30, { music: 0.4, game: 0.6 });

    expect(
      VL.periodFactSentence(cur, period("2주차", 30, { game: 0.7, music: 0.3 }))
        .main,
    ).toContain("2주차보다 게임 비중이 10%p 줄었어요.");
    expect(
      VL.periodFactSentence(
        cur,
        period("2주차", 30, { game: 0.604, music: 0.396 }),
      ).main,
    ).toContain("게임 비중은 2주차와 같았어요.");
  });

  it("변화량은 두 기간의 반올림된 비율끼리 뺀다(범례 숫자로 확인 가능)", () => {
    // 범례 55% → 55%지만 원값 차이는 0.8%p
    const cur = period("2구간", 20, { music: 0.546, game: 0.454 });
    const prev = period("1구간", 20, { music: 0.554, game: 0.446 });
    expect(VL.periodFactSentence(cur, prev).main).toContain(
      "음악 비중은 1구간과 같았어요.",
    );

    // 범례 55% → 54%(1%p)지만 원값 차이는 0.2%p
    const cur2 = period("2구간", 20, { music: 0.544, game: 0.456 });
    const prev2 = period("1구간", 20, { music: 0.546, game: 0.454 });
    expect(VL.periodFactSentence(cur2, prev2).main).toContain(
      "1구간보다 음악 비중이 1%p 줄었어요.",
    );
  });

  it("직전 기간에 없던 분야는 0%에서 늘었다고 쓴다", () => {
    const cur = period("2구간", 10, { sports: 1 });
    expect(
      VL.periodFactSentence(cur, period("1구간", 10, { music: 1 })).main,
    ).toContain("1구간보다 스포츠 비중이 100%p 늘었어요.");
  });

  it("첫 기간이거나 직전 기간 영상이 0개면 변화 문장을 생략한다", () => {
    const cur = period("2구간", 12, { music: 1 });
    const expected = "2구간에 본 영상 12개 중 음악이 100%였어요.";

    expect(VL.periodFactSentence(cur, null).main).toBe(expected);
    expect(
      VL.periodFactSentence(cur, period("1구간", 0, { etc: 1 })).main,
    ).toBe(expected);
  });

  it("기타가 1위여도 건너뛰고, 기타뿐이면 기타를 쓴다", () => {
    const withEtc = period("2구간", 20, { etc: 0.5, game: 0.3, music: 0.2 });
    expect(VL.periodFactSentence(withEtc, null).main).toBe(
      "2구간에 본 영상 20개 중 게임이 30%, 음악이 20%였어요.",
    );

    const onlyEtc = period("2구간", 20, { etc: 1 });
    expect(VL.periodFactSentence(onlyEtc, null).main).toBe(
      "2구간에 본 영상 20개 중 기타가 100%였어요.",
    );
  });

  it("이 기간 영상이 10개 미만이면 이 기간 안내를 붙인다", () => {
    const cur = period("2구간", 9, { music: 1 });
    expect(
      VL.periodFactSentence(cur, period("1구간", 20, { music: 1 })).note,
    ).toBe(
      "이 기간은 본 영상이 적어서, 비중이 평소 시청 경향과 다를 수 있어요.",
    );
    expect(
      VL.periodFactSentence(period("2구간", 10, { music: 1 }), null).note,
    ).toBeNull();
  });

  it("직전 기간만 10개 미만이면 직전 기간 안내를 붙인다", () => {
    const cur = period("3주차", 20, { music: 1 });
    expect(
      VL.periodFactSentence(cur, period("2주차", 9, { music: 1 })).note,
    ).toBe("2주차는 본 영상이 적어서, 변화 폭이 평소와 다를 수 있어요.");
    expect(
      VL.periodFactSentence(
        period("2구간", 20, { music: 1 }),
        period("1구간", 3, { music: 1 }),
      ).note,
    ).toBe("1구간은 본 영상이 적어서, 변화 폭이 평소와 다를 수 있어요.");
  });

  it("비율은 막대그래프 범례와 같은 반올림을 쓴다", () => {
    const cur = period("2구간", 30, { music: 0.555, game: 0.445 });
    const legend = cur.dist.map((d) => `${Math.round(d.p * 100)}%`);

    expect(VL.periodFactSentence(cur, null).main).toBe(
      `2구간에 본 영상 30개 중 음악이 ${legend[0]}, 게임이 ${legend[1]}였어요.`,
    );
  });

  it.each([
    ["game", "게임이"],
    ["music", "음악이"],
    ["ent", "엔터테인먼트가"],
    ["news", "뉴스·정치가"],
    ["edu", "교육이"],
    ["sci", "과학·기술이"],
    ["sports", "스포츠가"],
    ["vlog", "인물·블로그가"],
  ])("%s 분야 이름에 맞는 조사를 쓴다", (key, many) => {
    expect(
      VL.periodFactSentence(period("2구간", 5, { [key]: 1 }), null).main,
    ).toContain(`${many} 100%`);
  });
});

// ── 서버 집계(/api/viewing-summary) → 화면 값 (Task 5) ─────────────────────────
describe("VL.serverDist — 유튜브 분야 15종 + 기타", () => {
  let VL;
  beforeAll(() => {
    VL = loadVL();
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

  // 예전 9개 묶음으로 그리는 지금 화면(VL.dist)도 같은 VL_CATS 색을 쓴다
  it("예전 9개 묶음 키도 VL_CATS의 같은 분야 색을 쓰고, 그때의 화면 이름은 유지한다", () => {
    const [news] = VL.dist({ news: 1 });
    expect(news).toMatchObject({
      name: "뉴스·정치",
      color: VL.CATS["뉴스 & 정치"].color,
    });
    expect(VL.dist({ music: 1 })[0].color).toBe(VL.CATS.음악.color);
    expect(VL.dist({ unknown: 1 })[0].color).toBe(VL.CATS.기타.color);
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

describe("VL.titleSentence — 탭 맨 위 제목 문장(결정 1)", () => {
  let VL;
  beforeAll(() => {
    VL = loadVL();
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
  beforeAll(() => {
    VL = loadVL();
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

describe("VL.periodLines — 기간 탭 꺾은선(결정 1)", () => {
  let VL;
  beforeAll(() => {
    VL = loadVL();
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

  it("확인된 유효 영상이 1개인 날은 적은 날, 오늘은 표시하고 오늘 이후는 그리지 않는다", () => {
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

    expect(points.map((p) => [p.date, p.few, p.isToday])).toEqual([
      ["2026-03-05", true, false],
      ["2026-03-06", false, true],
    ]);
  });
});

describe("VL.MIN_VALID_VIDEOS_PER_DAY — 서버 기준과 동치성", () => {
  it("서버 study-constants의 하루 기준과 같다", () => {
    const VL = loadVL();
    const require = createRequire(import.meta.url);
    const {
      MIN_VALID_VIDEOS_PER_DAY,
    } = require("../../../server/pipeline/study-constants.js");
    expect(VL.MIN_VALID_VIDEOS_PER_DAY).toBe(MIN_VALID_VIDEOS_PER_DAY);
  });
});
