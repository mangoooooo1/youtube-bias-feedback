window.buildDataForDate = buildDataForDate;
window.koreanDateLabel = koreanDateLabel;
window.findUnrevealedPastDate = findUnrevealedPastDate;
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

// "YYYY-MM-DD"를 로컬 자정 Date로 만든다.
function localDateFromDateStr(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
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

// period_reviews.categoryDistribution은 sessions와 동일 포맷으로 저장돼 있어 VL.dist가 기대하는 {vlKey: fraction} 형태가 아니다.
function vlDistFromCategoryDistribution(categoryDistribution) {
  const merged = {};
  for (const [catName, ratio] of Object.entries(categoryDistribution || {})) {
    const k = toVlKey(catName);
    merged[k] = (merged[k] ?? 0) + ratio;
  }
  return Object.keys(merged).length > 0 ? VL.dist(merged) : VL.dist({ etc: 1 });
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
      sessionIds: [],
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
  // 오늘 누적 리뷰(Story 11-2)의 신선도(staleness) 판정용 — 마지막 세션 하나가 아니라
  // 오늘 전체 세션 id 목록이 필요하다.
  const sessionIds = sourceSessions.map((s) => s.sessionId);

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
    sessionIds,
  };
}

// "어제 돌아보기" 리빌 대상 날짜를 찾는다
// 로컬 sessions를 스캔해 revealedDateStr보다 최근이고 오늘보다 이전인 날짜 중 세션이 있는 가장 최근 날짜 하나만 반환한다.
function findUnrevealedPastDate(
  allSessions,
  revealedDateStr,
  today = new Date(),
) {
  const todayStr = dateStr(today);
  let mostRecent = null;
  for (const s of allSessions) {
    if (
      !s.endTime ||
      !s.categoryDistribution ||
      Object.keys(s.categoryDistribution).length === 0
    )
      continue;
    const d = dateStr(new Date(s.endTime));
    if (d < todayStr && (!mostRecent || d > mostRecent)) mostRecent = d;
  }
  if (!mostRecent) return null;
  if (revealedDateStr && mostRecent <= revealedDateStr) return null;
  return mostRecent;
}

// ── Build VL.weeks ────────────────────────────────────────────────────────────

