import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadPopup } from "./load-popup.js";

// 실제 팝업 파일을 popup.html 순서대로 불러와 화면 함수와 전역(VL, koreanDateLabel)을 꺼낸다.
async function loadScreens() {
  const g = await loadPopup();
  return {
    screenToday: g.screenToday,
    screenFeedback: g.screenFeedback,
    screenControlHome: g.screenControlHome,
    vlReview: g.vlReview,
    vlShareLines: g.vlShareLines,
    VL: g.VL,
    koreanDateLabel: g.koreanDateLabel,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const DAY = {
  date: "2026-03-05",
  confirmedCount: 13,
  unconfirmedCount: 1,
  shortCount: 3,
  chartCount: 12,
  chartSeconds: 5400,
  timeDistribution: { 음악: 0.6, 스포츠: 0.4 },
  countDistribution: { 스포츠: 0.75, 음악: 0.25 },
  excluded: [],
};

describe("screenToday — 서버 집계 기준 그래프 영역", () => {
  let screenToday;
  let VL;
  let koreanDateLabel;

  beforeEach(async () => {
    ({ screenToday, VL, koreanDateLabel } = await loadScreens());
  });

  function render(dayOverrides = {}, status = "ok", todayOverrides = {}) {
    const view = VL.dayView({ ...DAY, ...dayOverrides });
    view.status = status;
    VL.today = {
      ...VL.today,
      dateLabel: "3월 5일 목요일",
      isEmpty: false,
      collectingCount: 0,
      collectingTimer: "",
      view,
      ...todayOverrides,
    };
    VL._todayCumulative = null;
    return screenToday();
  }

  it("제목 문장, 공통 범례(시간 순), 영상 수(확인됨)와 확인 중 수를 보여 준다", () => {
    // "확인 중"은 오늘만 보인다
    const html = render({}, "ok", { dateLabel: koreanDateLabel(new Date()) });
    expect(html).toContain(
      '<b style="font-weight:800">음악</b>에 시간을 가장 많이 썼어요',
    );
    // 12개 × 75%
    expect(html).toContain(
      '<b style="font-weight:800">스포츠</b> 영상을 가장 많이 봤어요 (9개)',
    );
    expect(html.indexOf(">음악</span>")).toBeLessThan(
      html.indexOf(">스포츠</span>"),
    );
    expect(html).toContain("영상 13개");
    expect(html).toContain("시청 시간 확인 중 1개");
    // 예전 표시(영상 수 기준 분야 수)는 없다
    expect(html).not.toContain("개 분야");
  });

  it("제목 문장이 영상 수 줄보다 위, 범례는 도넛 카드 안 도넛 아래", () => {
    const html = render();
    const title = html.indexOf("에 시간을 가장 많이 썼어요");
    const card = html.indexOf("유튜브 시청 분야별 비중");
    expect(title).toBeLessThan(html.indexOf("영상 13개"));
    expect(html.indexOf("영상 13개")).toBeLessThan(card);
    expect(html.indexOf(">음악</span>")).toBeGreaterThan(card);
    expect(html.indexOf(">음악</span>")).toBeGreaterThan(
      html.lastIndexOf("영상 개수"),
    );
  });

  // 태그를 지운 글자만 남긴다(분야명의 <b>는 글자 사이라 공백 없이 지운다)
  const textOf = (html) =>
    html
      .replace(/<\/?b[^>]*>/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  it("수집 중·스크롤 안내가 없으면 제목 아래 빈 줄 없이 영상 수를 제목 오른쪽에 붙인다", () => {
    const html = render();
    // 왼쪽 자리가 빈 줄(<div></div>)이 생기지 않는다
    expect(html).not.toContain("<div></div>");
    expect(html).toContain("align-items:baseline");
    // 영상 수는 큰 제목 줄 옆, 보조 줄은 그 아래 전체 폭
    expect(textOf(html)).toContain(
      "음악에 시간을 가장 많이 썼어요 영상 13개 스포츠 영상을 가장 많이 봤어요 (9개)",
    );
  });

  it("제목·보조 줄은 띄어쓰기에서만 줄바꿈한다('(1개씩)'이 중간에서 끊기지 않게)", () => {
    const html = render({
      timeDistribution: { "인물 & 블로그": 0.7, 엔터테인먼트: 0.3 },
      countDistribution: { 엔터테인먼트: 0.5, "인물 & 블로그": 0.5 },
      chartCount: 2,
    });
    const sub = html.match(
      /<div style="([^"]*)">[^<]*<b[^>]*>엔터테인먼트·인물/,
    );
    expect(sub[1]).toContain("word-break:keep-all");
    expect(html).toContain("영상을 가장 많이 봤어요 (1개씩)");
  });

  it("제목이 없어도 수집 중·스크롤 안내가 없으면 영상 수만 그 자리에 보인다", () => {
    const html = render({
      timeDistribution: {},
      countDistribution: {},
      chartCount: 0,
    });
    expect(html).not.toContain("<div></div>");
    expect(html).toContain("영상 13개");
  });

  it("수집 중이면 지금처럼 제목 아래 줄 왼쪽에 수집 표시, 오른쪽에 영상 수", () => {
    const html = render({}, "ok", {
      dateLabel: koreanDateLabel(new Date()),
      collectingCount: 2,
    });
    expect(html).not.toContain("align-items:baseline");
    expect(textOf(html)).toContain(
      "음악에 시간을 가장 많이 썼어요 스포츠 영상을 가장 많이 봤어요 (9개) 영상 2개 수집 중 영상 13개",
    );
  });

  it("확인 중인 영상이 없으면 그 줄을 숨긴다", () => {
    expect(render({ unconfirmedCount: 0 })).not.toContain("시청 시간 확인 중");
  });

  it("지난 날짜에는 시청 시간 확인 중 수를 보이지 않는다(그날 시청 시간은 더 오지 않음)", () => {
    const html = render({ unconfirmedCount: 4 });
    expect(html).toContain("영상 13개");
    expect(html).not.toContain("시청 시간 확인 중");
  });

  it("시간과 개수 1위가 같으면 보조 줄 없이, 분야명만 굵고 &가 든 이름도 그대로 보인다", () => {
    const html = render({
      timeDistribution: { "인물 & 블로그": 0.6, 게임: 0.4 },
      countDistribution: { "인물 & 블로그": 0.75, 게임: 0.25 },
    });
    expect(html).toContain(
      '<b style="font-weight:800">인물 &amp; 블로그</b> 영상을 가장 많이 봤어요',
    );
    expect(html.match(/<b style="font-weight:800">/g)).toHaveLength(1);
    expect(html).not.toContain("시간을 가장 많이 썼어요");
  });

  it("제목이 없으면 영상 수 줄이 날짜 바로 다음에 온다", () => {
    const html = render({
      timeDistribution: {},
      countDistribution: {},
      chartCount: 0,
    });
    expect(html).not.toContain("가장 많이");
    expect(html).toContain("영상 13개");
    expect(html.indexOf("3월 5일")).toBeLessThan(html.indexOf("영상 13개"));
  });

  it("도넛 두 개는 가운데 이름만 두고, 조각마다 퍼센트와 시간·개수를 툴팁으로 단다", () => {
    const html = render();
    expect(html).toContain("시청 시간</span>");
    expect(html).toContain("영상 개수</span>");
    expect(html).not.toContain("vl-donut-count");
    expect(html).toContain("<title>음악 60% · 54분</title>");
    expect(html).toContain("<title>스포츠 75% · 9개</title>");
  });

  it("잠깐 본 영상과 분야를 확인하지 못한 영상(영상 수 − 도넛 개수)을 안내한다", () => {
    const html = render();
    expect(html).toContain("잠깐 본 영상 3개는 세지 않았어요");
    expect(html).toContain("분야를 확인하지 못한 영상 1개는 그래프에서 뺐어요");
  });

  it("0개인 안내는 숨긴다", () => {
    const html = render({ shortCount: 0, chartCount: 13 });
    expect(html).not.toContain("잠깐 본 영상");
    expect(html).not.toContain("분야를 확인하지 못한 영상");
  });

  // 저장본은 마지막 서버 값이라 따로 알리지 않는다
  it("저장본을 보여 줄 때도 별도 안내 없이 그린다", () => {
    expect(render({}, "ok")).not.toContain("불러오지 못했어요");
  });

  it("ⓘ 툴팁은 줄 왼쪽에서 위로 펼치고(잘림 방지) 물음표 커서를 쓰지 않는다", () => {
    const html = render();
    expect(html).toContain("vl-tip vl-tip-up vl-tip-line");
    expect(html).not.toContain("cursor:help");
  });

  it("저장본도 없이 불러오기에 실패하면 그래프 대신 안내한다", () => {
    const html = render(
      { timeDistribution: {}, countDistribution: {}, chartCount: 0 },
      "failed",
    );
    expect(html).toContain("시청 기록을 불러오지 못했어요");
    expect(html).not.toContain("<title>");
  });

  it("지난 날짜는 '이 날'로 표시한다", () => {
    expect(render()).toContain("이 날 유튜브 시청 분야별 비중");
  });

  it("서버에도 로컬에도 기록이 없으면 빈 화면", () => {
    const html = render(
      {
        confirmedCount: 0,
        unconfirmedCount: 0,
        timeDistribution: {},
        countDistribution: {},
      },
      "ok",
      { isEmpty: true },
    );
    expect(html).not.toContain("유튜브 시청 분야별 비중");
  });
});

describe("screenToday — 리뷰 카드와 재생한 영상 목록", () => {
  let screenToday;
  let VL;
  let koreanDateLabel;

  beforeEach(async () => {
    ({ screenToday, VL, koreanDateLabel } = await loadScreens());
  });

  function renderToday(cumulative, { videos = [], unconfirmedCount = 0 } = {}) {
    const view = VL.dayView({ ...DAY, unconfirmedCount });
    view.status = "ok";
    VL.today = {
      ...VL.today,
      dateLabel: koreanDateLabel(new Date()),
      dateKey: "2026-03-05",
      isEmpty: false,
      collectingCount: 0,
      collectingTimer: "",
      view,
      videos,
    };
    VL._todayCumulative = {
      eligible: true,
      generating: false,
      noReview: false,
      locked: false,
      ...cumulative,
    };
    return screenToday();
  }

  it("오늘 카드 제목과 리뷰를 만든 시각(기준)을 보여 준다", () => {
    const html = renderToday({
      review: "오늘 리뷰",
      generatedAt: "2026-03-05T05:32:00Z",
    });
    expect(html).toContain("오늘은 어떤 영상을 봤을까요?");
    expect(html).toContain("14:32 기준");
    expect(html).not.toContain("오늘 하루 돌아보기");
  });

  it("생성 중이면 기준 시각을 숨긴다", () => {
    const html = renderToday({
      generating: true,
      generatedAt: "2026-03-05T05:32:00Z",
    });
    expect(html).toContain("분석하고 있어요");
    expect(html).not.toContain("기준</span>");
  });

  it("리뷰가 없을 때 확인 중인 영상이 있으면 시청 시간이 확인되면 만든다고 안내한다", () => {
    expect(renderToday({ noReview: true }, { unconfirmedCount: 1 })).toContain(
      "지금 보고 있는 영상의 시청 시간이 확인되면 리뷰를 만들어요.",
    );
    expect(renderToday({ noReview: true })).toContain(
      "잠깐 본 영상만 있어 아직 리뷰를 만들지 않았어요.",
    );
  });

  it("목록 이름은 '오늘 재생한 영상'이고 줄마다 표시를 붙인다", () => {
    const html = renderToday(
      { review: "오늘 리뷰" },
      {
        videos: [
          { title: "다 본 영상", videoId: "a", mark: null },
          { title: "넘긴 쇼츠", videoId: "b", mark: "거의 안 봄" },
        ],
      },
    );
    expect(html).toContain("오늘 재생한 영상");
    expect(html).toContain(">거의 안 봄</span>");
    expect(html).toContain(">2개</span>");
  });

  it("지난 날짜 카드는 '○월 ○일엔 어떤 영상을 봤을까요?'와 '이 날 재생한 영상'", () => {
    const view = VL.dayView(DAY);
    view.status = "ok";
    VL.today = {
      ...VL.today,
      dateLabel: "3월 5일 목요일",
      dateKey: "2026-03-05",
      isEmpty: false,
      collectingCount: 0,
      collectingTimer: "",
      view,
      review: "그날 리뷰",
      reviewGeneratedAt: "2026-03-05T15:31:00Z",
      videos: [{ title: "영상", videoId: "a", mark: null }],
    };
    const html = screenToday();
    expect(html).toContain("3월 5일엔 어떤 영상을 봤을까요?");
    expect(html).toContain("이 날 재생한 영상");
    expect(html).toContain("3/6 00:31 기준");
  });
});

const PERIOD = {
  periodIndex: 2,
  start: "2026-06-05",
  end: "2026-06-08",
  confirmedCount: 9,
  shortCount: 2,
  chartCount: 8,
  chartSeconds: 7200,
  timeDistribution: {
    게임: 0.5,
    음악: 0.2,
    스포츠: 0.15,
    교육: 0.1,
    코미디: 0.05,
  },
  countDistribution: {
    음악: 0.4,
    게임: 0.3,
    스포츠: 0.1,
    교육: 0.1,
    코미디: 0.1,
  },
};
const PERIOD_DAYS = [
  {
    date: "2026-06-05",
    confirmedCount: 5,
    timeDistribution: { 게임: 0.6, 음악: 0.2, 교육: 0.2 },
  },
  { date: "2026-06-06", confirmedCount: 1, timeDistribution: { 게임: 1 } },
  // 6/7은 기록 없음
  {
    date: "2026-06-08",
    confirmedCount: 3,
    timeDistribution: { 음악: 0.5, 코미디: 0.5 },
  },
];

describe("vlShareLines — 날마다 분야별 비중 꺾은선", () => {
  let vlShareLines;
  let VL;

  beforeEach(async () => {
    ({ vlShareLines, VL } = await loadScreens());
  });

  function draw(focus = null, today = "2026-06-08") {
    return vlShareLines({
      ...VL.periodLines(PERIOD, PERIOD_DAYS, today),
      focus,
    });
  }

  it("기록 없는 날은 '기록 없음', 오늘은 점선과 '집계 중'", () => {
    const svg = draw();
    expect(svg.match(/>기록 없음</g)).toHaveLength(1);
    // "기록 없음"은 날짜(6/7)보다 아래, 세로 띠는 없다
    expect(svg).not.toContain('fill="var(--vl-line)"');
    const yOf = (label) =>
      Number(svg.match(new RegExp(`y="([\\d.]+)"[^>]*>${label}<`))[1]);
    expect(yOf("기록 없음")).toBeGreaterThan(yOf("6/7"));
    expect(svg).toContain(">집계 중<");
    expect(svg).toContain('stroke-dasharray="4 3"');
  });

  it("구간 첫날은 날짜 눈금을 구간 일수만큼 깔고, 점은 첫 날짜에만, 미래 날짜엔 선·'기록 없음'이 없다", () => {
    const svg = vlShareLines(
      VL.periodLines(
        { ...PERIOD, start: "2026-06-05", end: "2026-06-11" },
        [PERIOD_DAYS[0]],
        "2026-06-05",
      ),
    );
    for (const d of [5, 6, 7, 8, 9, 10, 11])
      expect(svg).toContain(`>6/${d}</text>`);
    expect(svg).not.toContain("기록 없음");
    // 분야 선(상위 3개 + 그 밖) 4개 × 첫 날짜 하나
    expect(svg.match(/<circle /g)).toHaveLength(4);
    expect(svg.match(/<title>6\/5\(금\)/g)).toHaveLength(4);
    // 이어 그은 선분이 없다(가로 눈금선만 있음)
    expect(svg).not.toContain('stroke-linecap="round"');
    // 왼쪽 끝 "집계 중"은 잘리지 않게 왼쪽 정렬
    expect(svg).toMatch(/text-anchor="start"[^>]*>집계 중</);
  });

  it("오늘이 구간 밖이면 점선·'집계 중'이 없다", () => {
    const svg = draw(null, "2026-06-20");
    expect(svg).not.toContain("집계 중");
    expect(svg).not.toContain("stroke-dasharray");
  });

  it("점은 영상 수와 상관없이 모두 채운 원, 점마다 날짜·분야·비중 툴팁", () => {
    const svg = draw();
    expect(svg).not.toContain('fill="var(--vl-card)"');
    expect(svg).not.toContain("영상이 적은 날");
    expect(svg).toContain("<title>6/6(토) · 게임 100%</title>");
    expect(svg).toContain("<title>6/5(금) · 게임 60%</title>");
  });

  it("선은 clip이 왼쪽에서 오른쪽으로 넓어지며 그어지고, 그릴 때마다 clip id가 다르다", () => {
    const svg = draw();
    expect(svg).toMatch(/<animate attributeName="width" from="0" to="300"/);
    const ids = [draw(), draw()].map(
      (html) => html.match(/clip-path="url\(#([^)]+)\)"/)[1],
    );
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("핑은 고른 분야의 점에만(기록 없는 날 제외), 고르지 않으면 없다", () => {
    expect(draw()).not.toContain("vl-dot-ping");
    const svg = draw("게임");
    const pings = svg.match(/class="vl-dot-ping"/g) || [];
    // 6/5·6/6·6/8 — 6/7은 기록 없음
    expect(pings).toHaveLength(3);
    expect(svg).not.toMatch(/vl-dot-ping[^>]*stroke/);
  });

  it("범례로 고른 분야만 진하게, 나머지 선은 흐리게", () => {
    const svg = draw("게임");
    expect(svg).toMatch(/stroke="[^"]+" stroke-width="3"[^>]*opacity="1"/);
    expect(svg).toContain('opacity="0.18"');
    expect(draw()).not.toContain('opacity="0.18"');
  });
});

describe("screenFeedback — 기간 탭(서버 집계 기준)", () => {
  let screenFeedback;
  let VL;

  beforeEach(async () => {
    ({ screenFeedback, VL } = await loadScreens());
    VL.weeks[1] = {
      ...VL.weeks[1],
      label: "2구간",
      review: "직전 구간보다 게임 비중이 늘었어요.",
    };
  });

  function render(period = PERIOD, status = "ok", focus = null) {
    return screenFeedback(
      2,
      2,
      { period, days: PERIOD_DAYS, today: "2026-06-08", status },
      focus,
    );
  }

  it("구간 줄 오른쪽에 날짜 범위, 제목 문장, 상위 3개 + 그 밖 범례", () => {
    const html = render();
    expect(html).toContain("6/5 ~ 6/8");
    expect(html).toContain(
      '<b style="font-weight:800">게임</b>에 시간을 가장 많이 썼어요',
    );
    // 구간 chartCount 8개 × 40%
    expect(html).toContain(
      '<b style="font-weight:800">음악</b> 영상을 가장 많이 봤어요 (3개)',
    );
    const keys = [...html.matchAll(/data-legend-key="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(keys.slice(0, 3)).toEqual(["게임", "음악", "스포츠"]);
    expect(keys).toHaveLength(4);
  });

  it("날짜 범위 아래에 분야 수(그래프 분야)와 영상 수(시청 시간 확인된 영상)를 보인다", () => {
    const html = render();
    expect(html).toContain("분야 5개 · 영상 9개");
    expect(html.indexOf("6/5 ~ 6/8")).toBeLessThan(
      html.indexOf("분야 5개 · 영상 9개"),
    );
  });

  it("그래프에 넣을 기록이 없는 구간에는 분야·영상 수 줄이 없다", () => {
    const html = render({
      ...PERIOD,
      timeDistribution: {},
      countDistribution: {},
      chartCount: 0,
    });
    expect(html).toContain("6/5 ~ 6/8");
    expect(html).not.toContain("가장 많이");
    expect(html).not.toContain("분야 0개");
    expect(html).not.toMatch(/분야 \d+개 · 영상/);
  });

  it("꺾은선·구간 전체 도넛 2개·안내 문구를 그리고, 리뷰 카드 제목은 직전 구간 비교 질문", () => {
    const html = render();
    expect(html).toContain("날마다 유튜브 시청 시간 중 분야별 비중");
    expect(html).toContain("vl-share-lines");
    expect(html).toContain("2구간 전체 분야별 비중");
    expect(html).toContain("잠깐 본 영상 2개는 세지 않았어요");
    expect(html).toContain("분야를 확인하지 못한 영상 1개는 그래프에서 뺐어요");
    expect(html).toContain("이번 구간, 시청은 어떻게 달라졌나요?");
    expect(html).toContain("직전 구간보다 게임 비중이 늘었어요.");
    // 리뷰 위 코드 비교 문장·생성 시각은 없다
    expect(html).not.toContain("돌아보기");
    expect(html).not.toContain("기준</");
  });

  it("꺾은선 범례는 누를 수 있는 칩 — 고른 칩만 눌림, 나머지는 흐리게", () => {
    const html = render(PERIOD, "ok", "음악");
    expect(html).toMatch(/data-legend-key="음악" aria-pressed="true"/);
    expect(html).toMatch(
      /data-legend-key="게임" aria-pressed="false"[^>]*opacity:0.5/,
    );
    expect(render()).not.toContain('aria-pressed="true"');
  });

  it("도넛 카드에는 모든 분야 범례, 꺾은선 칩은 상위 3개 + 그 밖", () => {
    const html = render();
    const donutCard = html.slice(html.indexOf("2구간 전체 분야별 비중"));
    expect(donutCard).toContain(">교육</span>");
    expect(donutCard).toContain(">코미디</span>");
    expect(donutCard).not.toContain("data-legend-key");
  });

  it("'그 밖' 선은 '기타' 분야와 다른 색", () => {
    const { lines } = VL.periodLines(PERIOD, PERIOD_DAYS, "2026-06-08");
    expect(lines.at(-1).name).toBe("그 밖");
    expect(lines.at(-1).color).not.toBe(VL.CATS.기타.color);
  });

  it("집계가 없으면 상태에 맞는 안내만 보여 준다", () => {
    expect(render(null, "loading")).toContain("시청 기록을 불러오고 있어요.");
    expect(render(null, "failed")).toContain("시청 기록을 불러오지 못했어요.");
    const empty = render(
      { ...PERIOD, timeDistribution: {}, countDistribution: {} },
      "ok",
    );
    expect(empty).toContain("이 구간에는 그래프에 넣을 시청 기록이 없어요.");
    expect(empty).not.toContain("vl-share-lines");
  });
});

describe("screenControlHome — 홈 안내 카드", () => {
  it("안내 문단은 띄어쓰기에서만 줄바꿈한다('연구'가 중간에서 끊기지 않게)", async () => {
    const { screenControlHome } = await loadScreens();
    const p = screenControlHome(1).match(
      /<p style="([^"]*)">\s*평소처럼 유튜브를 시청해 주세요/,
    );
    expect(p[1]).toContain("word-break:keep-all");
  });
});

describe("vlReview — 관심 분야 헤드라인", () => {
  it("분야명만 굵고, 띄어쓰기에서만 줄바꿈한다", async () => {
    const { vlReview } = await loadScreens();
    const m = vlReview({ text: "리뷰", topic: "인물과 일상 루틴" }).match(
      /<p style="([^"]*)">\s*당신은 <span style="([^"]*)">인물과 일상 루틴<\/span>에 관심이 많습니다\./,
    );
    expect(m[1]).toContain("font-size:var(--vl-fs-4)");
    expect(m[1]).toContain("font-weight:500");
    expect(m[1]).toContain("word-break:keep-all");
    expect(m[2]).toContain("font-weight:800");
  });
});
