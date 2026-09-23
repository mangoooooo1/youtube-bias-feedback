let queue = Promise.resolve();

// 같은 영상이 이 값 안에 다시 감지되면 "같은 시청"으로 보고 합친다.
// 10초는 비동기 storage 왕복 시간차보다는 넉넉하고, 사람이 같은 영상을 일부러 다시 재생하는 데 걸리는 시간보다는 짧게 잡은 값이다.
const NEAR_SIMULTANEOUS_MS = 10000;

/**
 * NEAR_SIMULTANEOUS_MS 이내에 같은 videoId가 다시 나오면 같은 시청으로 보고 합친다.
 * @param {Array<{videoId: string, watchedAt: string}>} videos - watchedAt 오름차순으로 정렬된 목록
 * @returns {Array} 중복 제거된 목록
 */
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

/**
 * 진행 중인 세션을 읽는다.
 * @returns {Promise<object|null>}
 */
export async function getCurrentSession() {
  const { currentSession } = await chrome.storage.local.get("currentSession");
  return currentSession ?? null;
}

/**
 * 종료된 세션 전체를 읽는다.
 * @returns {Promise<object[]>}
 */
export async function getAllSessions() {
  const { sessions } = await chrome.storage.local.get("sessions");
  return sessions ?? [];
}

/**
 * 진행 중인 세션을 지운다.
 * @returns {Promise<void>}
 */
export async function clearCurrentSession() {
  await chrome.storage.local.set({ currentSession: null });
}

/**
 * 세션 종료를 큐에 직렬화해 실행한다(동시 호출 시 경합 방지).
 * @returns {Promise<void>}
 */
export function endSession() {
  queue = queue.then(() => _endSession());
  return queue;
}

/**
 * "video__<sessionId>__<uuid>" 형식의 키에서 sessionId를 뽑는다.
 * @param {string} videoKey
 * @returns {string}
 */
function sessionIdOf(videoKey) {
  return videoKey.slice("video__".length).split("__")[0];
}

/**
 * video__ 키-값 목록을 sessionId 기준으로 묶는다.
 * @param {Array<[string, object]>} videoEntries - chrome.storage.local의 [key, value] 목록
 * @returns {Map<string, object[]>} sessionId -> 그 세션의 videos 배열
 */
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

/**
 * 세션 하나에 속한 video__ 항목들을 시간순 정렬·중복 제거해 최종 세션 객체로 만든다.
 * @param {string} sessionId
 * @param {object[]} videos - 이 세션의 video__ 항목들
 * @param {string|undefined} startTime - 없으면 첫 영상의 watchedAt을 쓴다
 * @param {string} endTime
 * @returns {object} { sessionId, startTime, endTime, videos }
 */
function buildClosedSession(sessionId, videos, startTime, endTime) {
  videos.sort((a, b) => new Date(a.watchedAt) - new Date(b.watchedAt));
  // 마지막 방어선: 같은 videoId가 짧은 시간 안에 다시 나오면(새로고침 중복 방지 값이
  // 탭 경합으로 드물게 못 걸렀거나, 같은 영상을 여러 탭에서 동시에 열어둔 경우) 하나로 합친다.
  const deduped = dedupeNearSimultaneous(videos);
  return {
    sessionId,
    startTime: startTime ?? deduped[0].watchedAt,
    endTime,
    // sent/eventId를 그대로 들고 간다 — 세션 종료로 video__ 키가 사라진 뒤에도
    // getUnsentVideoEvents()가 sessions[].videos에서 재시도 대상을 판단하고,
    // 재시도 시 같은 eventId로 보내야 서버가 중복을 걸러낸다.
    videos: deduped.map(
      ({
        videoId,
        title,
        watchedAt,
        sent,
        eventId,
        entryHost,
        entryPath,
        navigationTrigger,
        isShortsUrl,
        watchedSeconds,
        playbackRate,
        wasBackgrounded,
        watchStatsSent,
      }) => ({
        videoId,
        title,
        watchedAt,
        sent,
        eventId,
        entryHost,
        entryPath,
        navigationTrigger,
        isShortsUrl,
        // 시청시간 원시 데이터 — 세션이 닫혀 video__ 키가 이 배열로 옮겨간
        // 뒤에도 background.js가 재시도 큐·세션 전송(watchedSecondsList)에 쓸 수 있도록
        // 그대로 들고 간다.
        watchedSeconds,
        playbackRate,
        wasBackgrounded,
        watchStatsSent,
      }),
    ),
  };
}

