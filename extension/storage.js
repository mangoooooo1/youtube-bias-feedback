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
        watchStatsSource,
        checkpointAt,
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
        // 체크포인트로 대신 보낸 값인지 — 세션이 닫힌 뒤에도 더 새로운 체크포인트를 보낼 수 있게 함께 옮긴다
        watchStatsSource,
        checkpointAt,
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

// 영상 POST가 확정되지 않았거나(sent:false) 영구 실패한(sent:"invalid") 항목은 서버에 행이 없어 PATCH가 404가 되므로 POST를 기다린다
function isWatchStatsPending(v) {
  return (
    v?.watchedSeconds != null &&
    v.watchStatsSent === false &&
    v.sent !== false &&
    v.sent !== "invalid"
  );
}

// content.js가 재생 중에 영상마다 덮어쓰는 시청시간 체크포인트 키 접두사(watchcp__<eventId>).
// 탭을 닫아 최종값을 남기지 못한 영상은 이 값을 대신 보낸다.
export const WATCH_CHECKPOINT_PREFIX = "watchcp__";
// 체크포인트가 이 시간 넘게 갱신되지 않으면 그 영상을 재던 탭은 닫혔거나 다른 영상으로 넘어간 것으로 본다
export const WATCH_CHECKPOINT_STALE_MS = 2 * 60 * 1000;
// 영상 기록을 찾지 못하는 체크포인트는 세션 정리가 끝난 뒤에도 남은 것만 지운다
const ORPHAN_CHECKPOINT_MS = 24 * 60 * 60 * 1000;

/** eventId → 영상 기록(live 키가 sessions[]보다 우선). */
function indexVideoEntries(all) {
  const entries = new Map();
  for (const session of all.sessions ?? []) {
    for (const v of session.videos ?? []) {
      if (v.eventId) {
        entries.set(v.eventId, {
          location: "session",
          sessionId: session.sessionId,
          v,
        });
      }
    }
  }
  for (const [key, v] of Object.entries(all)) {
    if (key.startsWith("video__") && v?.eventId) {
      entries.set(v.eventId, {
        location: "live",
        key,
        sessionId: sessionIdOf(key),
        v,
      });
    }
  }
  return entries;
}

/**
 * 영상을 떠날 때·탭을 닫을 때 남긴 최종 시청시간인가. 체크포인트로 대신 보낸 값은 탭이 다시
 * 살아나 더 큰 체크포인트를 쓸 수 있어 확정값으로 보지 않는다. 출처가 없는 예전 기록은 최종값이다.
 */
function hasFinalWatchStats(v) {
  return v.watchedSeconds != null && v.watchStatsSource !== "checkpoint";
}

/** 이 체크포인트가 영상 기록에 이미 반영한 체크포인트보다 새로운가. */
function isNewerCheckpoint(cp, v) {
  return v.checkpointAt == null || (cp.at ?? 0) > v.checkpointAt;
}

/**
 * 더 쓸 일이 없는 체크포인트를 지운다 — 영상 기록에 최종값이 있거나 영구 실패한 것,
 * 이미 보낸 것, 영상 기록을 찾지 못한 채 하루가 지난 것.
 * @param {number} [now]
 * @returns {Promise<void>}
 */
export async function pruneWatchCheckpoints(now = Date.now()) {
  const all = await chrome.storage.local.get(null);
  const entries = indexVideoEntries(all);
  const done = Object.entries(all)
    .filter(([key, cp]) => {
      if (!key.startsWith(WATCH_CHECKPOINT_PREFIX)) return false;
      const entry = entries.get(cp?.eventId);
      if (!entry) return now - (cp?.at ?? 0) > ORPHAN_CHECKPOINT_MS;
      return (
        hasFinalWatchStats(entry.v) ||
        entry.v.watchStatsSent === "invalid" ||
        !isNewerCheckpoint(cp, entry.v)
      );
    })
    .map(([key]) => key);
  if (done.length > 0) await chrome.storage.local.remove(done);
}

