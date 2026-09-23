import {
  endSession,
  getLastWatchedAt,
  getCurrentSession,
  getAllSessions,
  saveAnalysis,
  getOnboarding,
  getUnsentVideoEvents,
  markVideoEventSent,
  getUnsentWatchStats,
  markWatchStatsSent,
} from "./storage.js";
import { isBaselinePeriod } from "./pipeline/baseline.js";
import { SERVER_URL } from "./config.js";

const ALARM_NAME = "SESSION_TIMEOUT_CHECK";
const TIMEOUT_MS = 10 * 60 * 1000;

// 분석 완료 알림 대상 판정. EXP 그룹이면서 베이스라인 기간(설치 후 14일)이
// 끝난 경우에만 알림·배지를 노출한다.
const FEEDBACK_ELIGIBLE_GROUPS = new Set(["EXP", "TEST-EXP"]);

/**
 * TEST-EXP(연구자 모드)는 모든 화면을 미리 볼 수 있어야 하므로, 실제 참여자 온보딩과
 * 무관하게 베이스라인 게이트를 적용하면 안 된다.
 * @param {string} group - 참여자 그룹 코드
 * @returns {boolean} TEST- 접두사 그룹이면 true
 */
function isTestGroup(group) {
  return typeof group === "string" && group.startsWith("TEST");
}

/**
 * 분석 완료 알림 대상인지 판정한다. EXP 계열이면서 베이스라인 기간이 끝난 경우에만 true.
 * @param {string} group - 참여자 그룹 코드
 * @param {string} installDate - 설치일(ISO)
 * @returns {boolean}
 */
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

/**
 * 미열람 표시를 배지 텍스트 대신 아이콘에 점으로 그려 넣는다(OS·Chrome 버전 간
 * 렌더링 차이를 피하기 위함).
 * @returns {Promise<void>}
 */
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

/**
 * 미열람 아이콘 점을 원래 아이콘으로 되돌린다.
 * @returns {void}
 */
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

/**
 * 기본 아이콘 위에 미열람 표시용 빨간 점을 그려 ImageData로 반환한다.
 * @param {number} size - 아이콘 픽셀 크기
 * @returns {Promise<ImageData>}
 */
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
  retryUnsentWatchStats();
  checkSessionTimeout();
});

// 알림 본문/버튼 클릭 모두 같은 동작 — notificationId가 곧 sessionId이므로 별도 매핑 없이 역추적한다.
chrome.notifications.onButtonClicked.addListener(handleNotificationOpen);
chrome.notifications.onClicked.addListener(handleNotificationOpen);

/**
 * 알림 클릭 시 팝업을 열고 아이콘 점을 지운 뒤 열람을 서버에 기록한다.
 * @param {string} sessionId - 알림 id(=sessionId)
 * @returns {Promise<void>}
 */
async function handleNotificationOpen(sessionId) {
  chrome.notifications.clear(sessionId);
  clearUnviewedIconDot();
  chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html") });
  await markFeedbackViewed(sessionId);
}

/**
 * 알림 클릭을 "실제 열람 시작"으로 서버에 기록한다. 팝업 표시 기반 feedbackViewed보다
 * 엄격한 신호로, 알림을 거치지 않고 팝업만 연 경우는 기록하지 않는다.
 * @param {string} sessionId - 대상 세션 id
 * @returns {Promise<void>}
 */
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
        body: JSON.stringify({
          anonymousId: onboarding.anonymousId,
          participantToken: onboarding.participantToken,
        }),
      },
    );
    if (!response.ok) {
      console.warn("[background] 피드백 열람 기록 실패:", response.status);
    }
  } catch (error) {
    console.warn("[background] 피드백 열람 기록 오류:", error);
  }
}

/**
 * 마지막 시청 후 TIMEOUT_MS 이상 지났으면 현재 세션을 종료하고 분석을 시작한다.
 * @returns {Promise<void>}
 */
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

