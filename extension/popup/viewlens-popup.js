const EXPERIMENT_DAYS = 21;

window.buildDataForDate = buildDataForDate;
window.koreanDateLabel = koreanDateLabel;
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

function buildDataForDate(allSessions, targetDate) {
  const todayStr = dateStr(targetDate);

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
      dateLabel: koreanDateLabel(targetDate),
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

  const sourceDate = targetDate;
  const sourceDateStr = dateStr(sourceDate);
  const distObj = mergeDist(sourceSessions);
  const distArr = VL.dist(distObj);
  const videoCount = sourceSessions.reduce(
    (s, sess) => s + (sess.videoCount ?? sess.videos?.length ?? 1),
    0,
  );
  const review =
    sourceSessions.at(-1)?.review ||
    "시청 패턴을 분석하고 있어요. 잠시 후 시청 분석이 업데이트돼요.";
  const reviewTopic = sourceSessions.at(-1)?.reviewTopic || "";

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

// participants 서버 등록 — 성공(200) 시에만 participantSynced 플래그를 저장한다.
// 실패하면 플래그를 세우지 않으므로 다음 팝업 boot에서 재시도된다(서버는 anonymousId UNIQUE로 멱등 처리).
async function syncParticipant(serverUrl, { anonymousId, group_code, installDate }) {
  if (!serverUrl || serverUrl.startsWith("YOUR_")) return;
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/api/participants`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anonymousId, group_code, installDate }),
    });
    if (!res.ok) {
      console.warn("[popup] participants 등록 실패:", res.status);
      return;
    }
    await chrome.storage.local.set({ participantSynced: true });
  } catch (error) {
    console.warn("[popup] participants 등록 오류:", error.message);
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
    "currentSession",
    "lastWatchedAt",
    "anonymousId",
    "serverUrl",
    "participantSynced",
  ]);

  // 이미 온보딩된 사용자 중 anonymousId가 없는 경우 생성
  if (stored.group && !stored.anonymousId) {
    stored.anonymousId = crypto.randomUUID();
    await chrome.storage.local.set({ anonymousId: stored.anonymousId });
  }

  // 온보딩은 됐지만 서버 등록이 확인되지 않은 경우 재시도(등록 누락 복구).
  // 팝업 렌더링을 막지 않도록 await 없이 백그라운드로 실행 — 실패 시 다음 boot에서 다시 재시도된다.
  if (stored.group && stored.anonymousId && stored.installDate && !stored.participantSynced) {
    syncParticipant(stored.serverUrl, {
      anonymousId: stored.anonymousId,
      group_code: stored.group,
      installDate: stored.installDate,
    });
  }

  const sessions = stored.sessions || [];
  const installDate = stored.installDate || null;
  const toneName = stored.tone || DEFAULT_TONE;
  const darkMode = !!stored.dark;

  // Inject real data into VL globals before popup renders
  const collectingCount = stored.currentSession?.videos?.length ?? 0;
  VL._allSessions = sessions;
  VL._installDate = installDate;
  VL._lastWatchedAt = stored.lastWatchedAt || null;

  const realToday = buildDataForDate(sessions, new Date());
  realToday.collectingCount = collectingCount;
  realToday.collectingTimer = _computeTimerText(stored.lastWatchedAt);
  VL.today = realToday;

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
        const installDate = new Date().toISOString();
        VL._installDate = installDate; // 온보딩 직후 첫 렌더부터 실제 경과일(1일째) 반영
        const { anonymousId: existing, serverUrl } =
          await chrome.storage.local.get(["anonymousId", "serverUrl"]);
        const anonymousId = existing || crypto.randomUUID();

        await chrome.storage.local.set({
          anonymousId,
          group: g,
          installDate,
          surveyStatus: { week1: false, week2: false, week3: false },
          participantSynced: false,
        });

        await syncParticipant(serverUrl, { anonymousId, group_code: g, installDate });
      } else if (!ob) {
        // 연구자 모드 — 온보딩 초기화 (세션 데이터는 유지)
        await chrome.storage.local.remove(['group', 'installDate', 'surveyStatus', 'participantSynced']);
        window.location.reload();
      }
    },
  });

  // 로컬 캐시 — storage.onChanged로 갱신, setInterval에서는 캐시만 읽음
  let localCurrentSession = stored.currentSession || null;
  let localLastWatchedAt = stored.lastWatchedAt || null;

  // sessions가 바뀌면(분석 완료, 리뷰 저장 등) 즉시 today 데이터를 갱신하고 re-render
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.currentSession) localCurrentSession = changes.currentSession.newValue || null;
    if (changes.lastWatchedAt) localLastWatchedAt = changes.lastWatchedAt.newValue || null;
    if (!changes.sessions) return;
    const updatedSessions = changes.sessions.newValue || [];
    VL._allSessions = updatedSessions;
    const freshToday = buildDataForDate(updatedSessions, new Date());
    freshToday.collectingCount = localCurrentSession?.videos?.length ?? 0;
    freshToday.collectingTimer = _computeTimerText(localLastWatchedAt);
    VL.today = freshToday;
    if (installDate) {
      VL.weeks = buildWeeksData(updatedSessions, installDate);
      VL.baselineH = VL.weeks[0]?.entropy ?? 0;
    }
    popup.render();
  });

  // 수집 중 표시 실시간 업데이트 (1초 간격) — 캐시된 로컬 변수만 참조
  let prevIsCollecting = collectingCount > 0 || !!realToday.collectingTimer;

  setInterval(() => {
    VL._lastWatchedAt = localLastWatchedAt;

    const count = localCurrentSession?.videos?.length ?? 0;
    const timerText = _computeTimerText(localLastWatchedAt);
    const isNowCollecting = count > 0 || !!timerText;

    if (isNowCollecting !== prevIsCollecting) {
      prevIsCollecting = isNowCollecting;
      VL.today = {
        ...VL.today,
        collectingCount: count,
        collectingTimer: timerText,
      };
      popup.render();
      return;
    }

    const countEl = document.getElementById("vl-collecting-count");
    const timerEl = document.getElementById("vl-collecting-timer");
    if (!countEl || !timerEl) return;

    countEl.textContent = count > 0 ? `영상 ${count}개 수집 중` : "분석 중...";
    timerEl.textContent =
      timerText || (localLastWatchedAt ? "피드백 생성 중..." : "");
  }, 1000);
}

const COLLECTING_TIMEOUT_MS = 10 * 60 * 1000;

function _computeTimerText(lastWatchedAt) {
  if (!lastWatchedAt) return "";
  const elapsed = Date.now() - new Date(lastWatchedAt).getTime();
  const remaining = Math.max(0, COLLECTING_TIMEOUT_MS - elapsed);
  if (remaining <= 0) return "";
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  return `피드백까지 ${mins}분 ${String(secs).padStart(2, "0")}초`;
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