/**
 * 로컬엔 있지만 아직 서버에 확정 반영 못한 시청시간 원시값을 live/sessions[] 양쪽에서
 * 모은다. content.js는 live 키만 갱신할 수 있어, 세션이 그 사이 닫힌 경우의 안전망이다.
 * 시청시간이 끝내 확정되지 않은 영상은 오래된 체크포인트 값을 대신 넣는다(source:"checkpoint").
 * @param {number} [now]
 * @returns {Promise<object[]>}
 */
export async function getUnsentWatchStats(now = Date.now()) {
  const all = await chrome.storage.local.get(null);

  const fromLive = Object.entries(all)
    .filter(([key, v]) => key.startsWith("video__") && isWatchStatsPending(v))
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
    (session.videos ?? []).filter(isWatchStatsPending).map((v) => ({
      location: "session",
      sessionId: session.sessionId,
      eventId: v.eventId,
      watchedSeconds: v.watchedSeconds,
      playbackRate: v.playbackRate,
      wasBackgrounded: v.wasBackgrounded,
    })),
  );

  const entries = indexVideoEntries(all);
  const fromCheckpoints = Object.entries(all)
    .filter(([key]) => key.startsWith(WATCH_CHECKPOINT_PREFIX))
    .flatMap(([, cp]) => {
      const entry = entries.get(cp?.eventId);
      if (!entry || now - (cp.at ?? 0) <= WATCH_CHECKPOINT_STALE_MS) return [];
      const { v } = entry;
      // 최종값이 있거나 영구 실패했거나 이미 보낸 체크포인트거나 영상 POST가 아직이면(PATCH가 404) 보내지 않는다
      if (hasFinalWatchStats(v) || v.watchStatsSent === "invalid") return [];
      if (!isNewerCheckpoint(cp, v)) return [];
      if (v.sent === false || v.sent === "invalid") return [];
      return [
        {
          location: entry.location,
          ...(entry.key ? { key: entry.key } : {}),
          sessionId: entry.sessionId,
          eventId: cp.eventId,
          watchedSeconds: cp.watchedSeconds,
          playbackRate: cp.playbackRate,
          wasBackgrounded: cp.wasBackgrounded,
          at: cp.at,
          source: "checkpoint",
        },
      ];
    });

  return [...fromLive, ...fromSessions, ...fromCheckpoints];
}

/**
 * getUnsentWatchStats()가 돌려준 항목 하나를 watchStatsSent:true로 표시한다.
 * @param {object} item - location/key/sessionId/eventId를 담은 항목
 * @returns {Promise<void>}
 */
export function markWatchStatsSent(item) {
  queue = queue.then(() => _setWatchStatsSent(item, true));
  return queue;
}

/**
 * 서버가 400으로 영원히 거부할 시청시간을 watchStatsSent:"invalid"로 표시해 재시도 대상에서 뺀다.
 * @param {object} item - location/key/sessionId/eventId를 담은 항목
 * @returns {Promise<void>}
 */
export function markWatchStatsInvalid(item) {
  queue = queue.then(() => _setWatchStatsSent(item, "invalid"));
  return queue;
}

/**
 * 전송한 값이 아직 그 영상 기록의 최신 상태일 때만 갱신한 기록을 돌려준다(아니면 null).
 * 전송 중에 content.js가 더 새로운 시청시간을 썼다면 그 값이 다음 재시도에서 나가도록 둔다.
 * 체크포인트 값으로 보냈으면 최종값이나 더 새로운 체크포인트 값이 없을 때만 그 값을 출처·시각과 함께 남긴다.
 */
function withWatchStatsSent(v, item, value) {
  if (item.source === "checkpoint") {
    if (hasFinalWatchStats(v) || !isNewerCheckpoint(item, v)) return null;
    if (value !== true) return { ...v, watchStatsSent: value };
    return {
      ...v,
      watchedSeconds: item.watchedSeconds,
      playbackRate: item.playbackRate,
      wasBackgrounded: item.wasBackgrounded,
      watchStatsSent: value,
      watchStatsSource: "checkpoint",
      checkpointAt: item.at,
    };
  }
  if (v.watchedSeconds !== item.watchedSeconds) return null;
  return { ...v, watchStatsSent: value };
}