/**
 * 세션 종료 시 videoCount를 먼저 로컬에 기록해 "분석 대기" 상태를 표시하고,
 * 이어서 서버로 전송한다(categoryDistribution/entropy는 응답 후 채워짐).
 * @param {object} session - 종료된 세션(sessionId, videos 등)
 * @returns {Promise<void>}
 */
export async function analyzeSession(session) {
  // 여기서는 videoCount만 먼저 로컬에 기록해 "세션 종료, 서버 응답 대기" 상태를 표시한다.
  // categoryDistribution/entropy는 서버 응답을 받은 뒤(syncSessionToServer)에야 채워진다.
  const t0 = Date.now();
  const videoCount = session.videos.length;

  // syncedToServer를 false로 명시해둬야, 곧이어 서버 전송이 오프라인/오류로 실패했을 때
  // retryUnsyncedSessions()가 이 세션을 재시도 대상으로 찾아낼 수 있다(이 필드가 아예
  // 없는 - 이 기능이 생기기 전에 이미 분석됐던 - 세션과 구분하기 위한 값이다).
  await saveAnalysis(session.sessionId, {
    videoCount,
    syncedToServer: false,
  });

  const totalMs = Date.now() - t0;
  await syncSessionToServer({ ...session, videoCount }, { totalMs });
}

/**
 * 세션 분석 결과를 서버로 보내고 응답에 따라 오늘 리뷰 반영·알림까지 처리한다.
 * analyzeSession(최초 전송)과 retryUnsyncedSessions(재시도)가 공유하며, 실패 시
 * syncedToServer가 false로 남아 다음 알람 틱에 다시 시도된다.
 * @param {object} session - 전송할 세션
 * @param {{totalMs?: number}} [metrics] - 소요 시간 등 부가 지표
 * @returns {Promise<void>}
 */
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
    session.videoCount,
    onboarding,
    {
      ...metrics,
      feedbackNotifiedAt,
    },
  );

  // 409(중복 세션) — 이전 시도가 서버엔 이미 저장됐지만 응답만 못 받은 경우다. 서버가
  // 함께 보내주는 categoryDistribution/entropy로 로컬을 채우되, 값이 null이면
  // syncedToServer를 true로 확정하지 않아 다음 틱에 다시 시도되게 한다.
  if (postResult?.duplicate) {
    await saveAnalysis(session.sessionId, {
      categoryDistribution: postResult.categoryDistribution,
      entropy: postResult.entropy,
      syncedToServer: postResult.categoryDistribution !== null,
    });
    return;
  }
  // 이번에도 실패 — syncedToServer는 false로 남아 다음 알람 틱에서 다시 시도된다.
  if (postResult === null) return;

  // 서버가 이번 응답으로 돌려준 categoryDistribution/entropy를 이제야 로컬에 채운다.
  await saveAnalysis(session.sessionId, {
    categoryDistribution: postResult.categoryDistribution,
    entropy: postResult.entropy,
    syncedToServer: postResult.categoryDistribution !== null,
  });

  const todayReview = postResult?.todayReview ?? null;
  if (todayReview) {
    await saveAnalysis(session.sessionId, {
      review: todayReview.review,
      reviewTopic: todayReview.reviewTopic,
    });
  }
  await mergeTodayReviewIntoCache(onboarding?.anonymousId, todayReview);
  console.log("[background] 오늘 리뷰 반영 완료:", todayReview);

  // 알림 자격은 그룹·베이스라인만으로 미리 정해지지만, 실제 알림은 todayReview가
  // 있을 때만 띄운다 — 전송 실패로 todayReview가 null이면 알림만 뜨고 팝업엔
  // "생성 중"만 보이는 불일치가 생기기 때문이다.
  if (eligibleForNotification && todayReview) {
    showFeedbackNotification(session);
  }
}

