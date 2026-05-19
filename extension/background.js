import { addVideo, endSession, getLastWatchedAt, getCurrentSession, saveAnalysis } from './storage.js';
import { fetchVideoCategories } from './youtube.js';
import { calculateDistribution, calculateEntropy } from './analysis.js';

const ALARM_NAME = 'SESSION_TIMEOUT_CHECK';
const TIMEOUT_MS = 30 * 60 * 1000;

// service worker가 깨어날 때마다 실행 — 같은 이름의 alarm은 자동으로 교체됨
chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'VIDEO_DETECTED') {
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
  console.log('[background] saved:', { videoId, title });
  return { ok: true };
}

async function checkSessionTimeout() {
  const lastWatchedAt = await getLastWatchedAt();
  if (!lastWatchedAt) return;

  const elapsed = Date.now() - new Date(lastWatchedAt).getTime();
  if (elapsed < TIMEOUT_MS) return;

  // endSession 후 currentSession이 null이 되므로 먼저 캡처
  const session = await getCurrentSession();

  console.log('[background] 30분 비활성 감지, 세션 종료');
  await endSession();

  if (!session || session.videos.length === 0) return;
  await analyzeSession(session);
}

async function analyzeSession(session) {
  const videoIds = session.videos.map((v) => v.videoId);
  const categoryMap = await fetchVideoCategories(videoIds);
  const categoryIds = videoIds.map((id) => categoryMap[id]);

  const categoryDistribution = calculateDistribution(categoryIds);
  const entropy = calculateEntropy(categoryDistribution);

  await saveAnalysis(session.sessionId, {
    categoryDistribution,
    entropy,
    videoCount: session.videos.length,
  });

  console.log('[background] 분석 완료:', { entropy, categoryDistribution });
}
