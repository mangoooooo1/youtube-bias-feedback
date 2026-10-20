window.buildDataForDate = buildDataForDate;
window.koreanDateLabel = koreanDateLabel;
window.findUnrevealedPastDate = findUnrevealedPastDate;
window.addDaysKst = addDaysKst;
window.dateStr = dateStr;
window.dayFromInstall = dayFromInstall;
window.shouldRetryParticipantSync = shouldRetryParticipantSync;
window.flushPendingPopupEvents = flushPendingPopupEvents;
window.loadViewingSummaryCache = loadViewingSummaryCache;
window.refreshViewingSummary = refreshViewingSummary;
window.fillMissingTitles = fillMissingTitles;
window.videoIdsWithoutTitle = videoIdsWithoutTitle;
window.hasNewDisplayTitle = hasNewDisplayTitle;
window.resolveTodayCumulative = resolveTodayCumulative;
const DEFAULT_TONE = "indigo";

// ── Date helpers ──────────────────────────────────────────────────────────────

function dateStr(d) {
  // KST(Asia/Seoul) 기준 YYYY-MM-DD
  // 서버와 동일 기준. 참여자 브라우저의 로컬 시간대에 따라 화면의 날짜/구간 판정이 서버가 실제로 생성하는 구간과 어긋나는 걸 막는다.
  return d.toLocaleDateString("sv", { timeZone: "Asia/Seoul" });
}

// "YYYY-MM-DD"(KST 날짜 문자열)를 Date로 만든다. KST 정오(=UTC 03:00)에 고정한다 —
// 자정 근처를 쓰면 참여자 브라우저 시간대에 따라 dateStr()로 되돌렸을 때 하루 어긋날 수
// 있는데(예: KST보다 많이 앞선 시간대), 정오는 그런 극단적인 시간대 오프셋에서도 안전하다.
function localDateFromDateStr(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 3, 0, 0));
}

// installDate/오늘 등 임의의 Date를 KST 기준으로 deltaDays만큼 이동한다.
// d.setDate(d.getDate()+n) 같은 로컬 캘린더 연산 대신 dayFromInstall과 동일하게
// ms 연산 → KST 포맷 → 안전한 Date로 왕복해, 참여자 시간대와 무관하게 항상 KST 기준
// 하루 단위로 움직인다("어제 돌아보기"/기간 계산과 동일한 기준 유지).
function addDaysKst(date, deltaDays) {
  const ms = date.getTime() + deltaDays * 86400000;
  return localDateFromDateStr(dateStr(new Date(ms)));
}

function koreanDateLabel(d) {
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const [y, m, day] = dateStr(d).split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
  return `${m}월 ${day}일 ${days[weekday]}요일`;
}

/** Returns YYYY-MM-DD string for day offset from installDate */
function dayFromInstall(installDate, offset) {
  // 로컬 캘린더 필드로 날짜를 더하지 않고, 서버와 동일하게 순수 ms 연산 후 KST로 포맷한다.
  const ms = new Date(installDate).getTime() + offset * 86400000;
  return dateStr(new Date(ms));
}

// ── Build VL.today ────────────────────────────────────────────────────────────

/**
 * 특정 날짜의 하루 요약 데이터를 만든다.
 * @param {Array<object>} allSessions - 전체 세션 목록
 * @param {Date} targetDate - 조회할 날짜
 */
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
      review: "",
      sessionIds: [],
    };
  }

  const sourceSessions = todaySess;

  const sourceDate = targetDate;
  const sourceDateStr = dateStr(sourceDate);
  // 리뷰 텍스트는 서버가 준 이력(VL._todayReviewsByDate, boot()에서 조회)을 우선 쓴다.
  // 로컬 세션 기록이 스토리지 clear·재설치 등으로 사라져도 서버에 남아있는 리뷰를 계속
  // 보여줄 수 있다. 서버 조회가 안 됐거나 실패한 경우에만 로컬 세션 스냅샷으로 대체한다.
  const serverRow = VL._todayReviewsByDate?.[sourceDateStr];
  const review =
    serverRow?.review ||
    sourceSessions.at(-1)?.review ||
    "시청 패턴을 분석하고 있어요. 잠시 후 시청 분석이 업데이트돼요.";
  const reviewTopic =
    serverRow?.reviewTopic || sourceSessions.at(-1)?.reviewTopic || "";
  // 리뷰 카드의 "기준" 시각(서버가 이 리뷰를 만든 시각)
  const reviewGeneratedAt = serverRow?.generatedAt ?? null;
  // "피드백 확인하기" 블러 해제 버튼이 어느 세션을 확인 처리할지 알아야 해서 함께 넘긴다.
  const sessionId = sourceSessions.at(-1)?.sessionId ?? null;
  // 오늘 누적 리뷰(Story 11-2)의 신선도(staleness) 판정용 — 마지막 세션 하나가 아니라
  // 오늘 전체 세션 id 목록이 필요하다.
  const sessionIds = sourceSessions.map((s) => s.sessionId);

  return {
    dateLabel: koreanDateLabel(sourceDate),
    review,
    reviewTopic,
    reviewGeneratedAt,
    sessionId,
    sessionIds,
  };
}

/**
 * 진행 중인 세션의 영상 기록(video__ 키). 세션이 끝나기 전에도 "오늘 재생한 영상" 목록에 보여 준다.
 * @returns {Promise<Array<object>>}
 */
async function loadLiveVideos() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith("video__"))
    .map(([, video]) => video);
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

/**
 * 설치일 기준 기간(구간)별 이름·날짜 범위·리뷰. 그래프 값은 서버 집계를 쓴다.
 * @param {string} installDate - ISO 설치일
 * @param {Array<object>} [periodReviews] - 서버가 생성해 둔 기간 리뷰 목록
 * @returns {Array<{week: number, label: string, range: string, review: string}>}
 */
