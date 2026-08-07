// viewlens-data.js — categories, entropy helpers, mock study data, tone presets
// Exports (window): VL

const VL_CATS = {
  game: { name: "게임", color: "oklch(0.67 0.15 32)" },
  music: { name: "음악", color: "oklch(0.66 0.14 300)" },
  ent: { name: "엔터테인먼트", color: "oklch(0.68 0.13 350)" },
  news: { name: "뉴스·정치", color: "oklch(0.64 0.13 248)" },
  edu: { name: "교육", color: "oklch(0.66 0.13 152)" },
  sci: { name: "과학·기술", color: "oklch(0.68 0.12 205)" },
  sports: { name: "스포츠", color: "oklch(0.70 0.13 78)" },
  vlog: { name: "인물·블로그", color: "oklch(0.66 0.10 120)" },
  etc: { name: "기타", color: "oklch(0.62 0.02 250)" },
};

function dist(obj) {
  if (!obj) return [];
  return Object.entries(obj)
    .map(([k, p]) => {
      const cat = VL_CATS[k] || VL_CATS.etc;
      return { key: k, name: cat.name, color: cat.color, p };
    })
    .sort((a, b) => b.p - a.p);
}

function entropy(arr) {
  return arr.reduce((h, d) => (d.p > 0 ? h - d.p * Math.log2(d.p) : h), 0);
}

// 베이스라인 기간(설치 후 14일 미만) 판정 — extension/pipeline/baseline.js와 규칙이 동일해야 한다.
// 팝업/Studio는 classic script라 ESM import를 쓸 수 없어(background.js는 type=module) 로직을 중복 정의한다.
const BASELINE_DAYS = 14;
function isBaselinePeriod(installDate, now = new Date()) {
  if (!installDate) return true;
  return (
    (now.getTime() - new Date(installDate).getTime()) / 86400000 <
    BASELINE_DAYS
  );
}

// TEST-EXP/TEST-CON(연구자 모드)는 "모든 화면을 미리 볼 수 있다"는 설계 의도(GROUPS 주석 참고)가
// 있어, 실제 참여자 온보딩과 무관하게 베이스라인 게이트를 적용하면 안 된다.
// background.js의 isTestGroup()과 동일 규칙 — 모듈 경계 때문에 중복 정의한다.
function isTestGroup(group) {
  return typeof group === "string" && group.startsWith("TEST");
}

const H_MAX = 3.17;

const today = {
  dateLabel: "6월 7일 토요일",
  videoCount: 14,
  sessionCount: 2,
  dist: dist({
    game: 0.4,
    music: 0.22,
    ent: 0.14,
    news: 0.12,
    edu: 0.08,
    sci: 0.04,
  }),
  prevEntropy: 1.72,
  prevDateLabel: "6월 5일",
  videos: [
    { title: "2024 LCK 서머 결승 풀 하이라이트", cat: "game" },
    { title: "발로란트 신규 요원 200% 활용 공략", cat: "game" },
    { title: "랭크 올리는 정글 동선 완전정복", cat: "game" },
    { title: "아이유 신곡 'Love Wins All' MV", cat: "music" },
    { title: "백예린 〈square〉 라이브 클립", cat: "music" },
    { title: "연예대상 레전드 무대 모음.zip", cat: "ent" },
    { title: "[속보] 오늘의 주요 뉴스 브리핑", cat: "news" },
    { title: "10분 만에 끝내는 미적분 핵심 개념", cat: "edu" },
    { title: "블랙홀은 정말 모든 걸 삼킬까? (다큐)", cat: "sci" },
  ],
  review:
    "오늘은 게임 영상에 가장 오래 머무셨어요 — 특히 LCK 결승 하이라이트나 발로란트 공략처럼 e스포츠·경쟁 게임 쪽이 절반 가까이를 차지했네요. 음악은 아이유 신곡 MV나 라이브 클립 같은 최신 발매곡 위주였고요. 그래도 중간에 블랙홀 다큐와 미적분 개념 같은 과학·교육 영상을 챙겨 보신 점이 인상적이에요. 내일은 평소 잘 안 보던 분야 영상을 딱 하나만 더 곁들여 보면 편중에서 다양 쪽으로 한 걸음 더 갈 수 있어요.",
};