/**
 * syncedToServer가 false로 남은(오프라인/서버 오류로 전송 실패한) 세션을 재전송한다.
 * 서버 장애·일시 오프라인으로 인한 연구 데이터 유실을 막는 유일한 재시도 경로다.
 * @returns {Promise<void>}
 */
export async function retryUnsyncedSessions() {
  const sessions = await getAllSessions();
  // categoryDistribution 유무는 이제 필터 기준이 아니다 — 그 값은 서버 응답으로만
  // 채워지므로, syncedToServer:false만이 "전송 대기"를 나타내는 유일한 신호다.
  const unsynced = sessions.filter((s) => s.syncedToServer === false);
  for (const session of unsynced) {
    // 재시도라 최초 지연시간(totalMs)은 더 이상 의미가 없어 보내지 않는다.
    await syncSessionToServer(session);
  }
}

/**
 * 아직 sent:true가 안 된 영상 이벤트를 찾아 서버로 재전송한다. content.js의 즉시
 * 전송(fire-and-forget)이 실패하면 재시도가 전혀 없었던 문제를 보완한다.
 * @returns {Promise<void>}
 */
export async function retryUnsentVideoEvents() {
  const onboarding = await getOnboarding();
  if (!onboarding?.anonymousId) return;

  const events = await getUnsentVideoEvents();
  for (const event of events) {
    const ok = await postVideoEventToServer(
      onboarding.anonymousId,
      onboarding.participantToken,
      event,
    );
    if (ok) await markVideoEventSent(event);
  }
}

/**
 * 아직 서버에 확정 반영 못한 시청시간 원시 데이터를 재전송한다. "영상을 봤다"(sent)와
 * "얼마나 봤다"(watchStatsSent)는 서로 다른 시점에 확정되는 별개 신호라 독립된 큐로 돈다.
 * @returns {Promise<void>}
 */
export async function retryUnsentWatchStats() {
  const onboarding = await getOnboarding();
  if (!onboarding?.anonymousId) return;

  const items = await getUnsentWatchStats();
  for (const item of items) {
    const ok = await postWatchStatsToServer(
      onboarding.anonymousId,
      onboarding.participantToken,
      item,
    );
    if (ok) await markWatchStatsSent(item);
  }
}

/**
 * 시청시간·배속·백그라운드 여부 하나를 PATCH로 서버에 반영한다.
 * @param {string} anonymousId
 * @param {string} participantToken
 * @param {{eventId: string, watchedSeconds: number, playbackRate: number, wasBackgrounded: 0|1}} item
 * @returns {Promise<boolean>} 성공 여부
 */
