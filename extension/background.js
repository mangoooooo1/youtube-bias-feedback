import {
  addVideo,
  endSession,
  getLastWatchedAt,
  getCurrentSession,
  getAllSessions,
  saveAnalysis,
  getOnboarding,
} from "./storage.js";
import { fetchVideoCategories } from "./pipeline/youtube.js";
import {
  calculateDistribution,
  calculateTopicDistribution,
  calculateEntropy,
} from "./pipeline/analysis.js";
import {
  buildPrompt,
  generateReview,
  generateFallbackReview,
} from "./pipeline/llm.js";
import { isBaselinePeriod } from "./pipeline/baseline.js";
import { SERVER_URL } from "./config.js";

const ALARM_NAME = "SESSION_TIMEOUT_CHECK";
const TIMEOUT_MS = 10 * 60 * 1000;

// 분석 완료 알림 대상 판정 (10-8). EXP 그룹이면서 베이스라인 기간(설치 후 14일)이
// 끝난 경우에만 알림·배지를 노출한다 — 판정 로직을 이 한 곳에 모아둬 알림·배지·서버
// 코드는 건드릴 필요가 없게 한다.
// extension/popup/viewlens-data.js의 GROUPS 중 feedback:true인 그룹(EXP/TEST-EXP)과
// 반드시 동일하게 유지해야 한다 — background.js는 popup 쪽 데이터 파일을 import할 수 없어(모듈 경계) 중복 정의한다.
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "VIDEO_DETECTED") {
    handleVideoDetected(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: error.message }));
    return true;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
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

async function handleVideoDetected(message) {
  const { videoId, title } = message;
  await addVideo(videoId, title);
  console.log("[background] saved:", { videoId, title });
  return { ok: true };
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

// 현재 세션을 제외하고, 분석이 완료된(entropy가 유한 숫자인) 가장 최근 세션의 entropy를 반환
function findPrevEntropy(sessions, currentSessionId) {
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    if (s.sessionId === currentSessionId) continue;
    if (Number.isFinite(s.entropy)) return s.entropy;
  }
  return null;
}