/**
 * watchStatsSent 갱신 로직 — location(live/session)에 따라 대상을 찾아 갱신한다.
 * @param {object} item
 * @param {true|"invalid"} value
 * @returns {Promise<void>}
 */
async function _setWatchStatsSent(item, value) {
  if (item.location === "live") {
    const { [item.key]: existing } = await chrome.storage.local.get(item.key);
    if (!existing) return;
    const updated = withWatchStatsSent(existing, item, value);
    if (updated) await chrome.storage.local.set({ [item.key]: updated });
    return;
  }

  const { sessions } = await chrome.storage.local.get("sessions");
  if (!sessions) return;
  let changed = false;
  const updatedSessions = sessions.map((session) => {
    if (session.sessionId !== item.sessionId) return session;
    return {
      ...session,
      videos: (session.videos ?? []).map((v) => {
        if (v.eventId !== item.eventId) return v;
        const updated = withWatchStatsSent(v, item, value);
        if (!updated) return v;
        changed = true;
        return updated;
      }),
    };
  });
  if (changed) await chrome.storage.local.set({ sessions: updatedSessions });
}

/**
 * getUnsentVideoEvents()가 돌려준 항목 하나를 sent:true로 표시한다. sessions 배열
 * 갱신은 다른 쓰기와 마찬가지로 queue를 거쳐 직렬화한다.
 * @param {object} event
 * @returns {Promise<void>}
 */
export function markVideoEventSent(event) {
  queue = queue.then(() => _setVideoEventSent(event, true));
  return queue;
}

/**
 * 서버가 400으로 영원히 거부할 영상 이벤트를 sent:"invalid"로 표시해 재시도 대상에서 뺀다.
 * 로컬에는 남겨 원인 조사가 가능하다.
 * @param {object} event
 * @returns {Promise<void>}
 */
export function markVideoEventInvalid(event) {
  queue = queue.then(() => _setVideoEventSent(event, "invalid"));
  return queue;
}

/**
 * sent 갱신 로직 — location(live/session)에 따라 대상을 찾아 갱신한다.
 * @param {object} event
 * @param {true|"invalid"} value
 * @returns {Promise<void>}
 */
