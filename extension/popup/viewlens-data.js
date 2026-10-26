const VL_CATS = {
  게임: { name: "게임", color: "oklch(0.77 0.085 32)" },
  음악: { name: "음악", color: "oklch(0.86 0.085 300)" },
  엔터테인먼트: { name: "엔터테인먼트", color: "oklch(0.86 0.085 342)" },
  "뉴스 & 정치": { name: "뉴스 & 정치", color: "oklch(0.86 0.085 248)" },
  교육: { name: "교육", color: "oklch(0.86 0.085 152)" },
  "과학 & 기술": { name: "과학 & 기술", color: "oklch(0.86 0.085 205)" },
  스포츠: { name: "스포츠", color: "oklch(0.77 0.085 78)" },
  "인물 & 블로그": { name: "인물 & 블로그", color: "oklch(0.77 0.085 120)" },
  "영화 & 애니메이션": {
    name: "영화 & 애니메이션",
    color: "oklch(0.77 0.085 325)",
  },
  "자동차 & 차량": { name: "자동차 & 차량", color: "oklch(0.77 0.085 226)" },
  "애완동물 & 동물": {
    name: "애완동물 & 동물",
    color: "oklch(0.86 0.085 100)",
  },
  "여행 & 이벤트": { name: "여행 & 이벤트", color: "oklch(0.77 0.085 178)" },
  코미디: { name: "코미디", color: "oklch(0.86 0.085 55)" },
  "노하우 & 스타일": {
    name: "노하우 & 스타일",
    color: "oklch(0.77 0.085 274)",
  },
  "비영리 & 사회운동": {
    name: "비영리 & 사회운동",
    color: "oklch(0.84 0.10 18)",
  },
  기타: { name: "기타", color: "oklch(0.62 0.02 250)" },
};

// ── 서버 집계(/api/viewing-summary) → 화면 값 ──────────────────────────────────
// 꺾은선의 "그 밖" 선(상위 3개 분야 밖의 합)
const OTHERS_LINE = {
  key: "__others",
  name: "그 밖",
  // "기타" 분야(회색)와 구분되는 중립색
  color: "var(--vl-ink-2)",
};

// 서버와 같은 반올림
const percentOf = (p) => Math.round(p * 100);

/** 서버 비중 {분야 이름: 비율} → [{ key, name, color, p }] (비중 큰 순) */
function serverDist(distribution) {
  return Object.entries(distribution || {})
    .map(([name, p]) => ({
      key: name,
      name,
      color: (VL_CATS[name] || VL_CATS.기타).color,
      p,
    }))
    .sort((a, b) => b.p - a.p);
}