async function analyzeSession(session) {
  // 지연시간 측정 — 세션 종료 후 처리 파이프라인 전체를 t0로 감싼다.
  const t0 = Date.now();
  const videoIds = session.videos.map((v) => v.videoId);

  const ytStart = Date.now();
  const videoMetadata = await fetchVideoCategories(videoIds);
  const youtubeMs = Date.now() - ytStart;
  const categoryIds = videoIds.map((id) => videoMetadata[id]?.categoryId ?? null);
  const topicCategoriesPerVideo = videoIds.map(
    (id) => videoMetadata[id]?.topicCategories ?? [],
  );

  const categoryDistribution = calculateDistribution(categoryIds);
  const entropy = calculateEntropy(categoryDistribution);
  // 세밀 다양성 신호(Story 10-7) — 연구 분석용으로 세션 단위 저장만 한다. 팝업 노출 여부는
  // 별도 결정 사항이라 analysisData(buildPrompt 입력)에는 아직 포함하지 않는다.
  const topicDistribution = calculateTopicDistribution(topicCategoriesPerVideo);
  const topicEntropy = calculateEntropy(topicDistribution);
  const videoCount = session.videos.length;
  const videoTitles = session.videos.map((v) => v.title).filter(Boolean);

  // saveAnalysis로 현재 세션에 entropy를 저장하기 전에 직전 세션 entropy를 조회
  const allSessions = await getAllSessions();
  const prevEntropy = findPrevEntropy(allSessions, session.sessionId);

  await saveAnalysis(session.sessionId, {
    categoryDistribution,
    entropy,
    topicDistribution,
    topicEntropy,
    videoCount,
  });
  console.log("[background] 분석 완료:", {
    entropy,
    prevEntropy,
    categoryDistribution,
    topicEntropy,
  });

  const analysisData = {
    categoryDistribution,
    entropy,
    prevEntropy,
    videoCount,
    videoTitles,
  };
  const prompt = buildPrompt(analysisData);

  let result;
  // LLM 성공/폴백 로깅 (). generateReview가 실패 사유를 태깅해 던지므로 분류해 기록한다.
  let llmStatus = "success";
  let failureReason = null;
  let httpStatus = null;
  let timedOut = 0; // SQLite INTEGER — 1/0
  // 성공/폴백 무관하게 Gemini 호출(및 타임아웃까지의 대기) 소요를 기록한다.
  const geminiStart = Date.now();
  try {
    result = await generateReview(prompt);
    console.log("[background] 리뷰 생성 완료");
  } catch (error) {
    llmStatus = "fallback";
    // 태깅 안 된 예상 밖 에러는 network_error로 수렴(죽은 카테고리 방지)
    failureReason = error.failureReason || "network_error";
    httpStatus = error.httpStatus ?? null;
    timedOut = error.timedOut === true ? 1 : 0;
    console.warn(
      "[background] 리뷰 생성 실패, 폴백 사용:",
      failureReason,
      error.message,
    );
    result = generateFallbackReview(analysisData);
  }
  const geminiMs = Date.now() - geminiStart;

  await saveAnalysis(session.sessionId, {
    review: result.feedback,
    reviewTopic: result.topic,
  });
  console.log("[background] 리뷰 저장 완료:", result);

  // 알림·전송 모두 온보딩 정보(그룹·anonymousId)가 필요해 한 번만 조회해 공유한다.
  const onboarding = await getOnboarding();

  const feedbackNotifiedAt = notifyFeedbackReady(session, onboarding)
    ? new Date().toISOString()
    : null;

  const totalMs = Date.now() - t0;
  await postSessionToServer(
    session,
    categoryDistribution,
    entropy,
    videoCount,
    onboarding,
    {
      totalMs,
      youtubeMs,
      geminiMs,
      llmStatus,
      failureReason,
      httpStatus,
      timedOut,
      feedbackNotifiedAt,
      review: result.feedback,
      reviewTopic: result.topic,
      source: result.source,
      promptVersion: result.promptVersion,
      topicDistribution,
      topicEntropy,
    },
  );
}

// 분석 완료 알림 + 배지 표시 (). 대상이면 true를 반환해 호출부가 feedbackNotifiedAt을 기록하게 한다.
// notificationId로 session.sessionId를 그대로 사용 — 버튼 클릭 시 별도 매핑 없이 세션을 역추적한다.
function notifyFeedbackReady(session, onboarding) {
  if (
    !isFeedbackNotificationEligible(onboarding?.group, onboarding?.installDate)
  ) {
    return false;
  }
  chrome.notifications.create(session.sessionId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("assets/icons/icon128.png"),
    title: "ViewLens",
    message: "이번 세션 분석이 준비됐어요.",
    buttons: [{ title: "피드백 보러 가기" }],
  });
  // 개수 대신 있음/없음만 표시 — 정확한 미열람 개수는 연구 지표가 아니다.
  setUnviewedIconDot();
  return true;
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
    return;
  }

  if (!onboarding?.anonymousId) {
    console.warn("[background] anonymousId 없음, 서버 전송 건너뜀");
    return;
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
        geminiMs: metrics.geminiMs,
        llmStatus: metrics.llmStatus,
        failureReason: metrics.failureReason,
        httpStatus: metrics.httpStatus,
        timedOut: metrics.timedOut,
        feedbackNotifiedAt: metrics.feedbackNotifiedAt,
        review: metrics.review,
        reviewTopic: metrics.reviewTopic,
        source: metrics.source,
        promptVersion: metrics.promptVersion,
        topicDistribution: metrics.topicDistribution,
        topicEntropy: metrics.topicEntropy,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.warn("[background] 서버 전송 실패:", response.status, body);
      return;
    }

    console.log("[background] 서버 전송 완료:", session.sessionId);
  } catch (error) {
    console.warn("[background] 서버 전송 오류:", error);
  }
}