function buildWeeksData(installDate, periodReviews = []) {
  const reviewsByIndex = new Map(
    (periodReviews || []).map((r) => [r.periodIndex, r]),
  );
  const mdLabel = (ymd) =>
    `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;

  const weeks = [];
  for (let w = 1; w <= VL.TOTAL_WEEKS; w++) {
    const weekStart = dayFromInstall(installDate, (w - 1) * VL.DAYS_PER_PERIOD);
    const weekEnd = dayFromInstall(installDate, w * VL.DAYS_PER_PERIOD - 1);
    const periodEnded = weekEnd < dateStr(new Date());
    const review =
      reviewsByIndex.get(w)?.review ||
      (periodEnded
        ? "이번 기간 데이터를 분석 중이에요. 곧 리포트를 볼 수 있어요."
        : "아직 진행 중인 기간이에요. 기간이 끝나면 리뷰가 생성돼요.");
    weeks.push({
      week: w,
      label: VL.periodLabel(w),
      range: `${mdLabel(weekStart)} – ${mdLabel(weekEnd)}`,
      review,
    });
  }
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
    const json = await res.json();
    const participantToken = json.data?.participantToken ?? null;
    // PARTICIPANT_TOKEN_SECRET 미설정 서버는 null을 돌려준다.
    // 그 경우 저장은 하되 값은 없는 채로 두면, 이후 서버가 토큰을 요구하기 시작해도 다음 boot의 재동기화가 채워준다.
    await chrome.storage.local.set({
      participantSynced: true,
      participantToken,
    });
  } catch (error) {
    console.warn("[popup] participants 등록 오류:", error.message);
  }
}

const PERIOD_REVIEWS_TIMEOUT_MS = 5000;

// 완료된 기간 리뷰 조회. 실패(오프라인·서버 미설정·타임아웃 등) 시 null.
async function fetchPeriodReviews(serverUrl, anonymousId, participantToken) {
  if (!serverUrl || serverUrl.startsWith("YOUR_") || !anonymousId) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    PERIOD_REVIEWS_TIMEOUT_MS,
  );
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/period-reviews`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anonymousId, participantToken }),
        signal: controller.signal,
      },
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

// 대조군은 연구종료 리뷰 열람이 "구간 전부 완결"을 전제로 한다
function _isIncompleteForCon(group, reviews) {
  return VL.isConGroup(group) && (reviews || []).length < VL.TOTAL_WEEKS;
}

// 끝난 구간인데 리뷰가 없으면(화면에 "분석 중") 서버가 아직 만들기 전이다.
// buildWeeksData와 같은 기준으로 판단해, 그동안은 오늘 캐시가 있어도 다시 묻는다.
function _hasEndedPeriodWithoutReview(installDate, reviews) {
  const reviewed = new Set(
    (reviews || []).filter((r) => r.review).map((r) => r.periodIndex),
  );
  const today = dateStr(new Date());
  for (let w = 1; w <= VL.TOTAL_WEEKS; w++) {
    const weekEnd = dayFromInstall(installDate, w * VL.DAYS_PER_PERIOD - 1);
    if (weekEnd < today && !reviewed.has(w)) return true;
  }
  return false;
}

// 기간 리뷰 로컬 캐싱
// 팝업을 열 때마다 서버를 조회하지 않고, 캐시가 오늘 날짜 것이 아니거나 끝난 구간의 리뷰가 빠졌을 때만 재조회
async function getPeriodReviewsCached(
  serverUrl,
  anonymousId,
  group,
  participantToken,
  installDate,
) {
  const { periodReviewsCache } =
    await chrome.storage.local.get("periodReviewsCache");
  const todayStr = dateStr(new Date());

  if (
    periodReviewsCache &&
    periodReviewsCache.anonymousId === anonymousId &&
    periodReviewsCache.dateStr === todayStr &&
    !_isIncompleteForCon(group, periodReviewsCache.reviews) &&
    !_hasEndedPeriodWithoutReview(installDate, periodReviewsCache.reviews)
  ) {
    return periodReviewsCache.reviews;
  }

  const fetched = await fetchPeriodReviews(
    serverUrl,
    anonymousId,
    participantToken,
  );
  if (fetched) {
    if (!_isIncompleteForCon(group, fetched)) {
      await chrome.storage.local.set({
        periodReviewsCache: {
          anonymousId,
          dateStr: todayStr,
          reviews: fetched,
        },
      });
    }
    return fetched;
  }

  // 조회 실패 — 같은 참여자의 이전 캐시가 있으면(날짜는 지났어도) 빈 화면보다는 낫다.
  return periodReviewsCache?.anonymousId === anonymousId
    ? periodReviewsCache.reviews
    : [];
}

// ── "오늘" 탭 누적 리뷰(오늘 + 과거 날짜 공용 이력) ─────────────────────────
// 생성은 세션-종료 트리거(background.js)가 전담해 서버에 저장한다. 팝업은 그 결과를
// 조회만 한다 — "기간별 리뷰"와 동일한 패턴: 로컬 캐시가 있고 최신이면 그걸 쓰고,
// 없거나 오래됐으면(스토리지 clear, 재설치, 다른 기기 등 이유 불문) 서버에 다시 물어본다.
// 이렇게 하면 "오늘"과 "과거 날짜 돌아보기"를 하나의 메커니즘으로 함께 해결한다 —
// background.js가 세션이 끝날 때마다 이 캐시에 최신 항목 하나를 병합해 두므로(빠른 경로),
// 로컬에 아무것도 없을 때만(새 시청 없이 캐시가 사라진 경우 등) 서버 조회가 개입한다.

const VIEWING_SUMMARY_TIMEOUT_MS = 5000;

/**
 * 화면 그래프·숫자의 원천인 서버 집계(/api/viewing-summary)를 받는다. 실패하면 null.
 * @returns {Promise<{days: Array, periods: Array}|null>}
 */
