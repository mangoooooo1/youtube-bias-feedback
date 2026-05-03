export async function addVideo(videoId, title) {
  const { currentSession } = await chrome.storage.local.get('currentSession');

  const session = currentSession ?? {
    sessionId: String(Date.now()),
    startTime: new Date().toISOString(),
    videos: [],
  };

  const lastSaved = session.videos.at(-1);
  if (lastSaved?.videoId === videoId) return;

  session.videos.push({
    videoId,
    title,
    watchedAt: new Date().toISOString(),
  });

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
