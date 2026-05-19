let queue = Promise.resolve();

export function addVideo(videoId, title) {
  queue = queue.then(() => _addVideo(videoId, title));
  return queue;
}

async function _addVideo(videoId, title) {
  const now = new Date().toISOString();
  const { currentSession } = await chrome.storage.local.get('currentSession');

  const session = currentSession ?? {
    sessionId: String(Date.now()),
    startTime: now,
    videos: [],
  };

  // 중복 여부와 무관하게 먼저 갱신: 같은 영상을 계속 시청 중인 경우도 활성 시청이므로
  await chrome.storage.local.set({ lastWatchedAt: now });

  const lastSaved = session.videos.at(-1);
  if (lastSaved?.videoId === videoId) return;

  session.videos.push({ videoId, title, watchedAt: now });

  await chrome.storage.local.set({ currentSession: session });
}

export async function getCurrentSession() {
  const { currentSession } = await chrome.storage.local.get('currentSession');
  return currentSession ?? null;
}

export async function getAllSessions() {
  const { sessions } = await chrome.storage.local.get('sessions');
  return sessions ?? [];
}

export async function clearCurrentSession() {
  await chrome.storage.local.set({ currentSession: null });
}

export function endSession() {
  queue = queue.then(() => _endSession());
  return queue;
}

async function _endSession() {
  const { currentSession, sessions } = await chrome.storage.local.get([
    'currentSession',
    'sessions',
  ]);

  if (!currentSession || currentSession.videos.length === 0) return;

  const closedSession = {
    ...currentSession,
    endTime: new Date().toISOString(),
  };

  const updatedSessions = [...(sessions ?? []), closedSession];

  await chrome.storage.local.set({
    sessions: updatedSessions,
    currentSession: null,
  });
}

export async function getLastWatchedAt() {
  const { lastWatchedAt } = await chrome.storage.local.get('lastWatchedAt');
  return lastWatchedAt ?? null;
}

export function saveAnalysis(sessionId, analysisResult) {
  queue = queue.then(() => _saveAnalysis(sessionId, analysisResult));
  return queue;
}

async function _saveAnalysis(sessionId, analysisResult) {
  const { sessions } = await chrome.storage.local.get('sessions');
  if (!sessions) return;

  const updatedSessions = sessions.map((session) =>
    session.sessionId === sessionId
      ? { ...session, ...analysisResult }
      : session
  );

  await chrome.storage.local.set({ sessions: updatedSessions });
}