async function fetchViewingSummary(serverUrl, anonymousId, participantToken) {
  if (!serverUrl || serverUrl.startsWith("YOUR_") || !anonymousId) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    VIEWING_SUMMARY_TIMEOUT_MS,
  );
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/viewing-summary`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anonymousId, participantToken }),
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const data = json.data;
    return Array.isArray(data?.days) && Array.isArray(data?.periods)
      ? data
      : null;
  } catch (error) {
    console.warn("[popup] 시청 집계 조회 오류:", error.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 마지막으로 받은 서버 집계를 기기에서 읽는다.
 * 팝업을 열자마자 그리고, 서버가 안 될 때도 쓴다.
 * 다른 참여자(재설치·코드 복구)의 저장본은 쓰지 않는다.
 * @returns {Promise<{fetchedAt: string, data: object}|null>}
 */
async function loadViewingSummaryCache(anonymousId) {
  const { viewingSummaryCache } = await chrome.storage.local.get(
    "viewingSummaryCache",
  );
  if (!viewingSummaryCache || viewingSummaryCache.anonymousId !== anonymousId)
    return null;
  return {
    fetchedAt: viewingSummaryCache.fetchedAt,
    data: viewingSummaryCache.data,
  };
}

/**
 * 서버 집계를 새로 받아 저장본을 덮어쓴다(쌓지 않음). 실패하면 저장본을 건드리지 않고 null.
 * @returns {Promise<{fetchedAt: string, data: object}|null>}
 */
async function refreshViewingSummary(serverUrl, anonymousId, participantToken) {
  const data = await fetchViewingSummary(
    serverUrl,
    anonymousId,
    participantToken,
  );
  if (!data) return null;
  const fetchedAt = new Date().toISOString();
  await chrome.storage.local.set({
    viewingSummaryCache: { anonymousId, fetchedAt, data },
  });
  return { fetchedAt, data };
}

// ── 제목이 없는 영상의 제목(oEmbed) ─────────────────────────────────────────────
// 기록한 제목도 서버 메타데이터 제목도 없는 영상만 YouTube oEmbed로 제목을 받아 기기에 둔다.
// 화면 표시에만 쓰고 서버로 보내지 않는다(연구 데이터의 제목 출처를 섞지 않기 위해).

const VIDEO_TITLE_CACHE_KEY = "videoTitleCache";
const OEMBED_TIMEOUT_MS = 5000;
// 팝업을 한 번 열 때 조회하는 최대 영상 수
const OEMBED_MAX_PER_OPEN = 20;

/** 받아 둔 oEmbed 제목(videoId → 제목, 비공개·삭제 영상은 null) */
async function loadFetchedTitles() {
  const { [VIDEO_TITLE_CACHE_KEY]: cache } = await chrome.storage.local.get(
    VIDEO_TITLE_CACHE_KEY,
  );
  return cache ?? {};
}

/**
 * 영상 하나의 제목을 oEmbed로 받는다.
 * @returns {Promise<string|null|undefined>} 제목, 비공개·삭제라 없으면 null, 다시 시도할 오류면 undefined
 */
async function fetchOembedTitle(videoId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OEMBED_TIMEOUT_MS);
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`,
      { signal: controller.signal },
    );
    // 401(퍼가기 금지·비공개)·404(삭제)는 다시 물어도 같다
    if (res.status === 401 || res.status === 403 || res.status === 404)
      return null;
    if (!res.ok) return undefined;
    const json = await res.json();
    return typeof json?.title === "string" && json.title.trim()
      ? json.title
      : null;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 제목을 못 구한 영상의 제목을 받아 기기에 저장한다. 이미 받아 둔 영상은 다시 묻지 않는다.
 * @param {string[]} videoIds - 기록한 제목·서버 제목이 모두 없는 영상
 * @returns {Promise<Record<string, string|null>>} 갱신된 저장본 전체
 */
async function fillMissingTitles(videoIds) {
  const cache = await loadFetchedTitles();
  const targets = [...new Set(videoIds)]
    .filter((id) => id && !(id in cache))
    .slice(0, OEMBED_MAX_PER_OPEN);
  if (targets.length === 0) return cache;
  const results = await Promise.all(targets.map(fetchOembedTitle));
  const fetched = Object.fromEntries(
    targets
      .map((id, i) => [id, results[i]])
      .filter(([, title]) => title !== undefined),
  );
  if (Object.keys(fetched).length === 0) return cache;
  // 받는 사이 다른 팝업이 저장했을 수 있어 다시 읽어 합친다
  const merged = { ...(await loadFetchedTitles()), ...fetched };
  await chrome.storage.local.set({ [VIDEO_TITLE_CACHE_KEY]: merged });
  return merged;
}

/**
 * 영상 목록에서 기록한 제목도 서버 제목도 없는 영상의 videoId
 * @param {Array<{videos?: Array}>} sessions - 끝난 세션들
 * @param {Array<object>} liveVideos - 진행 중인 세션의 영상 기록
 * @param {{days?: Array<{correctedTitles?: Record<string, string>}>}|null} summary - 서버 집계
 */
function videoIdsWithoutTitle(sessions, liveVideos, summary) {
  const corrected = new Set(
    (summary?.days ?? []).flatMap((d) => Object.keys(d.correctedTitles ?? {})),
  );
  return [
    ...(sessions ?? []).flatMap((s) => s.videos ?? []),
    ...(liveVideos ?? []),
  ]
    .filter(
      (v) =>
        v.videoId &&
        !(typeof v.title === "string" && v.title.trim()) &&
        !(v.eventId && corrected.has(v.eventId)),
    )
    .map((v) => v.videoId);
}

/**
 * 받아 온 oEmbed 제목 중 화면에 새로 보일 제목이 있는지.
 * 다시 그리면 스크롤·입력값이 사라져 보일 제목이 생겼을 때만 다시 그린다.
 * null(비공개·삭제)은 "제목 없음" 그대로라 세지 않는다.
 * @param {Record<string, string|null>} before - 이전 저장본
 * @param {Record<string, string|null>} after - 새 저장본
 */
function hasNewDisplayTitle(before, after) {
  return Object.entries(after ?? {}).some(
    ([id, title]) =>
      typeof title === "string" &&
      title.trim() !== "" &&
      (before ?? {})[id] !== title,
  );
}

const TODAY_REVIEWS_TIMEOUT_MS = 5000;

