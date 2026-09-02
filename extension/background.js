import {
  endSession,
  getLastWatchedAt,
  getCurrentSession,
  getAllSessions,
  saveAnalysis,
  getOnboarding,
  getUnsentVideoEvents,
  markVideoEventSent,
} from "./storage.js";
import { fetchVideoCategories } from "./pipeline/youtube.js";
import {
  calculateDistribution,
  calculateEntropy,
} from "./pipeline/analysis.js";
import { isBaselinePeriod } from "./pipeline/baseline.js";
import { SERVER_URL } from "./config.js";

const ALARM_NAME = "SESSION_TIMEOUT_CHECK";
const TIMEOUT_MS = 10 * 60 * 1000;

// 분석 완료 알림 대상 판정. EXP 그룹이면서 베이스라인 기간(설치 후 14일)이
// 끝난 경우에만 알림·배지를 노출한다.
const FEEDBACK_ELIGIBLE_GROUPS = new Set(["EXP", "TEST-EXP"]);

// TEST-EXP(연구자 모드)는 "모든 화면을 미리 볼 수 있다"는 설계 의도(GROUPS 주석 참고)가 있어,
// 실제 참여자 온보딩과 무관하게 베이스라인 게이트를 적용하면 안 된다.
function isTestGroup(group) {
  return typeof group === "string" && group.startsWith("TEST");
}

function isFeedbackNotificationEligible(group, installDate) {
  if (!FEEDBACK_ELIGIBLE_GROUPS.has(group)) return false;
  return isTestGroup(group) || !isBaselinePeriod(installDate);
}

const BASE_ICON_PATHS = {
  16: "assets/icons/icon16.png",
  32: "assets/icons/icon32.png",
  48: "assets/icons/icon48.png",
  128: "assets/icons/icon128.png",
};

// 미열람 표시를 배지 텍스트("•") 대신 아이콘 자체에 그려 넣는다 — 배지 글리프는
// OS·Chrome 버전마다 렌더링이 달라질 수 있지만, 이렇게 그리면 픽셀이 고정되어 항상 동일하게 보인다.
async function setUnviewedIconDot() {
  try {
    const imageData = {};
    for (const size of Object.keys(BASE_ICON_PATHS).map(Number)) {
      imageData[size] = await drawIconWithDot(size);
    }
    chrome.action.setIcon({ imageData });
  } catch (error) {
    // 아이콘 그리기가 실패해도(예: OffscreenCanvas 미지원) 알림 자체는 이미 떴으므로 무시.
    console.warn("[background] 미열람 아이콘 표시 실패:", error.message);
  }
}

function clearUnviewedIconDot() {
  // setIcon의 상대 경로는 "확장 루트"가 아니라 "호출한 스크립트의 위치" 기준으로 풀린다.
  // background.js는 루트에 있어 상대 경로가 우연히 맞았을 뿐이므로, getURL로 명시적인
  // 절대 경로를 만들어 어디서 호출되든(팝업 등) 항상 정확하게 만든다.
  const path = Object.fromEntries(
    Object.entries(BASE_ICON_PATHS).map(([size, p]) => [
      size,
      chrome.runtime.getURL(p),
    ]),
  );
  chrome.action.setIcon({ path });
}

async function drawIconWithDot(size) {
  const response = await fetch(chrome.runtime.getURL(BASE_ICON_PATHS[size]));
  const bitmap = await createImageBitmap(await response.blob());

  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, size, size);

  const radius = Math.max(2, Math.round(size * 0.22));
  const cx = size - radius - 1;
  const cy = radius + 1;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = "#E11D2E";
  ctx.fill();

  return ctx.getImageData(0, 0, size, size);
}

// service worker가 깨어날 때마다 실행 — 같은 이름의 alarm은 자동으로 교체됨
chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });

