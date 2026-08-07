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
  // "피드백 확인하기" 블러 해제 버튼이 어느 세션을 확인 처리할지 알아야 해서 함께 넘긴다.
  const sessionId = sourceSessions.at(-1)?.sessionId ?? null;

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
    sessionId,
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

  // _isFeedbackActive는 오버라이드하지 않는다 — 베이스라인 게이트는 ViewLensPopup 기본 구현
  // 하나로 통일해, Studio 프리뷰와 실제 팝업이 항상 같은 규칙을 따르게 한다(viewlens-app.js 참고).

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
async function syncParticipant(
  serverUrl,
  { anonymousId, participantCode, group_code, installDate },
) {
  if (!serverUrl || serverUrl.startsWith("YOUR_")) return;
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/participants`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anonymousId,
          participantCode,
          group_code,
          installDate,
        }),
      },
    );
    if (!res.ok) {
      console.warn("[popup] participants 등록 실패:", res.status);
      return;
    }
    await chrome.storage.local.set({ participantSynced: true });
  } catch (error) {
    console.warn("[popup] participants 등록 오류:", error.message);
  }
}

// 온보딩 코드 서버 검증 — 발급 명단(issued_codes)과 대조 (등록 없이 확인만).
// 반환: { ok:true, group } 통과 / { ok:false } 미발급 / 오류·오프라인·서버미설정 시 { ok:true } 폴백 통과
async function validateParticipantCode(code) {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  if (!serverUrl || serverUrl.startsWith("YOUR_")) return { ok: true };
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/participants/validate?code=${encodeURIComponent(code)}`,
    );
    if (!res.ok) return { ok: true }; // 서버 오류 → 폴백 통과
    const json = await res.json();
    const data = json.data ?? json;
    if (data.valid === false) return { ok: false };
    return { ok: true, group: data.group_code || null };
  } catch {
    return { ok: true }; // 네트워크 오류 → 폴백 통과
  }
}
window.validateParticipantCode = validateParticipantCode;

// ── 팝업 상호작용 마이크로 로그 ────────────────────────────────────────
// 수집: openedAt, dwellMs, tabTodayClicks, tabWeekClicks, feedbackViewed.
// 전송: 팝업 close 시점의 storage 쓰기는 teardown에 잘릴 수 있어 신뢰하지 않는다.
//   대신 세션 중 livePopupEvent 슬롯을 상호작용·1초 간격으로 계속 갱신해 최신 스냅샷을 남기고,
//   다음 팝업 open(boot) 때 이전 스냅샷을 확정 큐로 승격해 서버로 전송(실패분은 큐에 남겨 재시도).
//   팝업은 싱글턴이라 boot 시점의 잔여 livePopupEvent는 곧 "닫힌 이전 팝업"의 확정 이벤트다.
//   sendBeacon을 쓰지 않으므로 중복 전송이 없다(전송은 항상 다음 open의 flush 한 경로).

// 실제 LLM 리뷰인지(플레이스홀더·빈 값 제외) — feedbackViewed 판정용
const POPUP_PLACEHOLDER_REVIEWS = new Set([
  "시청 패턴을 분석하고 있어요. 잠시 후 시청 분석이 업데이트돼요.",
]);
function isRealReview(text) {
  return (
    typeof text === "string" &&
    text.trim() !== "" &&
    !POPUP_PLACEHOLDER_REVIEWS.has(text.trim())
  );
}

// "피드백 확인하기" 블러 해제 여부 () — 한 번 확인한 세션은 로컬에 기억해 다음에
// 다시 팝업을 열어도 또 가리지 않는다. feedbackViewedAt(알림 클릭)보다 엄격한 별도 신호.
async function isFeedbackConfirmed(sessionId) {
  if (!sessionId) return false;
  const { confirmedFeedbackSessionIds = [] } = await chrome.storage.local.get(
    "confirmedFeedbackSessionIds",
  );
  return confirmedFeedbackSessionIds.includes(sessionId);
}

async function markFeedbackConfirmedLocally(sessionId) {
  const { confirmedFeedbackSessionIds = [] } = await chrome.storage.local.get(
    "confirmedFeedbackSessionIds",
  );
  if (confirmedFeedbackSessionIds.includes(sessionId)) return;
  await chrome.storage.local.set({
    confirmedFeedbackSessionIds: [...confirmedFeedbackSessionIds, sessionId],
  });
}