async function fetchTodayReviews(serverUrl, anonymousId, participantToken) {
  if (!serverUrl || serverUrl.startsWith("YOUR_") || !anonymousId) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    TODAY_REVIEWS_TIMEOUT_MS,
  );
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/today-reviews`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anonymousId, participantToken }),
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json.data) ? json.data : null;
  } catch (error) {
    console.warn("[popup] 오늘 리뷰 조회 오류:", error.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// 캐시에 "오늘" 날짜 행이 없거나, 그 행의 sessionCount가 로컬에서 알고 있는 오늘 세션
// 개수보다 적으면(아직 반영 안 된 최신 세션이 있다는 뜻) 오래된 것으로 본다.
function isTodayReviewsCacheStale(
  cache,
  anonymousId,
  todayStr,
  todaySessionCount,
) {
  if (!cache || cache.anonymousId !== anonymousId) return true;
  const todayRow = (cache.reviews || []).find((r) => r.reviewDate === todayStr);
  return todaySessionCount > (todayRow?.sessionCount ?? 0);
}

async function getTodayReviewsCached(
  serverUrl,
  anonymousId,
  todaySessionCount,
  participantToken,
) {
  const { todayReviewsCache } =
    await chrome.storage.local.get("todayReviewsCache");
  const todayStr = dateStr(new Date());

  if (
    !isTodayReviewsCacheStale(
      todayReviewsCache,
      anonymousId,
      todayStr,
      todaySessionCount,
    )
  ) {
    return todayReviewsCache.reviews;
  }

  const fetched = await fetchTodayReviews(
    serverUrl,
    anonymousId,
    participantToken,
  );
  if (fetched) {
    await chrome.storage.local.set({
      todayReviewsCache: { anonymousId, reviews: fetched },
    });
    return fetched;
  }

  // 조회 실패 — 같은 참여자의 이전 캐시가 있으면(오늘 것이 아니어도) 빈 화면보다는 낫다.
  return todayReviewsCache?.anonymousId === anonymousId
    ? todayReviewsCache.reviews
    : [];
}

/** 오늘(KST) 끝난 로컬 세션들 */
function todaySessionsOf(allSessions) {
  const todayStr = dateStr(new Date());
  return (allSessions || []).filter(
    (s) => s.endTime && dateStr(new Date(s.endTime)) === todayStr,
  );
}

// 오늘 누적 리뷰의 현재 표시 상태를 판정한다. 대상이 아니면 즉시 빈 상태를 반환하고,
// 대상이면 이미 조회해 둔 이력(reviews)에서 오늘 행을 찾는다.
// 서버는 유효 시청 영상이 늘지 않은 세션에서는 리뷰를 다시 만들지 않으므로, "세션마다 리뷰가 새로 생긴다"고 보지 않는다.
async function resolveTodayCumulative(eligible, reviews, todaySessions) {
  const empty = {
    eligible,
    generating: false,
    noReview: false,
    review: null,
    reviewTopic: null,
    generatedAt: null,
    sessionId: null,
    locked: false,
  };
  if (!eligible) return empty;

  // 전송 대기(false)·저장 직전(값 없음)만 생성 중. 서버가 거절한 세션("invalid")은 끝난 것으로 본다
  if (
    (todaySessions || []).some(
      (s) => s.syncedToServer === false || s.syncedToServer === undefined,
    )
  ) {
    return { ...empty, generating: true };
  }

  const todayStr = dateStr(new Date());
  const todayRow = (reviews || []).find((r) => r.reviewDate === todayStr);
  // 모든 세션이 응답을 받았는데 리뷰가 없다.
  if (!todayRow) return { ...empty, noReview: true };

  // 잠금·열람·확인은 지금 리뷰를 실제로 받은 세션 기준
  const reviewSession =
    [...todaySessions].reverse().find((s) => isRealReview(s.review)) ??
    todaySessions.at(-1);
  const sessionId = reviewSession?.sessionId ?? null;
  const locked = isRealReview(todayRow.review)
    ? !(await isFeedbackConfirmed(sessionId))
    : false;

  return {
    ...empty,
    review: todayRow.review,
    reviewTopic: todayRow.reviewTopic,
    generatedAt: todayRow.generatedAt ?? null,
    sessionId,
    locked,
  };
}

// 온보딩 코드 서버 검증 — 발급 명단(issued_codes)과 대조 (등록 없이 확인만).
// 반환: { ok:true, group } 통과 / { ok:false } 미발급 / 오류·오프라인·서버미설정 시 { ok:false, reason:"unavailable" }
async function validateParticipantCode(code) {
  const unavailable = { ok: false, reason: "unavailable" };
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  if (!serverUrl || serverUrl.startsWith("YOUR_")) return unavailable;
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/participants/validate?code=${encodeURIComponent(code)}`,
    );
    if (!res.ok) return unavailable;
    const json = await res.json();
    const data = json.data ?? json;
    if (data.valid === false) return { ok: false };
    return {
      ok: true,
      group: data.group_code || null,
      previouslyRegistered: !!data.previouslyRegistered,
    };
  } catch {
    return unavailable;
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

// 대조군 종료 코드 검증
// validateParticipantCode와 달리 오류/오프라인 시에도 통과시키지 않는다.
const STUDY_END_CODE_TIMEOUT_MS = 5000;

async function validateStudyEndCode(code) {
  const { serverUrl, anonymousId, participantToken } =
    await chrome.storage.local.get([
      "serverUrl",
      "anonymousId",
      "participantToken",
    ]);
  if (!serverUrl || serverUrl.startsWith("YOUR_") || !anonymousId)
    return { ok: false, reason: "offline" };
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    STUDY_END_CODE_TIMEOUT_MS,
  );
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/study-end-code/validate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, anonymousId, participantToken }),
        signal: controller.signal,
      },
    );
    if (!res.ok) return { ok: false, reason: "server" };
    const json = await res.json();
    const data = json.data ?? json;
    return data.valid ? { ok: true } : { ok: false, reason: "invalid" };
  } catch (error) {
    console.warn("[popup] 종료 코드 검증 오류:", error.message);
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timeoutId);
  }
}
window.validateStudyEndCode = validateStudyEndCode;