// content script가 읽을 수 있도록 SERVER_URL을 storage에 저장
chrome.storage.local.set({ serverUrl: SERVER_URL });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  // 셋 다 await 없이 실행하므로 서로 순서가 보장되지 않는다 — 예를 들어
  // checkSessionTimeout이 세션을 막 끝낸 직후 같은 세션을 retryUnsyncedSessions가
  // 이 틱에서 곧바로 다시 집어도(혹은 그 반대여도) 안전하다: 서버가 세션은 409(중복
  // 세션), 영상은 eventId 기반 OR IGNORE로 멱등 처리하므로 중복 전송이 일어나도
  // 여분의 요청 하나로 끝나고 데이터가 중복 저장되거나 알림이 두 번 뜨지 않는다.
  retryUnsyncedSessions();
  retryUnsentVideoEvents();
  checkSessionTimeout();
});

// 알림 본문/버튼 클릭 모두 같은 동작 — notificationId가 곧 sessionId이므로 별도 매핑 없이 역추적한다.
chrome.notifications.onButtonClicked.addListener(handleNotificationOpen);
chrome.notifications.onClicked.addListener(handleNotificationOpen);

async function handleNotificationOpen(sessionId) {
  chrome.notifications.clear(sessionId);
  clearUnviewedIconDot();
  chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html") });
  await markFeedbackViewed(sessionId);
}

// 알림 클릭을 "실제 열람 시작"으로 서버에 기록 (). 팝업 표시 기반 feedbackViewed(10-5)보다
// 엄격한 신호 — 알림을 거치지 않고 그냥 팝업을 연 경우는 여기서 기록하지 않는다.
async function markFeedbackViewed(sessionId) {
  if (!SERVER_URL || SERVER_URL.startsWith("YOUR_")) return;
  const onboarding = await getOnboarding();
  if (!onboarding?.anonymousId) return;

  const cleanUrl = SERVER_URL.replace(/\/$/, "");
  try {
    const response = await fetch(
      `${cleanUrl}/api/sessions/${encodeURIComponent(sessionId)}/feedback-viewed`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anonymousId: onboarding.anonymousId }),
      },
    );
    if (!response.ok) {
      console.warn("[background] 피드백 열람 기록 실패:", response.status);
    }
  } catch (error) {
    console.warn("[background] 피드백 열람 기록 오류:", error);
  }
}

async function checkSessionTimeout() {
  const lastWatchedAt = await getLastWatchedAt();
  if (!lastWatchedAt) return;

  const elapsed = Date.now() - new Date(lastWatchedAt).getTime();
  if (elapsed < TIMEOUT_MS) return;

  const currentSession = await getCurrentSession();
  if (!currentSession) return;
  const sessionId = currentSession.sessionId;

  console.log("[background] 10분 비활성 감지, 세션 종료");
  await endSession();

  const sessions = await getAllSessions();
  const session = sessions.find((s) => s.sessionId === sessionId);
  if (!session || session.videos.length === 0) return;
  await analyzeSession(session);
}

export async function analyzeSession(session) {
  // 지연시간 측정 — 세션 종료 후 처리 파이프라인 전체를 t0로 감싼다.
  const t0 = Date.now();
  const videoIds = session.videos.map((v) => v.videoId);

  const ytStart = Date.now();
  const categoryMap = await fetchVideoCategories(videoIds);
  const youtubeMs = Date.now() - ytStart;
  const categoryIds = videoIds.map((id) => categoryMap[id]);

  const categoryDistribution = calculateDistribution(categoryIds);
  const entropy = calculateEntropy(categoryDistribution);
  const videoCount = session.videos.length;

  // syncedToServer를 false로 명시해둬야, 곧이어 서버 전송이 오프라인/오류로 실패했을 때
  // retryUnsyncedSessions()가 이 세션을 재시도 대상으로 찾아낼 수 있다(이 필드가 아예
  // 없는 - 이 기능이 생기기 전에 이미 분석됐던 - 세션과 구분하기 위한 값이다).
  await saveAnalysis(session.sessionId, {
    categoryDistribution,
    entropy,
    videoCount,
    syncedToServer: false,
  });
  console.log("[background] 분석 완료:", { entropy, categoryDistribution });

  const totalMs = Date.now() - t0;
  await syncSessionToServer(
    { ...session, categoryDistribution, entropy, videoCount },
    { totalMs, youtubeMs },
  );
}

