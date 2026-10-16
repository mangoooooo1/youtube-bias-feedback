import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POPUP_DIR = path.join(__dirname, "../../popup");

// classic script 세 개(데이터·UI·화면)를 팝업과 같은 순서로 한 스코프에서 실행한다.
// 브라우저 전역(VL, koreanDateLabel)은 window에서 꺼내 같은 이름으로 둔다. koreanDateLabel은 Studio 스텁.
function loadScreens() {
  const src = ["viewlens-data.js", "viewlens-ui.js", "viewlens-screens.js"]
    .map((f) => readFileSync(path.join(POPUP_DIR, f), "utf8"))
    .join("\n;\n");
  const sandbox = {};
  sandbox.window = sandbox;
  return new Function(
    "window",
    "document",
    "markSVG",
    `${src}\n;const koreanDateLabel = window.koreanDateLabel;
const VL = window.VL;\nreturn { screenToday, VL };`,
  )(sandbox, {}, () => "");
}

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

  beforeEach(() => {
    ({ screenToday, VL } = loadScreens());
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
    const html = render();
    expect(html).toContain(
      "시청 시간이 가장 긴 분야는 음악이었지만, 영상을 가장 많이 본 분야는 스포츠였어요.",
    );
    expect(html.indexOf(">음악</span>")).toBeLessThan(
      html.indexOf(">스포츠</span>"),
    );
    expect(html).toContain("영상 13개");
    expect(html).toContain("시청 시간 확인 중 1개");
    // 예전 표시(영상 수 기준 분야 수)는 없다
    expect(html).not.toContain("개 분야");
  });

  it("확인 중인 영상이 없으면 그 줄을 숨긴다", () => {
    expect(render({ unconfirmedCount: 0 })).not.toContain("시청 시간 확인 중");
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