// ── 팝업 상호작용 마이크로 로그 ────────────────────────────────────────
// 수집: openedAt, dwellMs, tabTodayClicks, tabWeekClicks, todayFeedbackViewed, periodFeedbackViewed.
// todayFeedbackViewed: "오늘" 카드는 블러로 가려져 있다가 "피드백 확인하기" 클릭으로만 해제된 클릭 시점
// periodFeedbackViewed: "주차별" 탭은 블러가 없어 탭을 여는 순간 내용이 바로 보이지만, 클릭 직후
// 바로 다른 곳으로 이동하는 경우까지 열람으로 세지 않도록 PERIOD_FEEDBACK_VIEW_THRESHOLD_MS만큼
// 탭에 머물렀을 때만 확정한다(아래 setInterval).
// 전송 경로 1(기본)
// 팝업 close 시점의 fetch는 teardown에 끊길 수 있어 신뢰하지 않는다.
// 대신 세션 중 livePopupEvent 슬롯을 상호작용·1초 간격으로 계속 갱신해 최신 스냅샷을 남기고,
// 다음 팝업 open(boot) 때 이전 스냅샷을 확정 큐로 승격해 서버로 전송한다.
// 전송 경로 2(백업)
// close 시점 sendBeacon: 참여자가 다시 팝업을 열지 않으면 경로 1이 영영 트리거되지 않아 그 팝업 몫이 서버에 도달하지 못한다.
// sendBeacon은 문서가 파괴되는 도중에도 브라우저가 전송을 이어가도록 보장하는 API라 pagehide/visibilitychange 핸들러에서 fetch 대신 시도해볼 수 있다.
// eventId 멱등키 + 서버의 INSERT OR IGNORE 덕분에 경로 1과 경로 2가 같은 이벤트를 둘 다 성공시켜도 서버에는 한 행만 남는다.

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
  const { serverUrl, anonymousId, participantToken } =
    await chrome.storage.local.get([
      "serverUrl",
      "anonymousId",
      "participantToken",
    ]);
  if (!serverUrl || serverUrl.startsWith("YOUR_") || !anonymousId) return;
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(sessionId)}/feedback-confirmed`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anonymousId, participantToken }),
      },
    );
    if (!res.ok) console.warn("[popup] 피드백 확인 기록 실패:", res.status);
  } catch (error) {
    console.warn("[popup] 피드백 확인 기록 오류:", error.message);
  }
}

// 대조군 종료 안내 모달 노출/6주 리뷰 열람 이벤트 기록
async function postStudyEndReviewEvent(event) {
  const { serverUrl, anonymousId, participantToken } =
    await chrome.storage.local.get([
      "serverUrl",
      "anonymousId",
      "participantToken",
    ]);
  if (!serverUrl || serverUrl.startsWith("YOUR_") || !anonymousId) return;
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/participants/study-end-review-event`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anonymousId, participantToken, event }),
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
  if (VL._todayCumulative) VL._todayCumulative.locked = false;
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

// 주차별 탭에 머문 시간이 이 값 이상이어야 periodFeedbackViewed를 확정
const PERIOD_FEEDBACK_VIEW_THRESHOLD_MS = 2000;

// m.feedbackTabEnteredAt(현재 연속 체류가 시작된 실제 시각)과 지금 시각의 차이를
// periodTabMs에 누적하고, 마커를 지금 시각으로 당겨서 중복 계산 없이 반복 호출 가능하게 한다.
// setInterval의 고정 tick 주기가 아니라 실제 경과 시간을 쓰므로, 탭 진입 직후 tick이
// 곧바로 도는 경우에도 그 순간까지의 실제 체류 시간만 인정된다.
function accruePeriodFeedbackDwell(m) {
  if (!m.feedbackTabEnteredAt) return;
  const now = Date.now();
  m.periodTabMs += now - m.feedbackTabEnteredAt;
  m.feedbackTabEnteredAt = now;
  if (
    !m.periodFeedbackViewed &&
    m.periodTabMs >= PERIOD_FEEDBACK_VIEW_THRESHOLD_MS
  ) {
    m.periodFeedbackViewed = 1;
  }
}

function buildPopupEventPayload(m) {
  return {
    eventId: m.eventId,
    anonymousId: m.anonymousId,
    participantToken: m.participantToken,
    dwellMs: Math.max(0, Date.now() - m.startTs),
    tabTodayClicks: m.tabTodayClicks,
    tabWeekClicks: m.tabWeekClicks,
    todayFeedbackViewed: m.todayFeedbackViewed,
    periodFeedbackViewed: m.periodFeedbackViewed,
    openedAt: m.openedAt,
  };
}

// teardown 대비. 현재 세션 스냅샷을 live 슬롯에 기록
function persistLivePopupEvent(m) {
  chrome.storage.local.set({ livePopupEvent: buildPopupEventPayload(m) });
}

// 전송 경로 2(close 시점 백업)
function sendPopupEventBeacon(serverUrl, m) {
  if (!serverUrl || serverUrl.startsWith("YOUR_")) return;
  if (typeof navigator.sendBeacon !== "function") return;
  const blob = new Blob([JSON.stringify(buildPopupEventPayload(m))], {
    type: "application/json",
  });
  navigator.sendBeacon(
    `${serverUrl.replace(/\/$/, "")}/api/popup-events`,
    blob,
  );
}

/**
 * @returns {Promise<{ok: boolean, status: number|null, code: string|null}>}
 *   code는 서버 응답 본문의 code(INVALID_PARTICIPANT_TOKEN 등). 본문이 JSON이 아니면 null.
 */
async function postPopupEvent(serverUrl, event) {
  if (!serverUrl || serverUrl.startsWith("YOUR_")) {
    return { ok: false, status: null, code: null };
  }
  try {
    const res = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/popup-events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      },
    );
    if (res.ok) return { ok: true, status: res.status, code: null };
    let code = null;
    try {
      code = (await res.json())?.code ?? null;
    } catch {
      code = null;
    }
    return { ok: false, status: res.status, code };
  } catch {
    return { ok: false, status: null, code: null };
  }
}

/**
 * 이전 팝업이 남긴 live 슬롯 이벤트를 확정 큐(pendingPopupEvents)로 승격하고 live 슬롯을 비운다.
 * 현재 세션이 live 슬롯을 새로 쓰기 전에 끝나야 하므로 호출부에서 반드시 await 해야 한다.
 */
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

/**
 * 확정 큐(pendingPopupEvents)를 서버로 순서대로 전송한다. 실패한 항목부터는 중단하고
 * 큐에 남겨 다음 팝업 open 때 재시도한다. 렌더를 막지 않도록 백그라운드로 호출된다.
 *
 * @param {string} serverUrl
 */