// 세션 분석 결과를 서버로 보내고, 응답에 따라 오늘 리뷰 반영·알림까지 처리한다.
// analyzeSession(최초 전송)과 retryUnsyncedSessions(재시도)가 이 함수를 공유한다 —
// 최초 시도가 오프라인/서버 오류로 실패해도 syncedToServer가 false로 남기 때문에,
// pendingPopupEvents 큐(팝업 이벤트용)와 같은 취지로 다음 1분 알람 틱마다 다시 시도된다.
async function syncSessionToServer(session, metrics = {}) {
  // 알림 자격은 리뷰 생성 결과와 무관하게(그룹·베이스라인만으로) 미리 정해진다.
  // 이 값을 그대로 서버에 함께 보내 sessions.feedbackNotifiedAt에 기록한다.
  const onboarding = await getOnboarding();
  const eligibleForNotification = isFeedbackNotificationEligible(
    onboarding?.group,
    onboarding?.installDate,
  );
  const feedbackNotifiedAt = eligibleForNotification
    ? new Date().toISOString()
    : null;

  const postResult = await postSessionToServer(
    session,
    session.categoryDistribution,
    session.entropy,
    session.videoCount,
    onboarding,
    { ...metrics, feedbackNotifiedAt },
  );

  // 이전 시도가 서버엔 이미 저장됐지만(중복 세션 오류) 그 응답만 못 받아 실패로 남았던
  // 경우다 — 다시 보낼 필요는 없으니 재시도 대상에서만 제외한다.
  if (postResult === "DUPLICATE") {
    await saveAnalysis(session.sessionId, { syncedToServer: true });
    return;
  }
  // 이번에도 실패 — syncedToServer는 false로 남아 다음 알람 틱에서 다시 시도된다.
  if (postResult === null) return;

  await saveAnalysis(session.sessionId, { syncedToServer: true });

  const todayReview = postResult?.todayReview ?? null;
  if (todayReview) {
    await saveAnalysis(session.sessionId, {
      review: todayReview.review,
      reviewTopic: todayReview.reviewTopic,
    });
  }
  await mergeTodayReviewIntoCache(onboarding?.anonymousId, todayReview);
  console.log("[background] 오늘 리뷰 반영 완료:", todayReview);

  // 알림 "자격"(eligibleForNotification)은 그룹·베이스라인만으로 미리 정해지지만,
  // 실제로 알림을 띄우는 건 todayReview가 실제로 있을 때뿐이다 — 서버 전송이
  // 오프라인/오류로 실패해 todayReview가 null이면, 알림만 뜨고 팝업엔 "생성 중"만
  // 보이는 불일치가 생기기 때문이다.
  if (eligibleForNotification && todayReview) {
    showFeedbackNotification(session);
  }
}

// 1분마다 도는 알람에서 checkSessionTimeout과 함께 호출된다. 세션 종료 시점에
// 오프라인/서버 오류로 서버 전송이 실패해 syncedToServer가 false로 남은 세션을 다시
// 보낸다 — 서버 장애·일시적 오프라인으로 인한 연구 데이터 유실을 막는 유일한 재시도
// 경로다(연구 무결성 점검 항목 "서버 장애 대비 로컬 큐잉/재시도" 후속 조치).
export async function retryUnsyncedSessions() {
  const sessions = await getAllSessions();
  const unsynced = sessions.filter(
    (s) => s.categoryDistribution && s.syncedToServer === false,
  );
  for (const session of unsynced) {
    // 재시도라 최초 지연시간(totalMs/youtubeMs)은 더 이상 의미가 없어 보내지 않는다.
    await syncSessionToServer(session);
  }
}

// content.js가 영상 한 편을 볼 때마다 즉시 시도하는 /api/video-events 전송은 실패하면
// 그 자리에서 조용히 버려졌다(연구 무결성 점검: fire-and-forget이라 재시도가 전혀 없었음).
// 1분마다 도는 알람에서 checkSessionTimeout·retryUnsyncedSessions와 함께 호출돼,
// 아직 sent:true가 안 된 영상 이벤트를 찾아 다시 보낸다.
export async function retryUnsentVideoEvents() {
  const onboarding = await getOnboarding();
  if (!onboarding?.anonymousId) return;

  const events = await getUnsentVideoEvents();
  for (const event of events) {
    const ok = await postVideoEventToServer(onboarding.anonymousId, event);
    if (ok) await markVideoEventSent(event);
  }
}