/**
 * content.js가 video__ 키로 흩어 기록한 영상들을 세션 단위로 모아 sessions[]로 옮긴다.
 * 이후 늦게 도착한 같은 세션의 video__ 키가 있으면 재확인해 병합까지 처리한다.
 * @returns {Promise<void>}
 */
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

  // content.js는 별개 컨텍스트라 위 스냅샷과 remove() 사이에 방금 닫은 sessionId로
  // video__ 키를 새로 썼을 수 있다 — 그대로 두면 영원히 미반영되므로 즉시 재확인해
  // 병합한다. 이미 새로 시작된 *다른* sessionId의 키는 건드리지 않는다.
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

/**
 * 마지막 시청 시각을 읽는다.
 * @returns {Promise<string|null>}
 */
export async function getLastWatchedAt() {
  const { lastWatchedAt } = await chrome.storage.local.get("lastWatchedAt");
  return lastWatchedAt ?? null;
}

/**
 * 아직 서버에 sent:true로 확정 못한 영상 이벤트를 live(video__)와 종료된
 * sessions[] 양쪽에서 모아 반환한다.
 * @returns {Promise<object[]>}
 */
export async function getUnsentVideoEvents() {
  const all = await chrome.storage.local.get(null);

  const fromLive = Object.entries(all)
    .filter(([key, v]) => key.startsWith("video__") && v?.sent === false)
    .map(([key, v]) => ({
      location: "live",
      key,
      sessionId: sessionIdOf(key),
      videoId: v.videoId,
      title: v.title,
      watchedAt: v.watchedAt,
      eventId: v.eventId,
      entryHost: v.entryHost,
      entryPath: v.entryPath,
      navigationTrigger: v.navigationTrigger,
      isShortsUrl: v.isShortsUrl,
    }));

  const fromSessions = (all.sessions ?? []).flatMap((session) =>
    (session.videos ?? [])
      .filter((v) => v.sent === false)
      .map((v) => ({
        location: "session",
        sessionId: session.sessionId,
        videoId: v.videoId,
        title: v.title,
        watchedAt: v.watchedAt,
        eventId: v.eventId,
        entryHost: v.entryHost,
        entryPath: v.entryPath,
        navigationTrigger: v.navigationTrigger,
        isShortsUrl: v.isShortsUrl,
      })),
  );

  return [...fromLive, ...fromSessions];
}

/**
 * 로컬엔 있지만 아직 서버에 확정 반영 못한 시청시간 원시값을 live/sessions[] 양쪽에서
 * 모은다. content.js는 live 키만 갱신할 수 있어, 세션이 그 사이 닫힌 경우의 안전망이다.
 * @returns {Promise<object[]>}
 */
export async function getUnsentWatchStats() {
  const all = await chrome.storage.local.get(null);

  const fromLive = Object.entries(all)
    .filter(
      ([key, v]) =>
        key.startsWith("video__") &&
        v?.watchedSeconds != null &&
        v?.watchStatsSent === false,
    )
    .map(([key, v]) => ({
      location: "live",
      key,
      sessionId: sessionIdOf(key),
      eventId: v.eventId,
      watchedSeconds: v.watchedSeconds,
      playbackRate: v.playbackRate,
      wasBackgrounded: v.wasBackgrounded,
    }));

  const fromSessions = (all.sessions ?? []).flatMap((session) =>
    (session.videos ?? [])
      .filter((v) => v.watchedSeconds != null && v.watchStatsSent === false)
      .map((v) => ({
        location: "session",
        sessionId: session.sessionId,
        eventId: v.eventId,
        watchedSeconds: v.watchedSeconds,
        playbackRate: v.playbackRate,
        wasBackgrounded: v.wasBackgrounded,
      })),
  );

  return [...fromLive, ...fromSessions];
}

/**
 * getUnsentWatchStats()가 돌려준 항목 하나를 watchStatsSent:true로 표시한다.
 * @param {object} item - location/key/sessionId/eventId를 담은 항목
 * @returns {Promise<void>}
 */
