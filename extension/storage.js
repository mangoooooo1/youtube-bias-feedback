let queue = Promise.resolve();

// 같은 영상이 이 값 안에 다시 감지되면 "같은 시청"으로 보고 합친다.
// 10초는 비동기 storage 왕복 시간차보다는 넉넉하고, 사람이 같은 영상을 일부러 다시 재생하는 데 걸리는 시간보다는 짧게 잡은 값이다.
const NEAR_SIMULTANEOUS_MS = 10000;

// videos는 watchedAt 오름차순으로 정렬된 상태로 들어온다고 가정한다.
function dedupeNearSimultaneous(videos) {
  const lastSeenAt = new Map(); // videoId -> 가장 최근에 "유지하기로 한" 항목의 ms
  const result = [];
  for (const v of videos) {
    const t = new Date(v.watchedAt).getTime();
    const prev = lastSeenAt.get(v.videoId);
    if (prev !== undefined && t - prev <= NEAR_SIMULTANEOUS_MS) {
      // 중복으로 보고 건너뛴다. lastSeenAt은 그래도 이 시각으로 갱신해, "임계값 안에서
      // 계속 이어지는" 여러 건이 있어도(예: 세 탭) 전부 하나로 묶이게 한다(구간의 시작
      // 시각과의 차이가 아니라, 바로 직전 판정 시각과의 차이로 매번 다시 비교).
      lastSeenAt.set(v.videoId, t);
      continue;
    }
    lastSeenAt.set(v.videoId, t);
    result.push(v);
  }
  return result;
}

export async function getCurrentSession() {
  const { currentSession } = await chrome.storage.local.get("currentSession");
  return currentSession ?? null;
}

export async function getAllSessions() {
  const { sessions } = await chrome.storage.local.get("sessions");
  return sessions ?? [];
}

export async function clearCurrentSession() {
  await chrome.storage.local.set({ currentSession: null });
}

export function endSession() {
  queue = queue.then(() => _endSession());
  return queue;
}

// content.js가 영상 한 편마다 "video__<sessionId>__<uuid>" 키에 독립적으로 기록해 둔 것을
// 모아 세션 종료 시 하나의 videos 배열로 합친다.
async function _endSession() {
  const all = await chrome.storage.local.get(null);
  const { currentSession, sessions } = all;
  if (!currentSession) return;

  const videoEntries = Object.entries(all).filter(([key]) =>
    key.startsWith("video__"),
  );
  if (videoEntries.length === 0) return;

  // 키 형식은 "video__<sessionId>__<uuid>" — sessionId는 값이 아니라 키 이름에만 있다
  // (content.js가 그렇게 저장한다). sessionId는 숫자 문자열, uuid는 하이픈만 쓰므로
  // "__" 기준으로 나누면 안전하게 분리된다.
  const bySession = new Map();
  for (const [key, video] of videoEntries) {
    const sessionId = key.slice("video__".length).split("__")[0];
    const list = bySession.get(sessionId) ?? [];
    list.push(video);
    bySession.set(sessionId, list);
  }

  const endTime = new Date().toISOString();
  const closedSessions = [];
  for (const [sessionId, videos] of bySession) {
    videos.sort((a, b) => new Date(a.watchedAt) - new Date(b.watchedAt));
    // 마지막 방어선: 같은 videoId가 짧은 시간 안에 다시 나오면(새로고침 중복 방지 값이
    // 탭 경합으로 드물게 못 걸렀거나, 같은 영상을 여러 탭에서 동시에 열어둔 경우) 하나로
    // 합친다 — 버그 01과 같은 취지의 최종 안전망.
    const deduped = dedupeNearSimultaneous(videos);
    closedSessions.push({
      sessionId,
      startTime:
        sessionId === currentSession.sessionId
          ? currentSession.startTime
          : deduped[0].watchedAt,
      endTime,
      videos: deduped.map(({ videoId, title, watchedAt }) => ({
        videoId,
        title,
        watchedAt,
      })),
    });
  }

  const updatedSessions = [...(sessions ?? []), ...closedSessions];
  const keysToRemove = videoEntries.map(([key]) => key);

  await chrome.storage.local.set({
    sessions: updatedSessions,
    currentSession: null,
    lastRecordedVideo: null,
  });
  await chrome.storage.local.remove(keysToRemove);
}

export async function getLastWatchedAt() {
  const { lastWatchedAt } = await chrome.storage.local.get("lastWatchedAt");
  return lastWatchedAt ?? null;
}

// --- 온보딩 ---

export const VALID_GROUPS = ["EXP", "CON", "TEST-EXP", "TEST-CON"];

export async function getOnboarding() {
  const { anonymousId, group, installDate } = await chrome.storage.local.get([
    "anonymousId",
    "group",
    "installDate",
  ]);
  if (!group) return null;
  return { anonymousId, group, installDate };
}

export async function saveOnboarding(group) {
  await chrome.storage.local.set({
    anonymousId: crypto.randomUUID(),
    group,
    installDate: new Date().toISOString(),
  });
}

export function saveAnalysis(sessionId, analysisResult) {
  queue = queue.then(() => _saveAnalysis(sessionId, analysisResult));
  return queue;
}

async function _saveAnalysis(sessionId, analysisResult) {
  const { sessions } = await chrome.storage.local.get("sessions");
  if (!sessions) return;

  const updatedSessions = sessions.map((session) =>
    session.sessionId === sessionId
      ? { ...session, ...analysisResult }
      : session,
  );

  await chrome.storage.local.set({ sessions: updatedSessions });
}