// 서버에 feedbackConfirmedAt 기록 — 실패해도 로컬 확인 상태(위)는 이미 반영돼 있어
// 사용자 경험에는 영향 없고, 연구 데이터 쪽만 유실될 수 있다(다른 서버 전송들과 동일한 정책).
async function postFeedbackConfirmed(sessionId) {
  const { serverUrl, anonymousId } = await chrome.storage.local.get([
    "serverUrl",
    "anonymousId",
  ]);
  if (!serverUrl || serverUrl.startsWith("YOUR_") || !anonymousId) return;
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(sessionId)}/feedback-confirmed`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anonymousId }),
      },
    );
    if (!res.ok) console.warn("[popup] 피드백 확인 기록 실패:", res.status);
  } catch (error) {
    console.warn("[popup] 피드백 확인 기록 오류:", error.message);
  }
}

// "피드백 확인하기" 버튼 클릭 처리 — 로컬 확인 상태 저장, 블러 해제 재렌더링,
// 아이콘 점 제거, 서버 기록을 한 번에 묶는다.
async function handleFeedbackConfirmClick(popup, sessionId) {
  if (!sessionId) return;
  await markFeedbackConfirmedLocally(sessionId);
  VL._todayConfirmed = true;
  clearUnviewedIconDot();
  popup.render();
  // render()가 innerHTML을 통째로 교체하면서 스크롤이 맨 위로 리셋되므로 즉시 복원한다.
  requestAnimationFrame(() => {
    document
      .getElementById("vl-review-card")
      ?.scrollIntoView({ block: "start" });
  });
  postFeedbackConfirmed(sessionId);
}

function buildPopupEventPayload(m) {
  return {
    eventId: m.eventId,
    anonymousId: m.anonymousId,
    dwellMs: Math.max(0, Date.now() - m.startTs),
    tabTodayClicks: m.tabTodayClicks,
    tabWeekClicks: m.tabWeekClicks,
    feedbackViewed: m.feedbackViewed,
    openedAt: m.openedAt,
  };
}

// teardown 대비 — 현재 세션 스냅샷을 live 슬롯에 기록(fire-and-forget)
function persistLivePopupEvent(m) {
  chrome.storage.local.set({ livePopupEvent: buildPopupEventPayload(m) });
}

async function postPopupEvent(serverUrl, event) {
  if (!serverUrl || serverUrl.startsWith("YOUR_")) return false;
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/popup-events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

// 이전 팝업의 잔여 이벤트를 확정 큐로 승격하고 live 슬롯을 비운다.
// 현재 세션이 live 슬롯을 새로 쓰기 전에 완료해야 하므로 반드시 await 한다.
async function drainPreviousPopupEvents() {
  const { pendingPopupEvents = [], livePopupEvent = null } =
    await chrome.storage.local.get(["pendingPopupEvents", "livePopupEvent"]);
  const queue = [...pendingPopupEvents];
  if (livePopupEvent) queue.push(livePopupEvent);
  await chrome.storage.local.set({
    pendingPopupEvents: queue,
    livePopupEvent: null,
  });
}

// 확정 큐를 서버로 전송 — 실패분만 큐에 남겨 다음 open에서 재시도(렌더 블로킹 없이 백그라운드).
async function flushPendingPopupEvents(serverUrl) {
  const { pendingPopupEvents = [] } = await chrome.storage.local.get([
    "pendingPopupEvents",
  ]);
  if (pendingPopupEvents.length === 0) return;
  // 전송 성공분은 즉시 큐에서 제거 — flush 도중 팝업이 닫혀도 재전송(중복)을 막는다.
  const queue = [...pendingPopupEvents];
  while (queue.length > 0) {
    const ok = await postPopupEvent(serverUrl, queue[0]);
    if (!ok) break;
    queue.shift();
    await chrome.storage.local.set({ pendingPopupEvents: queue });
  }
}

// 미열람 아이콘 표시 해제 — background.js의 setUnviewedIconDot()과 짝을 이룬다.
// 배경 스크립트(ESM)와 팝업 스크립트(클래식) 경계 때문에 경로 상수를 공유할 수 없어 중복 정의한다.
// setIcon의 상대 경로는 "확장 루트"가 아니라 "호출한 스크립트의 위치"(여기선 popup/) 기준으로
// 풀리므로, 반드시 chrome.runtime.getURL로 절대 경로를 만들어 넘겨야 한다(상대 경로로 두면
// popup/assets/icons/...로 잘못 풀려 "Could not load action icon" 에러가 난다 — 실제 재현됨).
function clearUnviewedIconDot() {
  chrome.action.setIcon({
    path: {
      16: chrome.runtime.getURL("assets/icons/icon16.png"),
      32: chrome.runtime.getURL("assets/icons/icon32.png"),
      48: chrome.runtime.getURL("assets/icons/icon48.png"),
      128: chrome.runtime.getURL("assets/icons/icon128.png"),
    },
  });
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
    "participantCode",
  ]);

  // 이미 온보딩된 사용자 중 anonymousId가 없는 경우 생성
  if (stored.group && !stored.anonymousId) {
    stored.anonymousId = crypto.randomUUID();
    await chrome.storage.local.set({ anonymousId: stored.anonymousId });
  }

  // 온보딩은 됐지만 서버 등록이 확인되지 않은 경우 재시도(등록 누락 복구).
  // 팝업 렌더링을 막지 않도록 await 없이 백그라운드로 실행 — 실패 시 다음 boot에서 다시 재시도된다.
  if (
    stored.group &&
    stored.anonymousId &&
    stored.installDate &&
    !stored.participantSynced
  ) {
    syncParticipant(stored.serverUrl, {
      anonymousId: stored.anonymousId,
      participantCode: stored.participantCode,
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

  // 그룹 설정(EXP)만이 아니라 베이스라인 기간(14일 미만) 여부도 함께 봐야
  // "지금 실제로 피드백이 노출되는 상태"를 정확히 반영한다 — ViewLensPopup._isFeedbackActive와 동일 규칙
  // (TEST-EXP 예외 포함).
  const feedbackActive =
    !!VL.GROUPS[stored.group]?.feedback &&
    (VL.isTestGroup(stored.group) || !VL.isBaselinePeriod(installDate));
  const needsConfirm = feedbackActive && isRealReview(realToday.review);
  // "피드백 확인하기" 블러 해제 버튼을 눌러야만 확인된 것으로 친다(단순히 팝업을 연 것만으로는 아님).
  // 날짜 이동(어제/그제 보기)에 영향받지 않도록 VL.today가 아니라 별도 키에 둔다 — VL.today는
  // 날짜를 옮길 때마다 통째로 재생성돼서, 여기 두면 어제를 봤다 오늘로 돌아올 때 상태가 오염된다.
  VL._todayConfirmed = needsConfirm
    ? await isFeedbackConfirmed(realToday.sessionId)
    : true;
  // 미열람 아이콘 표시도 "열기"가 아니라 "확인" 기준으로 지운다 — feedbackConfirmedAt과 의미를 맞춘다.
  if (needsConfirm && VL._todayConfirmed) {
    clearUnviewedIconDot();
  }

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
    installDate,
    onChange: async ({ onboarded: ob, group: g, participantCode }) => {
      if (ob && g) {
        const installDate = new Date().toISOString();
        VL._installDate = installDate; // 온보딩 직후 첫 렌더부터 실제 경과일(1일째) 반영
        const { anonymousId: existing, serverUrl } =
          await chrome.storage.local.get(["anonymousId", "serverUrl"]);
        const anonymousId = existing || crypto.randomUUID();

        await chrome.storage.local.set({
          anonymousId,
          participantCode,
          group: g,
          installDate,
          surveyStatus: { week1: false, week2: false, week3: false },
          participantSynced: false,
        });

        await syncParticipant(serverUrl, {
          anonymousId,
          participantCode,
          group_code: g,
          installDate,
        });
      } else if (!ob) {
        // 연구자 모드 — 온보딩 초기화 (세션 데이터는 유지)
        await chrome.storage.local.remove([
          "group",
          "participantCode",
          "installDate",
          "surveyStatus",
          "participantSynced",
        ]);
        window.location.reload();
      }
    },
  });

  // 확인 안 된 리뷰가 있으면 열자마자 그 카드로 부드럽게 스크롤해 놓치지 않게 한다.
  if (needsConfirm && !VL._todayConfirmed) {
    requestAnimationFrame(() => {
      document
        .getElementById("vl-review-card")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // ── 팝업 상호작용 로그 — 온보딩 완료 사용자만 ─────────────────────────
  let popupMetrics = null;
  if (stored.group && stored.anonymousId) {
    // 이전 팝업의 잔여 이벤트를 확정 큐로 승격(현재 세션이 live 슬롯을 새로 쓰기 전에 완료).
    await drainPreviousPopupEvents();
    // 큐 전송은 백그라운드 — 렌더/상호작용을 막지 않음. 실패분은 큐에 남아 다음 open에서 재시도.
    flushPendingPopupEvents(stored.serverUrl);

    popupMetrics = {
      anonymousId: stored.anonymousId,
      // 팝업 오픈당 1회 발급 — 재전송돼도 서버가 이 id로 중복을 무시(멱등)
      eventId: crypto.randomUUID(),
      openedAt: new Date().toISOString(),
      startTs: Date.now(),
      tabTodayClicks: 0,
      tabWeekClicks: 0,
      // EXP 사용자가 열자마자 실제 리뷰(today 탭)를 보고 있으면 개입 전달로 간주
      feedbackViewed: feedbackActive && isRealReview(realToday.review) ? 1 : 0,
    };
    persistLivePopupEvent(popupMetrics);

    // 탭 클릭 계측 + 피드백 확인 버튼 — popEl은 re-render(innerHTML 교체) 후에도 유지되므로
    // 위임 리스너로 한 번만 바인딩
    popEl.addEventListener("click", (e) => {
      const tabBtn = e.target.closest && e.target.closest("[data-tab]");
      if (tabBtn) {
        if (tabBtn.dataset.tab === "today") {
          popupMetrics.tabTodayClicks++;
        } else if (tabBtn.dataset.tab === "feedback") {
          popupMetrics.tabWeekClicks++;
          popupMetrics.feedbackViewed = 1; // 주차별 피드백 탭 열람 = 개입 전달
        }
        persistLivePopupEvent(popupMetrics);
        return;
      }

      const confirmBtn =
        e.target.closest && e.target.closest("#vl-feedback-confirm-btn");
      if (confirmBtn) {
        handleFeedbackConfirmClick(popup, confirmBtn.dataset.sessionId);
      }
    });

    // 팝업 종료 감지 — dwellMs 최종 반영(단일 set, teardown에 상대적으로 안전).
    // 최종 쓰기가 잘려도 세션 중 스냅샷이 남아 다음 boot에서 승격된다.
    const finalizePopupMetrics = () => persistLivePopupEvent(popupMetrics);
    window.addEventListener("pagehide", finalizePopupMetrics);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) finalizePopupMetrics();
    });
  }

  // 로컬 캐시 — storage.onChanged로 갱신, setInterval에서는 캐시만 읽음
  let localCurrentSession = stored.currentSession || null;
  let localLastWatchedAt = stored.lastWatchedAt || null;

  // sessions가 바뀌면(분석 완료, 리뷰 저장 등) 즉시 today 데이터를 갱신하고 re-render
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes.currentSession)
      localCurrentSession = changes.currentSession.newValue || null;
    if (changes.lastWatchedAt)
      localLastWatchedAt = changes.lastWatchedAt.newValue || null;
    if (!changes.sessions) return;
    const updatedSessions = changes.sessions.newValue || [];
    VL._allSessions = updatedSessions;
    const freshToday = buildDataForDate(updatedSessions, new Date());
    freshToday.collectingCount = localCurrentSession?.videos?.length ?? 0;
    freshToday.collectingTimer = _computeTimerText(localLastWatchedAt);
    const freshNeedsConfirm = feedbackActive && isRealReview(freshToday.review);
    // 새로 완료된 세션은 아직 로컬에 확인 기록이 없을 테니 다시 블러 처리된다(의도된 동작).
    // 날짜 이동에 오염되지 않도록 VL.today가 아니라 VL._todayConfirmed에 둔다(위 boot()와 동일 이유).
    VL._todayConfirmed = freshNeedsConfirm
      ? await isFeedbackConfirmed(freshToday.sessionId)
      : true;
    VL.today = freshToday;
    if (freshNeedsConfirm && VL._todayConfirmed) {
      clearUnviewedIconDot();
    }
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

    // dwellMs 스냅샷 갱신 — close write가 잘려도 최근값(±1초)이 보존됨
    if (popupMetrics) persistLivePopupEvent(popupMetrics);

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
