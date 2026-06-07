const EXPERIMENT_DAYS = 21;
const DEFAULT_TONE = "indigo";

// ── Category name (Korean) → VL short key ─────────────────────────────────────
const CAT_NAME_TO_KEY = {
  음악: "music",
  게임: "game",
  "뉴스 & 정치": "news",
  교육: "edu",
  "과학 & 기술": "sci",
  엔터테인먼트: "ent",
  스포츠: "sports",
  "인물 & 블로그": "vlog",
  "동영상 블로그": "vlog",
  코미디: "ent",
  "영화 & 애니메이션": "ent",
  영화: "ent",
  "노하우 & 스타일": "vlog",
  "비영리 & 사회운동": "news",
};

function toVlKey(catName) {
  return CAT_NAME_TO_KEY[catName] || "etc";
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function dateStr(d) {
  // 로컬 시간대 기준 YYYY-MM-DD
  return d.toLocaleDateString("sv");
}

function koreanDateLabel(d) {
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${days[d.getDay()]}요일`;
}

function koreanShortDate(d) {
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/** Returns YYYY-MM-DD string for day offset from installDate */
function dayFromInstall(installDate, offset) {
  const d = new Date(installDate);
  d.setDate(d.getDate() + offset);
  return dateStr(d);
}

// ── Distribution helpers ───────────────────────────────────────────────────────

/** Merge sessions into a single {vlKey: fraction} object */
function mergeDist(sessions) {
  const totalVids = sessions.reduce(
    (s, sess) => s + (sess.videoCount ?? sess.videos?.length ?? 1),
    0,
  );
  if (totalVids === 0) return {};
  const merged = {};
  for (const sess of sessions) {
    const w = (sess.videoCount ?? sess.videos?.length ?? 1) / totalVids;
    for (const [catName, ratio] of Object.entries(
      sess.categoryDistribution || {},
    )) {
      const k = toVlKey(catName);
      merged[k] = (merged[k] ?? 0) + ratio * w;
    }
  }
  // Normalise to sum=1 to fix floating-point drift
  const sum = Object.values(merged).reduce((a, b) => a + b, 0);
  if (sum > 0)
    Object.keys(merged).forEach((k) => {
      merged[k] = merged[k] / sum;
    });
  return merged;
}

/** Top VL key from a session's categoryDistribution */
function topKey(sess) {
  const dist = sess.categoryDistribution || {};
  const top = Object.entries(dist).sort(([, a], [, b]) => b - a)[0];
  return top ? toVlKey(top[0]) : "etc";
}

// ── Build VL.today ────────────────────────────────────────────────────────────

function buildTodayData(allSessions) {
  const todayStr = dateStr(new Date());

  const todaySess = allSessions.filter(
    (s) =>
      s.endTime &&
      dateStr(new Date(s.endTime)) === todayStr &&
      s.categoryDistribution &&
      Object.keys(s.categoryDistribution).length > 0,
  );

  if (todaySess.length === 0) {
    return {
      isEmpty: true,
      dateLabel: koreanDateLabel(new Date()),
      videoCount: 0,
      sessionCount: 0,
      dist: [],
      prevEntropy: 0,
      prevDateLabel: "—",
      videos: [],
      review: "",
    };
  }

  const sourceSessions = todaySess;

  const sourceDate = new Date(sourceSessions[0].endTime);
  const sourceDateStr = dateStr(sourceDate);
  const distObj = mergeDist(sourceSessions);
  const distArr = VL.dist(distObj);
  const videoCount = sourceSessions.reduce(
    (s, sess) => s + (sess.videoCount ?? sess.videos?.length ?? 1),
    0,
  );
  const review =
    sourceSessions.at(-1)?.review ||
    "시청 패턴을 분석하고 있어요. 잠시 후 코치 노트가 업데이트돼요.";
  const reviewTopic = sourceSessions.at(-1)?.reviewTopic || '';

  const videos = sourceSessions
    .flatMap((sess) => {
      const cat = topKey(sess);
      return (sess.videos || []).map((v) => ({
        title: v.title,
        cat,
        videoId: v.videoId || null,
      }));
    })
    .slice(0, 9);

  // Previous available day entropy
  const prevSessions = allSessions
    .filter(
      (s) =>
        s.endTime &&
        dateStr(new Date(s.endTime)) !== sourceDateStr &&
        new Date(s.endTime) < sourceDate &&
        s.categoryDistribution &&
        Object.keys(s.categoryDistribution).length > 0,
    )
    .sort((a, b) => new Date(b.endTime) - new Date(a.endTime));

  let prevEntropy = 0;
  let prevDateLabel = "—";
  if (prevSessions.length > 0) {
    const prevDate = new Date(prevSessions[0].endTime);
    const prevDateStr = dateStr(prevDate);
    const prevDay = prevSessions.filter(
      (s) => dateStr(new Date(s.endTime)) === prevDateStr,
    );
    const prevDist = mergeDist(prevDay);
    prevEntropy = VL.entropy(VL.dist(prevDist));
    prevDateLabel = koreanShortDate(prevDate);
  }

  return {
    dateLabel: koreanDateLabel(sourceDate),
    videoCount,
    sessionCount: sourceSessions.length,
    dist: distArr,
    prevEntropy,
    prevDateLabel,
    videos,
    review,
    reviewTopic,
  };
}

// ── Build VL.weeks ────────────────────────────────────────────────────────────

function buildWeeksData(allSessions, installDate) {
  const analyzedSessions = allSessions.filter(
    (s) =>
      s.endTime &&
      s.categoryDistribution &&
      Object.keys(s.categoryDistribution).length > 0,
  );

  const weeks = [];

  for (let w = 1; w <= 3; w++) {
    const startOffset = (w - 1) * 7; // day offset from install
    const endOffset = w * 7 - 1;

    const weekStart = dayFromInstall(installDate, startOffset);
    const weekEnd = dayFromInstall(installDate, endOffset);

    const weekSessions = analyzedSessions.filter((s) => {
      const d = dateStr(new Date(s.endTime));
      return d >= weekStart && d <= weekEnd;
    });

    // Daily entropy (7 values — 0 if no data that day)
    const daily = [];
    for (let d = 0; d < 7; d++) {
      const dayKey = dayFromInstall(installDate, startOffset + d);
      const daySess = weekSessions.filter(
        (s) => dateStr(new Date(s.endTime)) === dayKey,
      );
      const dayDist = mergeDist(daySess);
      const dayDistArr =
        Object.keys(dayDist).length > 0 ? VL.dist(dayDist) : [];
      daily.push(dayDistArr.length > 0 ? VL.entropy(dayDistArr) : 0);
    }

    // Weekly aggregate
    const weekDist = mergeDist(weekSessions);
    const weekDistArr =
      Object.keys(weekDist).length > 0
        ? VL.dist(weekDist)
        : VL.dist({ etc: 1 });

    // Range label
    const startD = new Date(installDate);
    startD.setDate(startD.getDate() + startOffset);
    const endD = new Date(installDate);
    endD.setDate(endD.getDate() + endOffset);
    const range = `${startD.getMonth() + 1}/${startD.getDate()} – ${endD.getMonth() + 1}/${endD.getDate()}`;

    // Review: latest session's review in this week
    const review =
      weekSessions.at(-1)?.review ||
      (w === 1
        ? "첫 주 동안의 시청 습관을 기준선으로 담아 두었어요. 이건 평가가 아니라 출발점이에요."
        : "이번 주 데이터를 분석 중이에요. 세션이 쌓이면 더 자세한 리포트를 볼 수 있어요.");

    const totalVids = weekSessions.reduce(
      (s, sess) => s + (sess.videoCount ?? sess.videos?.length ?? 1),
      0,
    );

    weeks.push({
      week: w,
      label: `${w}주차`,
      isBaseline: w === 1,
      range,
      videoCount: totalVids,
      sessionCount: weekSessions.length,
      dist: weekDistArr,
      daily,
      review,
    });
  }

  weeks.forEach((wk) => {
    wk.entropy = VL.entropy(wk.dist);
  });
  return weeks;
}

// ── Token application ─────────────────────────────────────────────────────────

function applyTokens(el, toneName, dark) {
  const tone = VL.TONES[toneName] || VL.TONES.indigo;
  const tokens = dark ? tone.dark : tone.light;
  Object.entries(tokens).forEach(([k, v]) => el.style.setProperty(k, v));
  el.style.background = tokens["--vl-bg"];
}

// ── Timeline key from install date ────────────────────────────────────────────

function calcTimelineKey(installDate) {
  if (!installDate) return "w1_mid";
  const days = Math.max(
    1,
    Math.floor((Date.now() - new Date(installDate).getTime()) / 86400000) + 1,
  );
  if (days >= 21) return "w3_end";
  if (days >= 18) return "w3_mid";
  if (days >= 14) return "w2_end";
  if (days >= 11) return "w2_mid";
  if (days >= 7) return "w1_end";
  return "w1_mid";
}

// ── Survey status helpers ─────────────────────────────────────────────────────

function storageToCompleted(surveyStatus) {
  if (!surveyStatus) return {};
  return {
    ...(surveyStatus.week1 ? { 1: true } : {}),
    ...(surveyStatus.week2 ? { 2: true } : {}),
    ...(surveyStatus.week3 ? { 3: true } : {}),
  };
}

async function markWeekComplete(week) {
  const key = `week${week}`;
  const { surveyStatus } = await chrome.storage.local.get("surveyStatus");
  const updated = {
    week1: false,
    week2: false,
    week3: false,
    ...(surveyStatus || {}),
    [key]: true,
  };
  await chrome.storage.local.set({ surveyStatus: updated });
}

// ── RealPopup: persists survey to storage ─────────────────────────────────────

class RealPopup extends ViewLensPopup {
  constructor(container, surveyStatus) {
    super(container);
    this._completed = storageToCompleted(surveyStatus);
  }

  _bind(groupCfg, surveyWeek, surveyPending, currentWeek) {
    super._bind(groupCfg, surveyWeek, surveyPending, currentWeek);
    const doneBtn = this.container.querySelector("#vl-survey-done");
    if (doneBtn && surveyWeek != null) {
      doneBtn.addEventListener("click", () => markWeekComplete(surveyWeek));
    }
  }
}

// ── Main boot ─────────────────────────────────────────────────────────────────

async function boot() {
  const stored = await chrome.storage.local.get([
    "group",
    "installDate",
    "surveyStatus",
    "sessions",
    "tone",
    "dark",
  ]);

  const sessions = stored.sessions || [];
  const installDate = stored.installDate || null;
  const toneName = stored.tone || DEFAULT_TONE;
  const darkMode = !!stored.dark;

  // Inject real data into VL globals before popup renders
  const realToday = buildTodayData(sessions);
  if (realToday) VL.today = realToday;

  if (installDate) {
    VL.weeks = buildWeeksData(sessions, installDate);
    VL.baselineH = VL.weeks[0]?.entropy ?? 0;
  }

  // Apply theme tokens
  const popEl = document.getElementById("vl-popup-root");
  applyTokens(popEl, toneName, darkMode);

  // Mount popup
  const popup = new RealPopup(popEl, stored.surveyStatus);
  popup.mount({
    onboarded: !!stored.group,
    group: stored.group || null,
    timelineKey: calcTimelineKey(installDate),
    onChange: async ({ onboarded: ob, group: g }) => {
      if (ob && g) {
        await chrome.storage.local.set({
          group: g,
          installDate: new Date().toISOString(),
          surveyStatus: { week1: false, week2: false, week3: false },
        });
      }
    },
  });
}

boot().catch((err) => {
  // Fallback: opened directly in browser without chrome APIs
  if (typeof chrome === "undefined" || !chrome?.storage) {
    const popEl = document.getElementById("vl-popup-root");
    applyTokens(popEl, DEFAULT_TONE, false);
    const popup = new ViewLensPopup(popEl);
    popup.mount({
      onboarded: false,
      group: null,
      timelineKey: "w1_mid",
      onChange: () => {},
    });
  } else {
    console.error("[ViewLens popup] boot error:", err);
  }
});