async function postWatchStatsToServer(anonymousId, participantToken, item) {
  if (!SERVER_URL || SERVER_URL.startsWith("YOUR_")) return false;
  if (!item.eventId) return false;

  const cleanUrl = SERVER_URL.replace(/\/$/, "");
  try {
    const response = await fetch(
      `${cleanUrl}/api/video-events/${encodeURIComponent(item.eventId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anonymousId,
          participantToken,
          watchedSeconds: item.watchedSeconds,
          playbackRate: item.playbackRate,
          wasBackgrounded: item.wasBackgrounded,
        }),
      },
    );
    if (!response.ok) {
      console.warn("[background] 시청시간 재전송 실패:", response.status);
    }
    return response.ok;
  } catch (error) {
    console.warn("[background] 시청시간 재전송 오류:", error);
    return false;
  }
}

/**
 * 영상 시청 이벤트 하나를 POST로 서버에 (재)전송한다. 같은 eventId는 서버가 멱등 처리한다.
 * @param {string} anonymousId
 * @param {string} participantToken
 * @param {object} event - videoId, title, watchedAt 등을 담은 이벤트
 * @returns {Promise<boolean>} 성공 여부
 */
async function postVideoEventToServer(anonymousId, participantToken, event) {
  if (!SERVER_URL || SERVER_URL.startsWith("YOUR_")) return false;

  const cleanUrl = SERVER_URL.replace(/\/$/, "");
  try {
    const response = await fetch(`${cleanUrl}/api/video-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anonymousId,
        participantToken,
        videoId: event.videoId,
        title: event.title ?? null,
        watchedAt: event.watchedAt,
        sessionId: event.sessionId,
        // 같은 eventId로 재전송되면 서버가 INSERT OR IGNORE로 걸러내 이미 성공했던 전송을 다시 보내도 중복 행이 남지 않는다.
        eventId: event.eventId,
        entryHost: event.entryHost,
        entryPath: event.entryPath,
        navigationTrigger: event.navigationTrigger,
        isShortsUrl: event.isShortsUrl,
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

/**
 * 피드백 알림을 띄운다. notificationId로 sessionId를 그대로 써 별도 매핑 없이 역추적한다.
 * @param {object} session - 알림을 띄울 세션(sessionId 사용)
 * @returns {void}
 */
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

/**
 * 팝업이 읽는 "오늘 누적 리뷰 이력" 캐시에 방금 받은 리뷰 하나만 갈아 끼운다.
 * @param {string} anonymousId
 * @param {object|null} todayReview - 없으면(자격 없음) 아무 것도 하지 않음
 * @returns {Promise<void>}
 */
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

/**
 * 세션 하나를 /api/sessions로 전송한다. 409(중복)면 서버가 이미 저장한
 * categoryDistribution/entropy를 함께 돌려받아 duplicate 응답으로 반환한다.
 * @param {object} session - 전송할 세션(videos 포함)
 * @param {number} videoCount
 * @param {{anonymousId: string, participantToken: string}} onboarding
 * @param {{totalMs?: number, feedbackNotifiedAt?: string|null}} [metrics]
 * @returns {Promise<object|null>} 서버 응답 데이터, 실패 시 null
 */
async function postSessionToServer(
  session,
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

  // categoryId 조회는 서버가 하므로, 이 세션에서 시청한 videoId 목록
  const videoIds = session.videos.map((v) => v.videoId);
  // videoIds와 병렬인 시청시간 원시값 — 서버가 video_events를 재조회하지 않고 이
  // 값을 그대로 쓴다(PATCH 재시도 지연으로 서버 쪽이 아직 비어있을 수 있어서).
  // 값 없는 영상은 null로 보내 서버 isValidWatch가 "모름"으로 처리한다.
  const watchedSecondsList = session.videos.map(
    (v) => v.watchedSeconds ?? null,
  );
  const cleanUrl = SERVER_URL.replace(/\/$/, "");

  try {
    const response = await fetch(`${cleanUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anonymousId: onboarding.anonymousId,
        participantToken: onboarding.participantToken,
        sessionId: session.sessionId,
        startTime: session.startTime,
        endTime: session.endTime,
        videoCount,
        videoIds,
        watchedSecondsList,
        totalMs: metrics.totalMs,
        feedbackNotifiedAt: metrics.feedbackNotifiedAt,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.warn("[background] 서버 전송 실패:", response.status, body);
      // 409(중복 세션) — 이전 시도가 서버엔 이미 반영됐지만 응답만 못 받았던 경우다.
      // 서버가 이미 저장된 categoryDistribution/entropy를 본문에 실어 보내므로 함께 꺼내 돌려준다.
      if (response.status === 409) {
        let data = null;
        try {
          data = JSON.parse(body)?.data ?? null;
        } catch {
          data = null;
        }
        return {
          duplicate: true,
          categoryDistribution: data?.categoryDistribution ?? null,
          entropy: data?.entropy ?? null,
        };
      }
      return null;
    }

    console.log("[background] 서버 전송 완료:", session.sessionId);
    const json = await response.json();
    return json?.data ?? null;
  } catch (error) {
    console.warn("[background] 서버 전송 오류:", error);
    return null;
  }
}