const weeks = [
  {
    week: 1,
    label: "1주차",
    isBaseline: true,
    range: "6/1 – 6/7",
    videoCount: 78,
    sessionCount: 11,
    dist: dist({
      game: 0.51,
      music: 0.2,
      ent: 0.12,
      news: 0.09,
      sci: 0.05,
      edu: 0.03,
    }),
    daily: [1.55, 1.8, 1.68, 2.02, 1.74, 1.96, 1.88],
    review:
      "첫 주 동안의 시청 습관을 기준선으로 담아 두었어요. 게임이 절반 가까이를 차지했지만, 이건 평가가 아니라 출발점이에요. 다음 주부터 어떤 변화가 생기는지 저와 함께 천천히 지켜봐요.",
  },
  {
    week: 2,
    label: "2주차",
    isBaseline: false,
    range: "6/8 – 6/14",
    videoCount: 71,
    sessionCount: 10,
    dist: dist({
      game: 0.37,
      music: 0.19,
      edu: 0.14,
      sci: 0.11,
      news: 0.1,
      ent: 0.09,
    }),
    daily: [1.98, 2.21, 2.34, 2.18, 2.46, 2.4, 2.55],
    review:
      "지난주보다 카테고리가 한층 다양해졌어요. 특히 교육과 과학·기술 영상이 새로 늘어난 점이 인상적이에요. 큰 결심이 아니라 작은 선택들이 쌓이고 있다는 신호예요. 잘하고 계세요.",
  },
  {
    week: 3,
    label: "3주차",
    isBaseline: false,
    range: "6/15 – 6/21",
    videoCount: 69,
    sessionCount: 9,
    dist: dist({
      game: 0.29,
      edu: 0.18,
      music: 0.16,
      sci: 0.15,
      news: 0.12,
      ent: 0.1,
    }),
    daily: [2.41, 2.58, 2.52, 2.71, 2.63, 2.78, 2.69],
    review:
      "3주 동안 정말 꾸준히 해오셨어요. 시청 다양성이 기준선보다 눈에 띄게 높아졌고, 어느 한 카테고리에 치우치지 않는 균형이 보여요. 지금의 리듬을 가볍게 이어가시면 충분해요.",
  },
];
weeks.forEach((w) => {
  w.entropy = entropy(w.dist);
});
const baselineH = weeks[0].entropy;

const TIMELINE = {
  w1_mid: {
    label: "1주차 진행 중",
    day: 4,
    currentWeek: 1,
    surveyWeek: null,
    todayWeek: 1,
  },
  w1_end: {
    label: "1주차 종료 · 설문",
    day: 7,
    currentWeek: 1,
    surveyWeek: 1,
    todayWeek: 1,
  },
  w2_mid: {
    label: "2주차 진행 중",
    day: 11,
    currentWeek: 2,
    surveyWeek: null,
    todayWeek: 2,
  },
  w2_end: {
    label: "2주차 종료 · 설문",
    day: 14,
    currentWeek: 2,
    surveyWeek: 2,
    todayWeek: 2,
  },
  w3_mid: {
    label: "3주차 진행 중",
    day: 18,
    currentWeek: 3,
    surveyWeek: null,
    todayWeek: 3,
  },
  w3_end: {
    label: "3주차 종료 · 설문",
    day: 21,
    currentWeek: 3,
    surveyWeek: 3,
    todayWeek: 3,
  },
};
const TOTAL_DAYS = 21;

const GROUPS = {
  EXP: {
    code: "EXP",
    name: "실험군",
    feedback: true,
    note: "시청 분석과 피드백을 받습니다.",
  },
  CON: {
    code: "CON",
    name: "대조군",
    feedback: false,
    note: "실험 기간 중 피드백 제공 시점은 참여자마다 다를 수 있으며, 실험 종료 후 모든 참여자에게 결과를 공유합니다.",
  },
  "TEST-EXP": {
    code: "TEST-EXP",
    name: "연구자 (실험군)",
    feedback: true,
    note: "모든 화면을 미리 볼 수 있습니다.",
  },
  "TEST-CON": {
    code: "TEST-CON",
    name: "연구자 (대조군)",
    feedback: false,
    note: "모든 화면을 미리 볼 수 있습니다.",
  },
};

const TONES = {
  indigo: {
    label: "인디고 포커스",
    light: {
      "--vl-bg": "#f1f3f8",
      "--vl-card": "#ffffff",
      "--vl-card-2": "#f7f8fc",
      "--vl-ink": "#171a26",
      "--vl-ink-2": "#5a6173",
      "--vl-ink-3": "#9aa0b2",
      "--vl-line": "#e7eaf2",
      "--vl-line-2": "#dce0ec",
      "--vl-accent": "#4f46e5",
      "--vl-accent-2": "#4338ca",
      "--vl-accent-soft": "#eaeafc",
      "--vl-on-accent": "#ffffff",
      "--vl-good": "#0f9d6b",
      "--vl-warn": "#e08a1e",
    },
    dark: {
      "--vl-bg": "#0e1018",
      "--vl-card": "#171a26",
      "--vl-card-2": "#1f2230",
      "--vl-ink": "#eef0f7",
      "--vl-ink-2": "#a3a9bd",
      "--vl-ink-3": "#6b7188",
      "--vl-line": "#252a3a",
      "--vl-line-2": "#2f354a",
      "--vl-accent": "#818cf8",
      "--vl-accent-2": "#a5b4fc",
      "--vl-accent-soft": "#23263a",
      "--vl-on-accent": "#0e1018",
      "--vl-good": "#34d399",
      "--vl-warn": "#fbbf24",
    },
  },
};

window.VL = {
  CATS: VL_CATS,
  dist,
  entropy,
  H_MAX,
  today,
  weeks,
  baselineH,
  TIMELINE,
  TOTAL_DAYS,
  GROUPS,
  TONES,
  BASELINE_DAYS,
  isBaselinePeriod,
  isTestGroup,
  con: { todayCount: 12, totalCount: 47 },
};

// Studio stubs — viewlens-popup.js overrides these with real implementations in popup context
window.koreanDateLabel = function (d) {
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${days[d.getDay()]}요일`;
};
window.buildDataForDate = function () {
  return { ...VL.today };
};