function buildWeeksData(allSessions, installDate, periodReviews = []) {
  const analyzedSessions = allSessions.filter(
    (s) =>
      s.endTime &&
      s.categoryDistribution &&
      Object.keys(s.categoryDistribution).length > 0,
  );

  // 서버가 배치로 생성한 기간 리뷰
  const reviewsByIndex = new Map(
    (periodReviews || []).map((r) => [r.periodIndex, r]),
  );

  const weeks = [];

  for (let w = 1; w <= VL.TOTAL_WEEKS; w++) {
    const startOffset = (w - 1) * VL.DAYS_PER_PERIOD; // day offset from install
    const endOffset = w * VL.DAYS_PER_PERIOD - 1;
    const isBaseline = startOffset < VL.BASELINE_DAYS; // 14일(2주) 미만이면 베이스라인 — 1·2주차

    const weekStart = dayFromInstall(installDate, startOffset);
    const weekEnd = dayFromInstall(installDate, endOffset);

    const weekSessions = analyzedSessions.filter((s) => {
      const d = dateStr(new Date(s.endTime));
      return d >= weekStart && d <= weekEnd;
    });

    // 재설치 등으로 로컬 세션 캐시가 비어 있을 때, 서버가 사전 생성해 둔 기간 리뷰
    // 스냅샷(categoryDistribution/entropy/videoCount/sessionCount)을 대신 쓴다(4-2절 폴백).
    // EXP는 로컬 세션이 정상적으로 쌓여 있어 weekSessions가 비지 않으므로 이 분기를 타지 않는다.
    const reviewRow = reviewsByIndex.get(w) || null;
    const useServerSnapshot = weekSessions.length === 0 && !!reviewRow;

    // Daily entropy (기간 내 일수만큼 — 0 if no data that day)
    const daily = [];
    if (useServerSnapshot) {
      // period_reviews는 기간 집계값만 저장하고 일별 값은 없다 — 없는 값을 0으로 채우면
      // "다양성이 0"으로 오인될 수 있어, 기존 screenFeedback의 "데이터 부족 시 같은 값을
      // 반복해 평평한 선으로 표시" 관례를 따라 기간 엔트로피를 일수만큼 반복한다.
      for (let d = 0; d < VL.DAYS_PER_PERIOD; d++) {
        daily.push(reviewRow.entropy ?? 0);
      }
    } else {
      for (let d = 0; d < VL.DAYS_PER_PERIOD; d++) {
        const dayKey = dayFromInstall(installDate, startOffset + d);
        const daySess = weekSessions.filter(
          (s) => dateStr(new Date(s.endTime)) === dayKey,
        );
        const dayDist = mergeDist(daySess);
        const dayDistArr =
          Object.keys(dayDist).length > 0 ? VL.dist(dayDist) : [];
        daily.push(dayDistArr.length > 0 ? VL.entropy(dayDistArr) : 0);
      }
    }

    // Weekly aggregate
    const weekDistArr = useServerSnapshot
      ? vlDistFromCategoryDistribution(
          JSON.parse(reviewRow.categoryDistribution || "{}"),
        )
      : (() => {
          const weekDist = mergeDist(weekSessions);
          return Object.keys(weekDist).length > 0
            ? VL.dist(weekDist)
            : VL.dist({ etc: 1 });
        })();

    // Range label
    const startD = new Date(installDate);
    startD.setDate(startD.getDate() + startOffset);
    const endD = new Date(installDate);
    endD.setDate(endD.getDate() + endOffset);
    const range = `${startD.getMonth() + 1}/${startD.getDate()} – ${endD.getMonth() + 1}/${endD.getDate()}`;

    // Review: 서버가 생성한 기간 리뷰
    const periodEnded = weekEnd < dateStr(new Date());
    const review =
      reviewRow?.review ||
      (isBaseline
        ? "베이스라인 기간 동안의 시청 습관을 기준선으로 담아 두었어요. 이건 평가가 아니라 출발점이에요."
        : periodEnded
          ? "이번 기간 데이터를 분석 중이에요. 곧 리포트를 볼 수 있어요."
          : "아직 진행 중인 기간이에요. 기간이 끝나면 리뷰가 생성돼요.");

    const totalVids = useServerSnapshot
      ? (reviewRow.videoCount ?? 0)
      : weekSessions.reduce(
          (s, sess) => s + (sess.videoCount ?? sess.videos?.length ?? 1),
          0,
        );
    const sessionCount = useServerSnapshot
      ? (reviewRow.sessionCount ?? 0)
      : weekSessions.length;

    weeks.push({
      week: w,
      label: VL.periodLabel(w),
      isBaseline,
      range,
      videoCount: totalVids,
      sessionCount,
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

// 베이스라인 기준 엔트로피(VL.baselineH) — 이후 주차들과 비교하는 기준값이다.
// 베이스라인 주차(1·2주차, weeks[0]/weeks[1])의 "주간 엔트로피"를 단순 평균한다.
// 처음엔 두 주의 세션을 하나의 분포로 합쳐서 계산했으나, 그러면 두 주가 서로 다른
// 카테고리 위주였을 때(예: 1주차 게임·음악 / 2주차 교육·과학) 등장 카테고리 수 자체가
// 늘어나 개별 주차 어느 쪽보다도 높은 엔트로피가 나와, 이후 "1주치" 값과 비교할 때
// 기준이 구조적으로 불리하게(항상 더 높게) 잡히는 문제가 있었다. 평균은 이후 주차와
// 똑같이 "1주치 엔트로피" 단위로 맞춰 비교가 공정하다.
function calculateBaselineEntropy(weeks) {
  const baselineWeeks = weeks.filter((w) => w.isBaseline && w.sessionCount > 0);
  if (baselineWeeks.length === 0) return 0;
  const sum = baselineWeeks.reduce((s, w) => s + w.entropy, 0);
  return sum / baselineWeeks.length;
}

// ── Token application ─────────────────────────────────────────────────────────

function applyTokens(el, toneName, dark) {
  const tone = VL.TONES[toneName] || VL.TONES.indigo;
  const tokens = dark ? tone.dark : tone.light;
  Object.entries(tokens).forEach(([k, v]) => el.style.setProperty(k, v));
  el.style.background = tokens["--vl-bg"];
}

// ── Timeline key from install date ────────────────────────────────────────────

// VL.TIMELINE 항목 중 day가 경과일 이하인 것 중 가장 늦은(day가 가장 큰) 체크포인트를 고른다.
// 6주(12개 체크포인트)로 늘어난 뒤로는 임계값을 나열하는 if 사슬 대신 VL.TIMELINE 자체를 순회해,
// 이후 체크포인트가 더 늘어나도(예: 로드맵 변경) 이 함수를 다시 손볼 필요가 없게 한다.
function calcTimelineKey(installDate) {
  if (!installDate) return "w1_mid";
  const days = Math.max(
    1,
    Math.floor((Date.now() - new Date(installDate).getTime()) / 86400000) + 1,
  );
  const reached = Object.entries(VL.TIMELINE)
    .filter(([, tl]) => days >= tl.day)
    .sort((a, b) => b[1].day - a[1].day)[0];
  return reached ? reached[0] : "w1_mid";
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

const PERIOD_REVIEWS_TIMEOUT_MS = 5000;

// 완료된 기간 리뷰 조회 (Story 11-1) — 실패(오프라인·서버 미설정·타임아웃 등) 시 null.
async function fetchPeriodReviews(serverUrl, anonymousId) {
  if (!serverUrl || serverUrl.startsWith("YOUR_") || !anonymousId) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    PERIOD_REVIEWS_TIMEOUT_MS,
  );
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/period-reviews?anonymousId=${encodeURIComponent(anonymousId)}`,
      { signal: controller.signal },
    );
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json.data) ? json.data : null;
  } catch (error) {
    console.warn("[popup] 기간 리뷰 조회 오류:", error.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// 기간 리뷰 로컬 캐싱
// 팝업을 열 때마다 서버를 조회하지 않고, 캐시가 오늘 날짜 것이 아닐 때만 재조회
async function getPeriodReviewsCached(serverUrl, anonymousId) {
  const { periodReviewsCache } =
    await chrome.storage.local.get("periodReviewsCache");
  const todayStr = dateStr(new Date());

  if (
    periodReviewsCache &&
    periodReviewsCache.anonymousId === anonymousId &&
    periodReviewsCache.dateStr === todayStr
  ) {
    return periodReviewsCache.reviews;
  }

  const fetched = await fetchPeriodReviews(serverUrl, anonymousId);
  if (fetched) {
    await chrome.storage.local.set({
      periodReviewsCache: { anonymousId, dateStr: todayStr, reviews: fetched },
    });
    return fetched;
  }

  // 조회 실패 — 같은 참여자의 이전 캐시가 있으면(날짜는 지났어도) 빈 화면보다는 낫다.
  return periodReviewsCache?.anonymousId === anonymousId
    ? periodReviewsCache.reviews
    : [];
}

// ── "오늘" 탭 누적 리뷰 ─────────────────────────────────────────
// 생성은 세션-종료 트리거가 전담. 팝업은 캐시를 읽기만 하고 생성을 요청하지 않는다.

async function getTodayCumulativeCache() {
  const { todayCumulativeReview } = await chrome.storage.local.get(
    "todayCumulativeReview",
  );
  return todayCumulativeReview ?? null;
}

// 캐시의 reviewDate가 오늘이 아니거나, 오늘 세션 집합이 캐시 생성 당시보다 늘어났으면 "오래됨"으로 본다.
// 세션 종료 직후 팝업을 열면 background.js의 비동기 생성이 아직 끝나지 않았을 수 있는데,
// 그 짧은 간극 동안만 "오래됨"으로 잡혀 아래에서 "분석 중…" 플레이스홀더로 표시된다.
function isTodayCumulativeStale(cache, todayStr, todaySessionIds) {
  if (!cache || cache.reviewDate !== todayStr) return true;
  const known = new Set(cache.sourceSessionIds || []);
  return todaySessionIds.some((id) => !known.has(id));
}

// 오늘 누적 리뷰의 현재 표시 상태를 판정한다. 대상이 아니면 즉시 빈 상태를 반환하고,
// 대상이면 캐시를 읽어 최신인지만 확인한다(생성 요청은 하지 않음 — background.js가 이미 하고 있음).
// sessionId/locked도 이 함수가 "같은 캐시 읽기 한 번"으로 함께 계산해서 반환한다.
async function resolveTodayCumulative(eligible, todaySessionIds) {
  if (!eligible) {
    return {
      eligible: false,
      generating: false,
      review: null,
      reviewTopic: null,
      sessionId: null,
      locked: false,
    };
  }

  const todayStr = dateStr(new Date());
  const cache = await getTodayCumulativeCache();
  const stale = isTodayCumulativeStale(cache, todayStr, todaySessionIds);

  if (stale) {
    return {
      eligible: true,
      generating: true,
      review: null,
      reviewTopic: null,
      sessionId: null,
      locked: false,
    };
  }

  // sourceSessionIds는 오늘 세션을 병합한 순서 그대로라 마지막 원소가 곧 가장 최근 세션이다
  const sessionId = cache.sourceSessionIds?.at(-1) ?? null;
  const locked = isRealReview(cache.review)
    ? !(await isFeedbackConfirmed(sessionId))
    : false;

  return {
    eligible: true,
    generating: false,
    review: cache.review,
    reviewTopic: cache.reviewTopic,
    sessionId,
    locked,
  };
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
    return {
      ok: true,
      group: data.group_code || null,
      previouslyRegistered: !!data.previouslyRegistered,
    };
  } catch {
    return { ok: true }; // 네트워크 오류 → 폴백 통과
  }
}
window.validateParticipantCode = validateParticipantCode;

// 참여코드 기반 재설치 복구
const RECOVER_PARTICIPANT_TIMEOUT_MS = 5000;

async function recoverParticipant(participantCode) {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  if (!serverUrl || serverUrl.startsWith("YOUR_")) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    RECOVER_PARTICIPANT_TIMEOUT_MS,
  );
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/participants/recover`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantCode }),
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const data = json.data ?? json;
    return data.anonymousId ? data : null;
  } catch (error) {
    console.warn("[popup] 참여코드 복구 요청 오류:", error.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
window.recoverParticipant = recoverParticipant;

// ── 팝업 상호작용 마이크로 로그 ────────────────────────────────────────
// 수집: openedAt, dwellMs, tabTodayClicks, tabWeekClicks, feedbackViewed.
// 전송: 팝업 close 시점의 storage 쓰기는 teardown에 잘릴 수 있어 신뢰하지 않는다.
//   대신 세션 중 livePopupEvent 슬롯을 상호작용·1초 간격으로 계속 갱신해 최신 스냅샷을 남기고,
//   다음 팝업 open(boot) 때 이전 스냅샷을 확정 큐로 승격해 서버로 전송(실패분은 큐에 남겨 재시도).
//   팝업은 싱글턴이라 boot 시점의 잔여 livePopupEvent는 곧 "닫힌 이전 팝업"의 확정 이벤트다.
//   sendBeacon을 쓰지 않으므로 중복 전송이 없다(전송은 항상 다음 open의 flush 한 경로).

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

// 대조군 종료 안내 모달 노출/6주 리뷰 열람 이벤트 기록
async function postStudyEndReviewEvent(event) {
  const { serverUrl, anonymousId } = await chrome.storage.local.get([
    "serverUrl",
    "anonymousId",
  ]);
  if (!serverUrl || serverUrl.startsWith("YOUR_") || !anonymousId) return;
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/participants/study-end-review-event`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anonymousId, event }),
      },
    );
    if (!res.ok)
      console.warn("[popup] 종료 리뷰 이벤트 기록 실패:", res.status);
  } catch (error) {
    console.warn("[popup] 종료 리뷰 이벤트 기록 오류:", error.message);
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
    "sessions",
    "tone",
    "dark",
    "currentSession",
    "lastWatchedAt",
    "anonymousId",
    "serverUrl",
    "participantSynced",
    "participantCode",
    "studyEndModalShown",
    "todayCumulativeRevealedDate",
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
  // "오늘" 누적 리뷰 — 세션 리뷰와 같은 게이팅(feedbackActive)을 재사용하고,
  // 오늘 세션이 하나도 없으면 대상에서 제외한다(§18 "베이스라인/대상 판별 규칙을 세션
  // 리뷰와 동일하게 맞춘다"). VL.today가 아니라 별도 키(VL._todayCumulative)에 두는 이유는
  // VL._todayConfirmed와 같다 — ViewLensPopup.render()가 탭 렌더마다 VL.today를
  // buildDataForDate로 통째로 재생성해서, 거기 두면 날짜를 옮길 때 상태가 오염된다.
  // let인 이유: 팝업을 열어둔 채 오늘 첫 세션이 끝나면(boot 시점엔 세션 0개라 대상에서 제외됨) storage.onChanged에서
  // "대상 아님 → 대상"으로 한 번 갱신해야 함(생성은 background.js의 세션-종료 트리거가 이미 하고 있음)
  let todayCumulativeEligible =
    feedbackActive && realToday.sessionIds.length > 0;
  VL._todayCumulative = await resolveTodayCumulative(
    todayCumulativeEligible,
    realToday.sessionIds,
  );

  // "어제 돌아보기" 리빌 (feedbackActive(EXP + 베이스라인 이후)일 때만 계산)
  VL._revealPastDay = null;
  if (feedbackActive) {
    const revealPastDateStr = findUnrevealedPastDate(
      sessions,
      stored.todayCumulativeRevealedDate || null,
    );
    if (revealPastDateStr) {
      const revealData = buildDataForDate(
        sessions,
        localDateFromDateStr(revealPastDateStr),
      );
      // 베이스라인 마지막 날처럼 실제 리뷰 없이 플레이스홀더만 있는 날은 리빌하지 않는다 —
      // revealedDate를 갱신하지 않으므로, 다음에 실제 리뷰가 쌓인 날이 오면 그 날짜가
      // 자연히 최신 후보로 대체된다(소급 리빌 금지 정책과 일관).
      if (isRealReview(revealData.review)) {
        VL._revealPastDay = { dateStr: revealPastDateStr, data: revealData };
      }
    }
  }

  // 확인(블러) 상태는 VL._todayCumulative(누적 캐시 기준)에서 파생한다.
  const needsConfirm =
    !VL._todayCumulative.generating && isRealReview(VL._todayCumulative.review);
  // "피드백 확인하기" 블러 해제 버튼을 눌러야만 확인된 것으로 친다.
  VL._todayConfirmed = needsConfirm ? !VL._todayCumulative.locked : true;
  // 미열람 아이콘 표시도 "열기"가 아니라 "확인" 기준으로 지운다 — feedbackConfirmedAt과 의미를 맞춘다.
  if (needsConfirm && VL._todayConfirmed) {
    clearUnviewedIconDot();
  }

  // 실험군(진행 중 주차별 피드백)뿐 아니라 대조군도 조회 대상
  let cachedPeriodReviews = [];
  if (
    installDate &&
    stored.anonymousId &&
    (VL.GROUPS[stored.group]?.feedback || VL.isConGroup(stored.group))
  ) {
    cachedPeriodReviews = await getPeriodReviewsCached(
      stored.serverUrl,
      stored.anonymousId,
    );
  }
  VL._periodReviews = cachedPeriodReviews;
  VL._studyEndModalShown = !!stored.studyEndModalShown;

  if (installDate) {
    VL.weeks = buildWeeksData(sessions, installDate, cachedPeriodReviews);
    VL.baselineH = calculateBaselineEntropy(VL.weeks);
  }

  // Apply theme tokens
  const popEl = document.getElementById("vl-popup-root");
  applyTokens(popEl, toneName, darkMode);

  // Mount popup
  const popup = new ViewLensPopup(popEl);
  popup.mount({
    onboarded: !!stored.group,
    group: stored.group || null,
    timelineKey: calcTimelineKey(installDate),
    installDate,
    onChange: async ({
      onboarded: ob,
      group: g,
      participantCode,
      recovered,
    }) => {
      if (ob && g && recovered) {
        // 재설치 복구 — 새 anonymousId/installDate를 만들지 않고 서버가 돌려준 기존 값을 그대로 쓴다.
        // 이미 서버에 있는 행이므로 POST /api/participants는 다시 호출하지 않는다.
        await chrome.storage.local.set({
          anonymousId: recovered.anonymousId,
          participantCode,
          group: g,
          installDate: recovered.installDate,
          participantSynced: true,
        });
        // 연구자 모드 리셋과 동일하게 boot() 전체를 다시 태워 새 값으로 재계산한다.
        window.location.reload();
        return;
      }
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
        return;
      }

      // 대조군 종료 안내 모달 — "지금 확인하기"는 모달 노출+리뷰 열람을 모두, "나중에"는
      // 모달 노출만 기록한다(3절 플로우차트 F/G와 동일).
      const studyEndConfirmBtn =
        e.target.closest && e.target.closest("#vl-study-end-modal-confirm");
      const studyEndLaterBtn =
        e.target.closest && e.target.closest("#vl-study-end-modal-later");
      if (studyEndConfirmBtn || studyEndLaterBtn) {
        chrome.storage.local.set({ studyEndModalShown: true });
        postStudyEndReviewEvent("modal_shown");
        if (studyEndConfirmBtn) postStudyEndReviewEvent("review_viewed");
        return;
      }

      // 대조군 상시 CTA — 재진입할 때마다 호출되지만 서버가 최초 1회만 반영한다.
      const studyEndCtaBtn =
        e.target.closest && e.target.closest("#vl-study-end-cta");
      if (studyEndCtaBtn) {
        postStudyEndReviewEvent("review_viewed");
      }

      // "어제 돌아보기" 리빌 확인
      const revealDismissBtn =
        e.target.closest && e.target.closest("#vl-reveal-dismiss");
      if (revealDismissBtn && VL._revealPastDay) {
        chrome.storage.local.set({
          todayCumulativeRevealedDate: VL._revealPastDay.dateStr,
        });
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

    // background.js의 세션-종료 트리거가 생성을 마치고 캐시를 갱신하면 여기서
    // 받아 플레이스홀더를 실제 리뷰로 교체한다. 팝업은 생성을 요청하지 않고 결과만 반영한다.
    // resolveTodayCumulative를 다시 호출해 텍스트·잠금 상태를 "같은 캐시 읽기"에서 함께
    // 얻는다 — sessions 변경(아래 분기)이 아직 안 왔어도 이 시점의 render()가 이미 올바른
    // 잠금 상태로 나가게 하기 위함(coderabbitai 지적, 이슈1 사후 발견 버그 수정).
    if (changes.todayCumulativeReview && todayCumulativeEligible) {
      const newCache = changes.todayCumulativeReview.newValue || null;
      const todayStr = dateStr(new Date());
      if (newCache && newCache.reviewDate === todayStr) {
        VL._todayCumulative = await resolveTodayCumulative(
          true,
          newCache.sourceSessionIds || [],
        );
        VL._todayConfirmed = !VL._todayCumulative.locked;
        if (
          !VL._todayCumulative.generating &&
          isRealReview(VL._todayCumulative.review) &&
          VL._todayConfirmed
        ) {
          clearUnviewedIconDot();
        }
        popup.render();
      }
    }

    if (!changes.sessions) return;
    const updatedSessions = changes.sessions.newValue || [];
    VL._allSessions = updatedSessions;
    const freshToday = buildDataForDate(updatedSessions, new Date());
    freshToday.collectingCount = localCurrentSession?.videos?.length ?? 0;
    freshToday.collectingTimer = _computeTimerText(localLastWatchedAt);
    // 확인(블러) 상태는 여기서 다시 계산하지 않는다 — VL._todayCumulative(위 분기)가
    // 유일한 소스다. sessions 변경은 도넛·영상목록 등 리뷰와 무관한 필드 갱신용.
    VL.today = freshToday;

    // 팝업을 연 채로 오늘 첫 세션이 막 끝난 경우 — boot() 시점엔 오늘 세션이 0개라
    // 대상에서 제외됐던 상태를 여기서 한 번만 다시 판정한다. 이미 대상이었다면(세션이
    // 더 늘어난 것뿐이라면) 다시 판정하지 않는다 — resolveTodayCumulative는 이제 읽기만
    // 하므로 재판정 자체는 안전하지만, 매 세션마다 불필요한 캐시 재조회를 피하기 위함이다.
    // 실제 캐시 갱신 반영은 위 changes.todayCumulativeReview 리스너가 담당한다.
    if (!todayCumulativeEligible) {
      const nowEligible = feedbackActive && freshToday.sessionIds.length > 0;
      if (nowEligible) {
        todayCumulativeEligible = true;
        VL._todayCumulative = await resolveTodayCumulative(
          true,
          freshToday.sessionIds,
        );
      }
    }

    if (installDate) {
      // 기간 리뷰는 세션이 갱신될 때마다 다시 조회하지 않는다 — 서버 cron이 하루/일주일에
      // 한 번만 새로 생성하므로, boot() 시점에 캐시로 가져온 값을 그대로 재사용한다.
      VL.weeks = buildWeeksData(
        updatedSessions,
        installDate,
        cachedPeriodReviews,
      );
      VL.baselineH = calculateBaselineEntropy(VL.weeks);
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