export function markWatchStatsSent(item) {
  queue = queue.then(() => _markWatchStatsSent(item));
  return queue;
}

/**
 * markWatchStatsSent의 실제 갱신 로직 — location(live/session)에 따라 대상을 찾아 갱신한다.
 * @param {object} item
 * @returns {Promise<void>}
 */
async function _markWatchStatsSent(item) {
  if (item.location === "live") {
    const { [item.key]: existing } = await chrome.storage.local.get(item.key);
    if (!existing) return;
    await chrome.storage.local.set({
      [item.key]: { ...existing, watchStatsSent: true },
    });
    return;
  }

  const { sessions } = await chrome.storage.local.get("sessions");
  if (!sessions) return;
  const updatedSessions = sessions.map((session) => {
    if (session.sessionId !== item.sessionId) return session;
    return {
      ...session,
      videos: (session.videos ?? []).map((v) =>
        v.eventId === item.eventId ? { ...v, watchStatsSent: true } : v,
      ),
    };
  });
  await chrome.storage.local.set({ sessions: updatedSessions });
}

/**
 * getUnsentVideoEvents()가 돌려준 항목 하나를 sent:true로 표시한다. sessions 배열
 * 갱신은 다른 쓰기와 마찬가지로 queue를 거쳐 직렬화한다.
 * @param {object} event
 * @returns {Promise<void>}
 */
export function markVideoEventSent(event) {
  queue = queue.then(() => _markVideoEventSent(event));
  return queue;
}

/**
 * markVideoEventSent의 실제 갱신 로직 — location(live/session)에 따라 대상을 찾아 갱신한다.
 * @param {object} event
 * @returns {Promise<void>}
 */
async function _markVideoEventSent(event) {
  if (event.location === "live") {
    const { [event.key]: existing } = await chrome.storage.local.get(event.key);
    // 이미 세션 종료로 sessions[]로 옮겨졌거나(키 삭제) 다른 재시도가 먼저 표시한 경우.
    if (!existing) return;
    await chrome.storage.local.set({
      [event.key]: { ...existing, sent: true },
    });
    return;
  }

  const { sessions } = await chrome.storage.local.get("sessions");
  if (!sessions) return;
  const updatedSessions = sessions.map((session) => {
    if (session.sessionId !== event.sessionId) return session;
    return {
      ...session,
      videos: (session.videos ?? []).map((v) =>
        v.videoId === event.videoId && v.watchedAt === event.watchedAt
          ? { ...v, sent: true }
          : v,
      ),
    };
  });
  await chrome.storage.local.set({ sessions: updatedSessions });
}

// --- 온보딩 ---

export const VALID_GROUPS = ["EXP", "CON", "TEST-EXP", "TEST-CON"];

/**
 * 온보딩 정보를 읽는다. group이 없으면(온보딩 전) null을 반환한다.
 * @returns {Promise<{anonymousId: string, group: string, installDate: string, participantToken: string}|null>}
 */
export async function getOnboarding() {
  const { anonymousId, group, installDate, participantToken } =
    await chrome.storage.local.get([
      "anonymousId",
      "group",
      "installDate",
      "participantToken",
    ]);
  if (!group) return null;
  return { anonymousId, group, installDate, participantToken };
}

/**
 * 참여자를 온보딩 처리한다 — anonymousId를 새로 발급하고 그룹·설치일을 저장한다.
 * @param {string} group - VALID_GROUPS 중 하나
 * @returns {Promise<void>}
 */
export async function saveOnboarding(group) {
  await chrome.storage.local.set({
    anonymousId: crypto.randomUUID(),
    group,
    installDate: new Date().toISOString(),
  });
}

/**
 * 세션 분석 결과 저장을 큐에 직렬화해 실행한다.
 * @param {string} sessionId
 * @param {object} analysisResult - 병합할 필드들
 * @returns {Promise<void>}
 */
export function saveAnalysis(sessionId, analysisResult) {
  queue = queue.then(() => _saveAnalysis(sessionId, analysisResult));
  return queue;
}

/**
 * saveAnalysis의 실제 병합 로직 — 해당 sessionId의 세션에 필드를 merge한다.
 * @param {string} sessionId
 * @param {object} analysisResult
 * @returns {Promise<void>}
 */
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
