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

// 키 형식은 "video__<sessionId>__<uuid>" — sessionId는 값이 아니라 키 이름에만 있다
function sessionIdOf(videoKey) {
  return videoKey.slice("video__".length).split("__")[0];
}

function groupVideosBySession(videoEntries) {
  const bySession = new Map();
  for (const [key, video] of videoEntries) {
    const sessionId = sessionIdOf(key);
    const list = bySession.get(sessionId) ?? [];
    list.push(video);
    bySession.set(sessionId, list);
  }
  return bySession;
}

function buildClosedSession(sessionId, videos, startTime, endTime) {
  videos.sort((a, b) => new Date(a.watchedAt) - new Date(b.watchedAt));
  // 마지막 방어선: 같은 videoId가 짧은 시간 안에 다시 나오면(새로고침 중복 방지 값이
  // 탭 경합으로 드물게 못 걸렀거나, 같은 영상을 여러 탭에서 동시에 열어둔 경우) 하나로 합친다.
  const deduped = dedupeNearSimultaneous(videos);
  return {
    sessionId,
    startTime: startTime ?? deduped[0].watchedAt,
    endTime,
    videos: deduped.map(({ videoId, title, watchedAt }) => ({
      videoId,
      title,
      watchedAt,
    })),
  };
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

  const bySession = groupVideosBySession(videoEntries);
  const endTime = new Date().toISOString();
  const closedSessions = [];
  for (const [sessionId, videos] of bySession) {
    const startTime =
      sessionId === currentSession.sessionId
        ? currentSession.startTime
        : undefined;
    closedSessions.push(
      buildClosedSession(sessionId, videos, startTime, endTime),
    );
  }

  const updatedSessions = [...(sessions ?? []), ...closedSessions];
  const keysToRemove = videoEntries.map(([key]) => key);

  await chrome.storage.local.set({
    sessions: updatedSessions,
    currentSession: null,
    lastRecordedVideo: null,
  });
  await chrome.storage.local.remove(keysToRemove);

  // content.js(탭)는 백그라운드와 별개 실행 컨텍스트라 위 get(null) 스냅샷과
  // remove() 사이에 끼어들어, 방금 닫은 sessionId로 video__ 키를 새로 썼을 수
  // 있다(예: 자동재생으로 다음 영상이 감지된 직후 비활성 타임아웃이 세션을 닫은 경우).
  // 그대로 두면 다음 endSession() 호출 전까지, 혹은 그게 마지막 기록이면 영원히
  // 미반영으로 남으므로 즉시 재확인해 병합한다. 방금 닫힌 sessionId로 도착한 키만
  // 병합 대상이다 — 이미 새로 시작된 *다른* sessionId의 키는 절대 건드리지 않는다
  // (그건 지금 막 열린, 아직 진행 중인 세션이라 여기서 종료 처리하면 안 된다).
  const closedSessionIds = new Set(closedSessions.map((s) => s.sessionId));
  const late = await chrome.storage.local.get(null);
  const lateEntries = Object.entries(late).filter(
    ([key]) =>
      key.startsWith("video__") && closedSessionIds.has(sessionIdOf(key)),
  );
  if (lateEntries.length === 0) return;

  const lateBySession = groupVideosBySession(lateEntries);
  const mergedSessions = updatedSessions.map((session) => {
    const lateVideos = lateBySession.get(session.sessionId);
    if (!lateVideos) return session;
    return buildClosedSession(
      session.sessionId,
      [...session.videos, ...lateVideos],
      session.startTime,
      session.endTime,
    );
  });

  await chrome.storage.local.set({ sessions: mergedSessions });
  await chrome.storage.local.remove(lateEntries.map(([key]) => key));
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