async function _setVideoEventSent(event, value) {
  if (event.location === "live") {
    const { [event.key]: existing } = await chrome.storage.local.get(event.key);
    // 이미 세션 종료로 sessions[]로 옮겨졌거나(키 삭제) 다른 재시도가 먼저 표시한 경우.
    if (!existing) return;
    await chrome.storage.local.set({
      [event.key]: { ...existing, sent: value },
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
          ? { ...v, sent: value }
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
 * 참여자 등록 게이트(background.js의 ensureParticipantSynced)가 쓰는 상태만 모아 읽는다.
 *
 * getOnboarding()에 participantCode·participantSynced를 덧붙이지 않고 별도 접근자를 두는 이유:
 * getOnboarding()은 세션·영상·시청시간 전송 등 다섯 곳이 공유하는데, 이 세 필드는 등록
 * 게이트만 쓴다. 공유 접근자를 게이트 전용 필드로 부풀리지 않고, 게이트가 필요한 값을
 * storage 한 번 읽기로 가져오게 한다.
 *
 * @returns {Promise<{anonymousId: string, group: string, installDate: string,
 *   participantCode: string|null, synced: boolean, failure: object|null,
 *   requestKey: string}|null>}
 *   등록을 시도할 수 없는 상태(온보딩 전, 필수 값 누락)면 null
 */
export async function getParticipantSyncState() {
  const stored = await chrome.storage.local.get([
    "anonymousId",
    "group",
    "installDate",
    "participantCode",
    "participantSynced",
    "participantSyncFailure",
    "participantToken",
  ]);
  // 팝업 boot의 재동기화 조건(viewlens-popup.js)과 같은 값 — 셋 중 하나라도 없으면
  // registerParticipant가 missing_field 400을 돌려주므로 요청 자체를 보내지 않는다.
  if (!stored.group || !stored.anonymousId || !stored.installDate) return null;
  return {
    anonymousId: stored.anonymousId,
    group: stored.group,
    installDate: stored.installDate,
    participantCode: stored.participantCode ?? null,
    synced: !!stored.participantSynced,
    tokenMissing: stored.participantToken === undefined,
    failure: stored.participantSyncFailure ?? null,
    requestKey: participantRequestKey(stored),
  };
}

/**
 * 등록 요청의 내용을 식별하는 키. 영구 실패(400) 판정이 "어떤 요청에 대한 것"인지 묶어둬,
 * 요청 내용이 달라지면 그 판정이 자동으로 무효가 되게 한다.
 */
function participantRequestKey({
  anonymousId,
  group,
  installDate,
  participantCode,
}) {
  return [anonymousId, group, installDate, participantCode ?? ""].join("|");
}

/**
 * 등록 성공을 기록한다. 팝업의 syncParticipant와 같은 두 값을 쓰고, 남아 있던 실패 기록을 지운다.
 * participantToken이 null인 것도 정상이다(서버 PARTICIPANT_TOKEN_SECRET 미설정).
 * @param {string|null} participantToken
 * @returns {Promise<void>}
 */
export async function markParticipantSynced(participantToken) {
  await chrome.storage.local.set({ participantSynced: true, participantToken });
  await chrome.storage.local.remove("participantSyncFailure");
}

/**
 * 등록 실패를 기록한다. attempts와 firstFailedAt은 직전 기록에서 이어받아, 연구자가
 * "이 상태가 얼마나 오래됐는지"를 참여자 PC에서 확인할 수 있게 한다.
 * @param {"retryable"|"permanent"} kind - permanent면 이후 틱에서 재시도하지 않는다
 * @param {number|null} httpStatus - 네트워크 오류·타임아웃이면 null
 * @param {string|null} code - 서버 ERROR_CODES 또는 network/timeout
 * @param {object|null} prev - 직전 participantSyncFailure
 * @param {string} requestKey - 이 판정이 적용되는 요청 내용(participantRequestKey)
 * @returns {Promise<void>}
 */
export async function recordParticipantSyncFailure(
  kind,
  httpStatus,
  code,
  prev,
  requestKey,
) {
  const now = new Date().toISOString();
  await chrome.storage.local.set({
    participantSyncFailure: {
      kind,
      httpStatus,
      code,
      // 어떤 요청에 대한 판정인지 함께 남긴다. 재온보딩으로 참여코드·설치일이 바뀌면
      // 이 키가 달라져 낡은 permanent가 새 등록을 막지 못한다.
      requestKey,
      attempts: (prev?.attempts ?? 0) + 1,
      firstFailedAt: prev?.firstFailedAt ?? now,
      lastFailedAt: now,
    },
  });
}

/**
 * 서버가 토큰을 거부했을 때(INVALID_PARTICIPANT_TOKEN) 등록 확인 상태를 되돌린다.
 *
 * participantSynced는 "서버에 내 participants 행이 있고 내 토큰이 유효하다"의 캐시인데,
 * 서버 응답으로 내려가는 경로가 없으면 한 번 true가 된 뒤 영원히 true로 남는 단방향
 * 래치가 된다. 그 상태에서 PARTICIPANT_TOKEN_SECRET이 새로 설정되면 기존 참여자는
 * 토큰이 null인 채 모든 요청이 403이 되고, 게이트는 synced:true라 아무것도 하지 않아
 * 복구 수단이 사라진다. 이 함수가 그 래치를 푼다.
 *
 * @returns {Promise<boolean>} 이번 호출로 상태가 실제로 바뀌었는지. 403이 연속될 때
 *   매 틱 storage를 쓰거나 같은 로그를 반복하지 않도록 호출부가 이 값으로 거른다.
 */
export async function invalidateParticipantSync() {
  const { participantSynced } =
    await chrome.storage.local.get("participantSynced");
  if (!participantSynced) return false;
  await chrome.storage.local.set({ participantSynced: false });
  return true;
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
