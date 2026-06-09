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
import { calculateDistribution, calculateEntropy } from "./pipeline/analysis.js";
import { buildPrompt, generateReview, generateFallbackReview } from "./pipeline/llm.js";
import { SERVER_URL } from "./config.js";

const ALARM_NAME = "SESSION_TIMEOUT_CHECK";
const TIMEOUT_MS = 10 * 60 * 1000;

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

async function analyzeSession(session) {
  const videoIds = session.videos.map((v) => v.videoId);
  const categoryMap = await fetchVideoCategories(videoIds);
  const categoryIds = videoIds.map((id) => categoryMap[id]);

  const categoryDistribution = calculateDistribution(categoryIds);
  const entropy = calculateEntropy(categoryDistribution);
  const videoCount = session.videos.length;
  const videoTitles = session.videos.map((v) => v.title).filter(Boolean);

  await saveAnalysis(session.sessionId, {
    categoryDistribution,
    entropy,
    videoCount,
  });
  console.log("[background] 분석 완료:", { entropy, categoryDistribution });

  const analysisData = {
    categoryDistribution,
    entropy,
    videoCount,
    videoTitles,
  };
  const prompt = buildPrompt(analysisData);

  let result;
  try {
    result = await generateReview(prompt);
    console.log("[background] 리뷰 생성 완료");
  } catch (error) {
    console.warn("[background] 리뷰 생성 실패, 폴백 사용:", error.message);
    result = generateFallbackReview(analysisData);
  }

  await saveAnalysis(session.sessionId, {
    review: result.feedback,
    reviewTopic: result.topic,
  });
  console.log("[background] 리뷰 저장 완료:", result);

  await postSessionToServer(session, categoryDistribution, entropy, videoCount);
}

async function postSessionToServer(
  session,
  categoryDistribution,
  entropy,
  videoCount,
) {
  if (!SERVER_URL || SERVER_URL.startsWith("YOUR_")) {
    console.warn(
      "[background] SERVER_URL이 설정되지 않았습니다. config.js 설정을 확인해주세요.",
    );
    return;
  }

  const onboarding = await getOnboarding();
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
