import {
  addVideo,
  endSession,
  getLastWatchedAt,
  getCurrentSession,
  getAllSessions,
  saveAnalysis,
} from "./storage.js";
import { fetchVideoCategories } from "./youtube.js";
import { calculateDistribution, calculateEntropy } from "./analysis.js";
import { buildPrompt, generateReview, generateFallbackReview } from "./llm.js";

const ALARM_NAME = "SESSION_TIMEOUT_CHECK";
const TIMEOUT_MS = 30 * 60 * 1000;

// service worker가 깨어날 때마다 실행 — 같은 이름의 alarm은 자동으로 교체됨
chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });

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

  console.log("[background] 30분 비활성 감지, 세션 종료");
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

  await saveAnalysis(session.sessionId, {
    categoryDistribution,
    entropy,
    videoCount,
  });
  console.log("[background] 분석 완료:", { entropy, categoryDistribution });

  const analysisData = { categoryDistribution, entropy, videoCount };
  const prompt = buildPrompt(analysisData);

  let review;
  try {
    review = await generateReview(prompt);
    console.log("[background] 리뷰 생성 완료");
  } catch (error) {
    console.warn("[background] 리뷰 생성 실패, 폴백 사용:", error.message);
    review = generateFallbackReview(analysisData);
  }

  await saveAnalysis(session.sessionId, { review });
  console.log("[background] 리뷰 저장 완료:", review);
}