async function flushPendingPopupEvents(serverUrl) {
  const {
    pendingPopupEvents = [],
    anonymousId,
    participantToken,
  } = await chrome.storage.local.get([
    "pendingPopupEvents",
    "anonymousId",
    "participantToken",
  ]);
  if (pendingPopupEvents.length === 0) return;
  // 전송 성공분은 즉시 큐에서 제거 — flush 도중 팝업이 닫혀도 재전송(중복)을 막는다.
  const queue = [...pendingPopupEvents];
  while (queue.length > 0) {
    const event = queue[0];
    if (event.anonymousId !== anonymousId) {
      console.warn(
        `[popup] popup_events result=skip_foreign_identity eventId=${event.eventId}`,
      );
      queue.shift();
      await chrome.storage.local.set({ pendingPopupEvents: queue });
      continue;
    }
    const result = await postPopupEvent(serverUrl, {
      ...event,
      participantToken,
    });
    if (!result.ok) {
      if (result.code === "INVALID_PARTICIPANT_TOKEN") {
        await chrome.storage.local.set({ participantSynced: false });
      }
      break;
    }
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

/**
 * boot에서 등록을 다시 시도할지 판정한다. 참여 전송 기간까지 끝났으면(ended) 시도하지 않는다.
 * @param {{group?: string, anonymousId?: string, installDate?: string, participantSynced?: boolean}} stored
 * @returns {boolean}
 */
function shouldRetryParticipantSync(stored) {
  return (
    !!stored.group &&
    !!stored.anonymousId &&
    !!stored.installDate &&
    !stored.participantSynced &&
    ViewLensStudy.getParticipationState(stored.installDate) !== "ended"
  );
}

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
    "participantToken",
    "serverUrl",
    "participantSynced",
    "participantCode",
    "studyEndNoticeShown",
    "studyEndCodeVerified",
    "todayCumulativeRevealedDate",
  ]);

  // 이미 온보딩된 사용자 중 anonymousId가 없는 경우 생성
  if (stored.group && !stored.anonymousId) {
    stored.anonymousId = crypto.randomUUID();
    await chrome.storage.local.set({ anonymousId: stored.anonymousId });
  }

  // 온보딩은 됐지만 서버 등록이 확인되지 않은 경우 재시도(등록 누락 복구).
  // 팝업 렌더링을 막지 않도록 await 없이 백그라운드로 실행. 실패 시 다음 boot에서 다시 재시도된다.
  if (shouldRetryParticipantSync(stored)) {
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
  // videoCount는 참고치일 뿐, 실제 저장된 영상 데이터는 세션 종료 시 항상 정확히 합쳐진다.
  const collectingCount = stored.currentSession?.videoCount ?? 0;
  VL._allSessions = sessions;
  VL._installDate = installDate;
  VL._lastWatchedAt = stored.lastWatchedAt || null;

  // 화면 그래프·숫자의 원천(서버 집계). 저장본을 먼저 쓰고, 새로 받아 오면 바꾼다.
  VL._liveVideos = await loadLiveVideos();
  VL._viewingSummary = await loadViewingSummaryCache(stored.anonymousId);
  VL._viewingSummaryStatus = "loading";
  VL._fetchedTitles = await loadFetchedTitles();
  // 새로 받아 오면 VL._viewingSummary를 바꾸고 true. 실패하면 저장본을 그대로 두고 false
  const reloadViewingSummary = () =>
    refreshViewingSummary(
      stored.serverUrl,
      stored.anonymousId,
      stored.participantToken,
    )
      .then((fresh) => {
        VL._viewingSummaryStatus = fresh ? "ok" : "failed";
        if (fresh) VL._viewingSummary = fresh;
        return true;
      })
      // 저장 실패 등은 저장본·기존 화면을 그대로 두면 된다
      .catch((error) => {
        console.warn("[popup] 시청 집계 갱신 오류:", error.message);
        VL._viewingSummaryStatus = "failed";
        return true;
      });
  const initialSummaryLoad = reloadViewingSummary();

  const realToday = buildDataForDate(sessions, new Date());
  realToday.collectingCount = collectingCount;
  realToday.collectingTimer = _computeTimerText(stored.lastWatchedAt);
  VL.today = realToday;

  // 그룹 설정(EXP)만이 아니라 베이스라인 기간(14일 미만) 여부도 함께 봐야
  // "지금 실제로 피드백이 노출되는 상태"를 정확히 반영한다. ViewLensPopup._isFeedbackActive와 동일 규칙
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
  // 대조군 종료 후(코드 검증 통과)에도 오늘 탭을 열어준다.
  const studyEndTodayEligible =
    VL.isConGroup(stored.group) &&
    _isStudyEndTimeReached(installDate) &&
    !!stored.studyEndCodeVerified;
  let todayCumulativeEligible =
    (feedbackActive || studyEndTodayEligible) &&
    realToday.sessionIds.length > 0;
  // 대상이 아니면 조회 자체를 하지 않는다.
  const todayReviewsList = todayCumulativeEligible
    ? await getTodayReviewsCached(
        stored.serverUrl,
        stored.anonymousId,
        realToday.sessionIds.length,
        stored.participantToken,
      )
    : [];
  VL._todayReviewsByDate = Object.fromEntries(
    (todayReviewsList || []).map((r) => [r.reviewDate, r]),
  );
  VL._todayCumulative = await resolveTodayCumulative(
    todayCumulativeEligible,
    todayReviewsList,
    todaySessionsOf(sessions),
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
        // 오늘 탭 카드와 같은 영상 목록(그날 재생한 영상 전부 + 서버 사유)
        revealData.dateKey = revealPastDateStr;
        const revealView = _dayViewForDate(revealPastDateStr);
        revealData.videos = VL.playedVideos(
          sessions,
          VL._liveVideos,
          revealPastDateStr,
          revealView.excludedReasons,
          {
            correctedTitles: revealView.correctedTitles,
            fetchedTitles: VL._fetchedTitles,
          },
        );
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
      stored.group,
      stored.participantToken,
      installDate,
    );
  }
  VL._studyEndNoticeShown = !!stored.studyEndNoticeShown;
  VL._studyEndCodeVerified = !!stored.studyEndCodeVerified;

  if (installDate) {
    VL.weeks = buildWeeksData(installDate, cachedPeriodReviews);
  }

  // Apply theme tokens
  const popEl = document.getElementById("vl-popup-root");
  applyTokens(popEl, toneName, darkMode);

  // Mount popup
  const popup = new ViewLensPopup(popEl);
  // 서버 집계가 도착하면(또는 실패가 확정되면) 그래프·상태 문구를 다시 그린다
  initialSummaryLoad.then((changed) => {
    if (changed) popup.render();
  });
  // 제목을 못 구한 영상은 서버 집계를 받은 뒤(서버 제목이 있는 영상은 빼고) oEmbed로 채운다
  initialSummaryLoad
    .then(() =>
      fillMissingTitles(
        videoIdsWithoutTitle(
          VL._allSessions,
          VL._liveVideos,
          VL._viewingSummary?.data,
        ),
      ),
    )
    .then((titles) => {
      const changed = hasNewDisplayTitle(VL._fetchedTitles, titles);
      VL._fetchedTitles = titles;
      if (changed) popup.render();
    })
    .catch((error) => {
      console.warn("[popup] 영상 제목 조회 오류:", error.message);
    });
  popup.mount({
    onboarded: !!stored.group,
    group: stored.group || null,
    timelineKey: calcTimelineKey(installDate),
    installDate,
    participantCode: stored.participantCode || null,
    onStudyEndCodeVerified: () => {
      chrome.storage.local.set({ studyEndCodeVerified: true });
      postStudyEndReviewEvent("review_viewed");
    },
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
          participantToken: recovered.participantToken,
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
    // 큐 전송은 백그라운드: 렌더/상호작용을 막지 않음. 실패분은 큐에 남아 다음 open에서 재시도.
    flushPendingPopupEvents(stored.serverUrl);

    popupMetrics = {
      anonymousId: stored.anonymousId,
      participantToken: stored.participantToken,
      // 팝업 오픈당 1회 발급. 재전송돼도 서버가 이 id로 중복을 무시(멱등)
      eventId: crypto.randomUUID(),
      openedAt: new Date().toISOString(),
      startTs: Date.now(),
      tabTodayClicks: 0,
      tabWeekClicks: 0,
      // 열자마자 이미 확인된(블러 없는) 실제 리뷰가 보이고 있으면 그 자체로 열람.
      // 블러가 남아있는 경우엔 여기서 0으로 두고, "피드백 확인하기" 클릭 시점에 1로 갱신한다.
      // feedbackActive가 아니라 generating으로 게이팅: 대조군은 연구 종료 후
      // (studyEndTodayEligible) feedbackActive 없이도 오늘 리뷰가 조회·표시되므로,
      // 그 케이스도 놓치지 않기 위함. eligible이 아니면 review가 null이라 isRealReview가
      // 어차피 false가 되므로 feedbackActive로 따로 막을 필요가 없다.
      todayFeedbackViewed:
        !VL._todayCumulative.generating &&
        isRealReview(VL._todayCumulative.review) &&
        !VL._todayCumulative.locked
          ? 1
          : 0,
      periodFeedbackViewed: 0,
      periodTabMs: 0,
      // 주차별 탭에 현재 연속으로 머무는 중이면 그 시작 시각, 아니면 null.
      // 팝업은 항상 "오늘" 탭으로 열리므로 초기값은 null.
      feedbackTabEnteredAt: null,
    };
    persistLivePopupEvent(popupMetrics);

    // 탭 클릭 계측 + 피드백 확인 버튼
    // popEl은 re-render(innerHTML 교체) 후에도 유지되므로 위임 리스너로 한 번만 바인딩
    popEl.addEventListener("click", (e) => {
      const tabBtn = e.target.closest && e.target.closest("[data-tab]");
      if (tabBtn) {
        if (tabBtn.dataset.tab === "today") {
          popupMetrics.tabTodayClicks++;
          // 주차별 탭을 벗어나는 시점. 지금까지의 연속 체류를 확정하고 마커를 지운다.
          accruePeriodFeedbackDwell(popupMetrics);
          popupMetrics.feedbackTabEnteredAt = null;
        } else if (tabBtn.dataset.tab === "feedback") {
          popupMetrics.tabWeekClicks++;
          // 실제 열람 판정(periodFeedbackViewed)은 체류시간 기준으로 아래에서 확정한다.
          // 이미 연속 체류 중이면(중복 클릭 등) 시작 시각을 되돌리지 않는다.
          if (!popupMetrics.feedbackTabEnteredAt) {
            popupMetrics.feedbackTabEnteredAt = Date.now();
          }
        }
        persistLivePopupEvent(popupMetrics);
        return;
      }

      const confirmBtn =
        e.target.closest && e.target.closest("#vl-feedback-confirm-btn");
      if (confirmBtn) {
        popupMetrics.todayFeedbackViewed = 1;
        persistLivePopupEvent(popupMetrics);
        handleFeedbackConfirmClick(popup, confirmBtn.dataset.sessionId);
        return;
      }

      // 종료 안내(그룹 무관) — 서버 이벤트 기록은 대조군에게만 의미가 있다(EXP는 서버가 거부).
      const studyEndNoticeConfirmBtn =
        e.target.closest && e.target.closest("#vl-study-end-notice-confirm");
      if (studyEndNoticeConfirmBtn) {
        chrome.storage.local.set({ studyEndNoticeShown: true });
        if (VL.isConGroup(stored.group)) postStudyEndReviewEvent("modal_shown");
        return;
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

    /**
     * 팝업 종료 감지 시 호출. live 슬롯에 dwellMs 최종 스냅샷을 반영(단일 set, teardown에
     * 상대적으로 안전)하고 sendBeacon 백업 전송(전송 경로 2)을 동시에 시도한다. 최종 쓰기가
     * 잘려도 세션 중 스냅샷이 다음 boot에서 승격되므로, sendBeacon이 실패해도 데이터는 남는다.
     */
    const finalizePopupMetrics = () => {
      // 주차별 탭에 머문 채로 팝업이 닫히는 경우, 마지막 setInterval tick 이후의
      // 짧은 잔여 체류시간까지 마저 반영한다.
      accruePeriodFeedbackDwell(popupMetrics);
      persistLivePopupEvent(popupMetrics);
      sendPopupEventBeacon(stored.serverUrl, popupMetrics);
    };
    window.addEventListener("pagehide", finalizePopupMetrics);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) finalizePopupMetrics();
    });
  }

  // 로컬 캐시 — storage.onChanged로 갱신, setInterval에서는 캐시만 읽음
  let localCurrentSession = stored.currentSession || null;
  let localLastWatchedAt = stored.lastWatchedAt || null;

  // sessions가 바뀌면(분석 완료 등) 즉시 today 데이터를 갱신하고, 오늘 리뷰 캐시가
  // 바뀌면(background.js의 세션-종료 트리거가 생성을 마친 시점) 플레이스홀더를 실제
  // 리뷰로 교체한다. 둘 다 background.js가 거의 같은 시점에 갱신하므로 같은 이벤트
  // 배치 안에서 함께 올 수 있어, sessions를 먼저 반영해 "로컬에서 아는 오늘 세션 수"를
  // 최신으로 만든 뒤 오늘 리뷰 캐시를 판정한다.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes.currentSession)
      localCurrentSession = changes.currentSession.newValue || null;
    if (changes.lastWatchedAt)
      localLastWatchedAt = changes.lastWatchedAt.newValue || null;

    if (changes.sessions) {
      // 세션이 끝나 기록이 바뀌었으니 서버 집계도 다시 받는다(받은 뒤 다시 그림)
      reloadViewingSummary().then((changed) => {
        if (changed) popup.render();
      });
      const updatedSessions = changes.sessions.newValue || [];
      VL._allSessions = updatedSessions;
      const freshToday = buildDataForDate(updatedSessions, new Date());
      freshToday.collectingCount = localCurrentSession?.videoCount ?? 0;
      freshToday.collectingTimer = _computeTimerText(localLastWatchedAt);
      // 확인(블러) 상태는 여기서 다시 계산하지 않는다 — VL._todayCumulative(아래 분기)가
      // 유일한 소스다. sessions 변경은 도넛·영상목록 등 리뷰와 무관한 필드 갱신용.
      VL.today = freshToday;

      // 팝업을 연 채로 오늘 첫 세션이 막 끝난 경우 — boot() 시점엔 오늘 세션이 0개라
      // 대상에서 제외됐던 상태를 여기서 한 번만 다시 판정한다. 실제 리뷰 텍스트 반영은
      // 아래 changes.todayReviewsCache 분기(background.js가 같은 시점에 함께 갱신)가 담당한다.
      if (!todayCumulativeEligible) {
        const nowEligible = feedbackActive && freshToday.sessionIds.length > 0;
        if (nowEligible) {
          todayCumulativeEligible = true;
          VL._todayCumulative = await resolveTodayCumulative(
            true,
            Object.values(VL._todayReviewsByDate || {}),
            todaySessionsOf(updatedSessions),
          );
        }
      } else {
        // 리뷰를 건너뛴 세션은 리뷰 캐시가 바뀌지 않고 세션의 응답 여부만 바뀐다 — 여기서 다시 판정해
        // "생성 중"에서 벗어나게 한다
        VL._todayCumulative = await resolveTodayCumulative(
          true,
          Object.values(VL._todayReviewsByDate || {}),
          todaySessionsOf(updatedSessions),
        );
        VL._todayConfirmed = !VL._todayCumulative.locked;
      }

      if (installDate) {
        // 기간 리뷰는 세션이 갱신될 때마다 다시 조회하지 않는다 — 서버 cron이 하루/일주일에
        // 한 번만 새로 생성하므로, boot() 시점에 캐시로 가져온 값을 그대로 재사용한다.
        VL.weeks = buildWeeksData(installDate, cachedPeriodReviews);
      }
    }

    if (changes.todayReviewsCache && todayCumulativeEligible) {
      const newCache = changes.todayReviewsCache.newValue || null;
      if (newCache && newCache.anonymousId === stored.anonymousId) {
        const reviews = newCache.reviews || [];
        VL._todayReviewsByDate = Object.fromEntries(
          reviews.map((r) => [r.reviewDate, r]),
        );
        VL._todayCumulative = await resolveTodayCumulative(
          true,
          reviews,
          todaySessionsOf(VL._allSessions),
        );
        VL._todayConfirmed = !VL._todayCumulative.locked;
        if (
          !VL._todayCumulative.generating &&
          isRealReview(VL._todayCumulative.review) &&
          VL._todayConfirmed
        ) {
          clearUnviewedIconDot();
        }
      }
    }

    // 진행 중인 세션에 영상이 추가되거나 시청 시간이 기록되면 영상 목록을 다시 읽는다
    const liveVideosChanged = Object.keys(changes).some((key) =>
      key.startsWith("video__"),
    );
    if (liveVideosChanged) VL._liveVideos = await loadLiveVideos();

    if (changes.sessions || changes.todayReviewsCache || liveVideosChanged) {
      popup.render();
    }
  });

  // 수집 중 표시 실시간 업데이트 (1초 간격) — 캐시된 로컬 변수만 참조
  let prevIsCollecting = collectingCount > 0 || !!realToday.collectingTimer;

  setInterval(() => {
    VL._lastWatchedAt = localLastWatchedAt;

    if (popupMetrics) {
      // 주차별 탭에 머문 실제 경과 시간을 갱신. tick 횟수가 아니라 feedbackTabEnteredAt과의
      // 실제 시간차를 쓰므로, 탭 진입 직후 tick이 곧바로 돌아도 그만큼만 인정된다.
      accruePeriodFeedbackDwell(popupMetrics);
      // dwellMs 스냅샷 갱신. close write가 잘려도 최근값(±1초)이 보존됨
      persistLivePopupEvent(popupMetrics);
    }

    const count = localCurrentSession?.videoCount ?? 0;
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

/**
 * 오류를 background에 넘겨 원격 보고에 모은다. 원본 에러·화면 내용은 넘기지 않는다.
 * @param {string} code - error-report.js의 오류 코드
 * @param {string} where - error-report.js의 발생 위치
 * @returns {void}
 */
function reportClientError(code, where) {
  try {
    chrome.runtime
      .sendMessage({ type: "client-error", code, where })
      .catch(() => {});
  } catch {
    // 보고 실패로 팝업 흐름을 더 깨뜨리지 않는다
  }
}

boot().catch((err) => {
  // Fallback: opened directly in browser without chrome APIs
  if (typeof chrome === "undefined" || !chrome?.storage) {
    const popEl = document.getElementById("vl-popup-root");
    if (!popEl) return; // Studio는 자체적으로 마운트한다
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
    // 참여자에게는 빈 팝업으로 보이지만 서버 로그에는 남지 않는다
    reportClientError("POPUP_BOOT_FAILED", "popup.boot");
  }
});