/** measure 값이 가장 큰 분야 이름들(동점이면 여럿, 이름 순) */
function topCategoryNames(distArr, measure = (d) => percentOf(d.p)) {
  if (distArr.length === 0) return [];
  const max = Math.max(...distArr.map(measure));
  return distArr
    .filter((d) => measure(d) === max)
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * 탭 맨 위 제목과 보조 줄. 줄마다 [{ text, strong }] 조각(분야명만 strong).
 * 시간 1위는 반올림 퍼센트로, 영상 수 1위는 실제 개수(비율 × chartCount 반올림)로 정한다.
 * 보조 줄은 두 1위 묶음이 다를 때만.
 * @returns {{title: Array<{text: string, strong: boolean}>, sub: Array<{text: string, strong: boolean}>|null}|null}
 *   분포가 비어 있으면 null
 */
function titleSentence(timeDist, countDist, chartCount = 0) {
  const time = topCategoryNames(timeDist).join("·");
  // chartCount가 없으면 개수를 되살릴 수 없어 반올림 퍼센트로 정한다
  const countOf = (d) => Math.round(d.p * chartCount);
  const countNames = topCategoryNames(
    countDist,
    chartCount > 0 ? countOf : undefined,
  );
  const count = countNames.join("·");
  if (!time || !count) return null;
  const watched = (names) => [
    { text: names, strong: true },
    { text: " 영상을 가장 많이 봤어요", strong: false },
  ];
  if (time === count) return { title: watched(count), sub: null };
  const sub = watched(count);
  const n = chartCount > 0 ? countOf(countDist[0]) : 0;
  if (n > 0)
    sub.push({
      text: ` (${n}개${countNames.length > 1 ? "씩" : ""})`,
      strong: false,
    });
  return {
    title: [
      { text: time, strong: true },
      { text: "에 시간을 가장 많이 썼어요", strong: false },
    ],
    sub,
  };
}

/**
 * 하루치 서버 값을 화면 값으로. 기록이 없는 날(day가 없음)은 0으로 채운다.
 * @param {object|undefined} day - viewing-summary days[] 항목
 */
function dayView(day) {
  const timeDist = serverDist(day?.timeDistribution);
  const countDist = serverDist(day?.countDistribution);
  return {
    // 화면 "영상 N개" — 시청 시간이 확인된 유효 영상(리뷰와 같은 기준)
    confirmedCount: day?.confirmedCount ?? 0,
    unconfirmedCount: day?.unconfirmedCount ?? 0,
    shortCount: day?.shortCount ?? 0,
    // 도넛 두 개는 같은 영상 묶음(시청 시간을 알고 분야가 있는 유효 영상)
    chartCount: day?.chartCount ?? 0,
    chartSeconds: day?.chartSeconds ?? 0,
    // "영상 N개"와 도넛 개수의 차이 — 시청 시간은 확인됐지만 분야를 못 가져온 영상
    uncategorizedConfirmedCount: Math.max(
      0,
      (day?.confirmedCount ?? 0) - (day?.chartCount ?? 0),
    ),
    timeDist,
    countDist,
    title: titleSentence(timeDist, countDist, day?.chartCount ?? 0),
    // 영상 목록에 거의 안 봄·확인 중·분야 미확인을 붙이는 데 쓴다
    excludedReasons: Object.fromEntries(
      (day?.excluded || []).map((e) => [e.eventId, e.reason]),
    ),
    // 영상 목록 제목 — 기록한 제목과 다른 YouTube 메타데이터 제목(eventId → 제목)
    correctedTitles: day?.correctedTitles ?? {},
  };
}

/** 초 → "1시간 30분" / "45분" / "1분 미만" */
function formatDuration(seconds) {
  const minutes = Math.round((seconds || 0) / 60);
  if (minutes < 1) return "1분 미만";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}분`;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

/**
 * 오늘 탭 도넛 두 개(시청 시간 / 영상 개수)의 조각. 조각마다 툴팁 문구를 붙인다.
 * 분야별 시간·개수는 합계 × 비중으로 되살린다(서버는 비중과 합계만 준다).
 * @param {ReturnType<typeof dayView>} view
 */
function donutPair(view) {
  return {
    time: view.timeDist.map((d) => ({
      ...d,
      tip: `${d.name} ${percentOf(d.p)}% · ${formatDuration(d.p * (view.chartSeconds || 0))}`,
    })),
    count: view.countDist.map((d) => ({
      ...d,
      tip: `${d.name} ${percentOf(d.p)}% · ${Math.round(d.p * view.chartCount)}개`,
    })),
  };
}

/** KST(Asia/Seoul) 기준 YYYY-MM-DD */
function kstDate(date) {
  return date.toLocaleDateString("sv", { timeZone: "Asia/Seoul" });
}

// 서버가 영상별로 알려 준 "그래프에서 뺀 사유" → 목록 표시
const PLAYED_VIDEO_MARKS = {
  short: "거의 안 봄",
  uncategorized: "분야 미확인",
  pending_time: "확인 중",
  unconfirmed: "시청 시간 미확인",
};

// 어디서도 제목을 못 구한 영상의 표시
const UNKNOWN_VIDEO_TITLE = "제목 없음";

const nonEmpty = (s) => (typeof s === "string" && s.trim() ? s : null);

/**
 * 영상 목록에 보여 줄 제목. 서버 메타데이터 제목 → 기록한 제목 → oEmbed로 받아 둔 제목 순.
 * 기록한 제목은 탭 제목을 읽어 다른 영상 것이 붙었을 수 있어 서버 제목을 먼저 쓴다.
 */
function videoTitle(v, { correctedTitles = {}, fetchedTitles = {} } = {}) {
  return (
    nonEmpty(v.eventId ? correctedTitles[v.eventId] : null) ??
    nonEmpty(v.title) ??
    nonEmpty(v.videoId ? fetchedTitles[v.videoId] : null) ??
    UNKNOWN_VIDEO_TITLE
  );
}

/**
 * 그날 재생한 영상 목록
 * 끝난 세션과 진행 중인 세션의 영상 기록을 모두 모아 본 시각 순으로.
 * @param {Array<{videos?: Array}>} sessions - 끝난 세션들
 * @param {Array<object>} liveVideos - 진행 중인 세션의 영상 기록(video__ 키)
 * @param {string} dateKey - YYYY-MM-DD(KST)
 * @param {Record<string, string>} reasons - eventId → 서버 사유(VL.dayView().excludedReasons)
 * @param {{correctedTitles?: Record<string, string>, fetchedTitles?: Record<string, string|null>}} [titles]
 *   서버 메타데이터 제목(eventId →, VL.dayView().correctedTitles)·oEmbed 제목(videoId →)
 * @returns {Array<{title: string, videoId: string|null, eventId: string|null, mark: string|null}>}
 */
function playedVideos(
  sessions,
  liveVideos,
  dateKey,
  reasons = {},
  titles = {},
) {
  const all = [
    ...(sessions || []).flatMap((s) => s.videos || []),
    ...(liveVideos || []),
  ];
  const seen = new Set();
  const noTimeMark =
    dateKey === kstDate(new Date())
      ? PLAYED_VIDEO_MARKS.pending_time
      : PLAYED_VIDEO_MARKS.unconfirmed;
  return all
    .filter((v) => {
      const ms = Date.parse(v.watchedAt);
      if (!Number.isFinite(ms) || kstDate(new Date(ms)) !== dateKey)
        return false;
      // 세션 종료 직전·직후에 같은 영상 기록이 두 곳에 잠깐 함께 있을 수 있다
      if (v.eventId) {
        if (seen.has(v.eventId)) return false;
        seen.add(v.eventId);
      }
      return true;
    })
    .sort((a, b) => Date.parse(a.watchedAt) - Date.parse(b.watchedAt))
    .map((v) => {
      const reason = v.eventId ? reasons[v.eventId] : undefined;
      const mark =
        reason === "short" || reason === "uncategorized"
          ? PLAYED_VIDEO_MARKS[reason]
          : v.watchedSeconds == null || reason === "pending_time"
            ? noTimeMark
            : null;
      return {
        title: videoTitle(v, titles),
        videoId: v.videoId || null,
        eventId: v.eventId || null,
        mark,
      };
    });
}

/**
 * 리뷰 카드의 "기준" 시각
 * @returns {string} "14:32 기준" / "10/16 00:31 기준" / 값이 없으면 ""
 */
function reviewAsOfLabel(generatedAt, reviewDate) {
  const ms = Date.parse(generatedAt);
  if (!Number.isFinite(ms)) return "";
  const at = new Date(ms);
  const time = at.toLocaleTimeString("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
  });
  const day = kstDate(at);
  if (day === reviewDate) return `${time} 기준`;
  const [, m, d] = day.split("-").map(Number);
  return `${m}/${d} ${time} 기준`;
}

/** "YYYY-MM-DD" 범위의 모든 날짜 */
function datesInRange(start, end) {
  const dates = [];
  const [y, m, d] = start.split("-").map(Number);
  for (let i = 0; ; i++) {
    const date = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
    if (date > end) break;
    dates.push(date);
  }
  return dates;
}

/**
 * 기간 탭 꺾은선 데이터 — 선은 구간 시청 시간 상위 3개 분야(+ 분야가 더 있으면 "그 밖").
 * 기록 없는 날은 모든 선 0%. 오늘 이후 날짜는 그리지 않는다.
 * @param {object} period - viewing-summary periods[] 항목 { start, end, timeDistribution, ... }
 * @param {Array<object>} days - viewing-summary days[]
 * @param {string} today - 오늘 KST 날짜(YYYY-MM-DD)
 */
function periodLines(period, days, today) {
  const ranked = serverDist(period.timeDistribution);
  const top = ranked.slice(0, 3);
  const lines = [
    ...top.map(({ key, name, color }) => ({ key, name, color })),
    ...(ranked.length > 3 ? [OTHERS_LINE] : []),
  ];
  const byDate = new Map((days || []).map((d) => [d.date, d]));
  const points = datesInRange(period.start, period.end)
    .filter((date) => date <= today)
    .map((date) => {
      const day = byDate.get(date);
      const shares = day?.timeDistribution || {};
      const hasChart = Object.keys(shares).length > 0;
      const values = Object.fromEntries(
        top.map(({ key }) => [key, percentOf(shares[key] ?? 0)]),
      );
      if (ranked.length > 3) {
        const othersShare = Object.entries(shares)
          .filter(([name]) => !top.some((t) => t.key === name))
          .reduce((sum, [, p]) => sum + p, 0);
        values[OTHERS_LINE.key] = percentOf(othersShare);
      }
      return {
        date,
        values,
        // 그래프에 그릴 비중이 없는 날
        noRecord: !hasChart,
        // 오늘 — 점선 + "집계 중"
        isToday: date === today,
      };
    });
  return { lines, points };
}

// 서버가 fallback 기간 리뷰를 다시 만드는 일수(구간 끝난 날 기준). server/pipeline/study-constants.js와 같은 값
const FALLBACK_RETRY_WINDOW_DAYS = 3;

// 베이스라인 기간(설치 후 BASELINE_DAYS 미만) 판정
// 팝업/Studio는 classic script라 ESM import를 쓸 수 없어(background.js는 type=module) 로직을 중복 정의한다.
const BASELINE_DAYS = 4;
function isBaselinePeriod(installDate, now = new Date()) {
  if (!installDate) return true;
  return (
    (now.getTime() - new Date(installDate).getTime()) / 86400000 < BASELINE_DAYS
  );
}

// TEST-EXP/TEST-CON(연구자 모드)는 "모든 화면을 미리 볼 수 있다"는 설계 의도(GROUPS 주석 참고)가
// 있어, 실제 참여자 온보딩과 무관하게 베이스라인 게이트를 적용하면 안 된다.
// background.js의 isTestGroup()과 동일 규칙 — 모듈 경계 때문에 중복 정의한다.
function isTestGroup(group) {
  return typeof group === "string" && group.startsWith("TEST");
}

const today = {
  dateLabel: "6월 7일 토요일",
  videos: [
    { title: "2024 LCK 서머 결승 풀 하이라이트" },
    { title: "발로란트 신규 요원 200% 활용 공략" },
    { title: "랭크 올리는 정글 동선 완전정복" },
    { title: "아이유 신곡 'Love Wins All' MV" },
    { title: "백예린 〈square〉 라이브 클립" },
    { title: "연예대상 레전드 무대 모음.zip" },
    { title: "[속보] 오늘의 주요 뉴스 브리핑" },
    { title: "10분 만에 끝내는 미적분 핵심 개념" },
    { title: "블랙홀은 정말 모든 걸 삼킬까? (다큐)" },
  ],
  review:
    "오늘은 게임 영상에 가장 오래 머무셨어요 — 특히 LCK 결승 하이라이트나 발로란트 공략처럼 e스포츠·경쟁 게임 쪽이 절반 가까이를 차지했네요. 음악은 아이유 신곡 MV나 라이브 클립 같은 최신 발매곡 위주였고요. 중간에 블랙홀 다큐와 미적분 개념 같은 과학·교육 영상도 함께 보셨어요.",
  // Studio 미리보기용 서버 집계 예시(실제 팝업은 /api/viewing-summary 값으로 덮어쓴다)
  view: dayView({
    confirmedCount: 13,
    unconfirmedCount: 1,
    shortCount: 2,
    chartCount: 12,
    chartSeconds: 9000,
    timeDistribution: {
      게임: 0.45,
      음악: 0.2,
      엔터테인먼트: 0.15,
      "뉴스 & 정치": 0.1,
      교육: 0.06,
      "과학 & 기술": 0.04,
    },
    countDistribution: {
      게임: 0.34,
      음악: 0.25,
      엔터테인먼트: 0.17,
      "뉴스 & 정치": 0.08,
      교육: 0.08,
      "과학 & 기술": 0.08,
    },
  }),
};

const weeks = [
  {
    week: 1,
    label: "1주차",
    range: "6/1 – 6/7",
    review:
      "첫 주 동안의 시청 습관을 기준선으로 담아 두었어요. 게임이 절반 가까이를 차지했지만, 이건 평가가 아니라 출발점이에요. 다음 주부터 어떤 변화가 생기는지 저와 함께 천천히 지켜봐요.",
  },
  {
    week: 2,
    label: "2주차",
    range: "6/8 – 6/14",
    review:
      "베이스라인 기간의 두 번째 주예요. 교육과 과학·기술 영상이 조금 늘었지만, 이 시기는 평가가 아니라 계속 기준선을 담아 두는 과정이에요.",
  },
  {
    week: 3,
    label: "3주차",
    range: "6/15 – 6/21",
    review:
      "3주 동안 정말 꾸준히 해오셨어요. 시청 다양성이 기준선보다 눈에 띄게 높아졌고, 어느 한 카테고리에 치우치지 않는 균형이 보여요. 지금의 리듬을 가볍게 이어가시면 충분해요.",
  },
];
// 총 실험 기간 12일(베이스라인 4일 + 4일씩 2개 기간)
const TOTAL_DAYS = 12;
// 탭을 며칠 단위로 나눌지 — 4일 단위로 기간을 구분한다.
const DAYS_PER_PERIOD = 4;
const TOTAL_WEEKS = Math.ceil(TOTAL_DAYS / DAYS_PER_PERIOD);

// 연구 기간 표기
function studyDurationLabel(totalDays = TOTAL_DAYS) {
  return totalDays % 7 === 0 ? `${totalDays / 7}주간` : `${totalDays}일간`;
}

function periodLabel(n) {
  if (DAYS_PER_PERIOD === 1) return `${n}일차`;
  if (DAYS_PER_PERIOD === 7) return `${n}주차`;
  return `${n}구간`;
}

// Studio "실험 시점" 프리셋 — TOTAL_DAYS/DAYS_PER_PERIOD로부터 매 기간의 "진행 중"/"종료"
// 체크포인트를 동적으로 생성한다. 예전엔 이걸 12개 통째로 하드코딩해뒀는데, 본조사(42일)
// 기준값이라 파일럿(6일)으로 바꿀 때마다 따로 손대야 했다(실제 화면엔 영향 없지만 Studio
// 프리뷰만 안 맞는 문제). 실제 화면 상수를 그대로 따라가게 만들어
// 이 동기화 문제 자체를 없앤다.
function buildTimeline() {
  const entries = {};
  for (let p = 1; p <= TOTAL_WEEKS; p++) {
    const startDay = (p - 1) * DAYS_PER_PERIOD + 1;
    const endDay = p * DAYS_PER_PERIOD;
    const midDay = startDay + Math.floor((DAYS_PER_PERIOD - 1) / 2);
    const label = periodLabel(p);
    entries[`w${p}_mid`] = { label: `${label} 진행 중`, day: midDay };
    entries[`w${p}_end`] = {
      label: p === TOTAL_WEEKS ? `${label} 종료 · 연구 종료` : `${label} 종료`,
      day: endDay,
    };
  }
  return entries;
}
const TIMELINE = buildTimeline();

// 대조군(CON, TEST-CON) 판별
const CONTROL_GROUP_CODES = new Set(["CON", "TEST-CON"]);
function isConGroup(code) {
  return CONTROL_GROUP_CODES.has(code);
}

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
      // 다크 모드 보조 글자 — 작은 글씨도 카드 위에서 잘 읽히도록 대비를 높였다(약 10:1, 6.7:1)
      "--vl-ink-2": "#c3c8d8",
      "--vl-ink-3": "#9aa0b6",
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
  serverDist,
  titleSentence,
  dayView,
  periodLines,
  formatDuration,
  donutPair,
  playedVideos,
  UNKNOWN_VIDEO_TITLE,
  reviewAsOfLabel,
  today,
  weeks,
  TIMELINE,
  TOTAL_DAYS,
  DAYS_PER_PERIOD,
  TOTAL_WEEKS,
  periodLabel,
  studyDurationLabel,
  GROUPS,
  TONES,
  BASELINE_DAYS,
  FALLBACK_RETRY_WINDOW_DAYS,
  isBaselinePeriod,
  isTestGroup,
  isConGroup,
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