async function postVideoEventToServer(anonymousId, event) {
  if (!SERVER_URL || SERVER_URL.startsWith("YOUR_")) return false;

  const cleanUrl = SERVER_URL.replace(/\/$/, "");
  try {
    const response = await fetch(`${cleanUrl}/api/video-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anonymousId,
        videoId: event.videoId,
        title: event.title ?? null,
        watchedAt: event.watchedAt,
        sessionId: event.sessionId,
        // 같은 eventId로 재전송되면 서버가 INSERT OR IGNORE로 걸러내 이미 성공했던 전송을 다시 보내도 중복 행이 남지 않는다.
        eventId: event.eventId,
        entryHost: event.entryHost,
        entryPath: event.entryPath,
        navigationTrigger: event.navigationTrigger,
      }),
    });
    if (!response.ok) {
      console.warn("[background] 영상 이벤트 재전송 실패:", response.status);
    }
    return response.ok;
  } catch (error) {
    console.warn("[background] 영상 이벤트 재전송 오류:", error);
    return false;
  }
}

// 버튼 클릭 시 별도 매핑 없이 세션을 역추적한다. 자격 판정은 호출부가 미리 끝내둔 상태로 호출한다.
function showFeedbackNotification(session) {
  chrome.notifications.create(session.sessionId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("assets/icons/icon128.png"),
    title: "ViewLens",
    message: "방금 시청한 내용을 반영해 오늘의 피드백이 업데이트됐어요.",
    buttons: [{ title: "피드백 보러 가기" }],
  });
  // 개수 대신 있음/없음만 표시 — 정확한 미열람 개수는 연구 지표가 아니다.
  setUnviewedIconDot();
}

// 팝업이 읽는 "오늘 누적 리뷰 이력" 캐시
// 방금 서버가 돌려준 오늘 행 하나만 갈아 끼운다. 자격이 없어 todayReview가 null이면 아무것도 쓰지 않는다.
async function mergeTodayReviewIntoCache(anonymousId, todayReview) {
  if (!anonymousId || !todayReview) return;
  const { todayReviewsCache } =
    await chrome.storage.local.get("todayReviewsCache");
  const existing =
    todayReviewsCache?.anonymousId === anonymousId
      ? todayReviewsCache.reviews || []
      : [];
  const reviews = [
    ...existing.filter((r) => r.reviewDate !== todayReview.reviewDate),
    todayReview,
  ];
  await chrome.storage.local.set({
    todayReviewsCache: { anonymousId, reviews },
  });
}

async function postSessionToServer(
  session,
  categoryDistribution,
  entropy,
  videoCount,
  onboarding,
  metrics = {},
) {
  if (!SERVER_URL || SERVER_URL.startsWith("YOUR_")) {
    console.warn(
      "[background] SERVER_URL이 설정되지 않았습니다. config.js 설정을 확인해주세요.",
    );
    return null;
  }

  if (!onboarding?.anonymousId) {
    console.warn("[background] anonymousId 없음, 서버 전송 건너뜀");
    return null;
  }

  const cleanUrl = SERVER_URL.replace(/\/$/, "");

  try {
    const response = await fetch(`${cleanUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anonymousId: onboarding.anonymousId,
        sessionId: session.sessionId,
        startTime: session.startTime,
        endTime: session.endTime,
        videoCount,
        categoryDistribution,
        entropy:
          typeof entropy === "number" && Number.isFinite(entropy)
            ? entropy
            : undefined,
        totalMs: metrics.totalMs,
        youtubeMs: metrics.youtubeMs,
        feedbackNotifiedAt: metrics.feedbackNotifiedAt,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.warn("[background] 서버 전송 실패:", response.status, body);
      // 409(중복 세션) — 이전 시도가 서버엔 이미 반영됐지만 응답만 못 받았던 경우다.
      // 호출부(syncSessionToServer)가 재전송 없이 재시도 목록에서만 빼도록 구분해 알려준다.
      return response.status === 409 ? "DUPLICATE" : null;
    }

    console.log("[background] 서버 전송 완료:", session.sessionId);
    const json = await response.json();
    return json?.data ?? null;
  } catch (error) {
    console.warn("[background] 서버 전송 오류:", error);
    return null;
  }
}
