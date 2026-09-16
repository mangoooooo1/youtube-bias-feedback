/**
 * URL에서 유튜브 영상 ID를 추출한다.
 * @param {string} url - 파싱할 URL
 * @returns {string|null} /watch?v=, /shorts/ 형식만 지원, 그 외는 null
 */
function extractVideoId(url) {
  try {
    const parsed = new URL(url);

    if (parsed.pathname.startsWith("/shorts/")) {
      const id = parsed.pathname.split("/")[2];
      return id || null;
    }

    if (parsed.pathname === "/watch") {
      return parsed.searchParams.get("v");
    }

    return null;
  } catch {
    return null;
  }
}

// server/routes/video-events-classify.js의 YOUTUBE_HOSTS와 동일
// 런타임이 달라 모듈 공유가 안 돼 중복 정의(바뀌면 양쪽 다 갱신).
const YOUTUBE_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

/**
 * 직전 페이지 URL에서 도메인·경로를 뽑는다. 경로는 유튜브 내부 페이지일 때만 담는다.
 * 외부 사이트 경로는 계정ID 등 식별 정보를 담을 수 있어 애초에 안 보낸다(서버가
 * referrerType 분류로 한 번 더 거름, server/routes/video-events.js).
 *
 * @param {string|null} href - 직전 페이지의 URL(예: document.referrer 또는 이전 location.href)
 * @returns {{ entryHost: string|null, entryPath: string|null }}
 */
function parseEntryLocation(href) {
  if (!href) return { entryHost: null, entryPath: null };
  try {
    const parsed = new URL(href);
    const entryPath = YOUTUBE_HOSTS.has(parsed.hostname)
      ? parsed.pathname
      : null;
    return { entryHost: parsed.hostname, entryPath };
  } catch {
    return { entryHost: null, entryPath: null };
  }
}

/**
 * 문서 제목에서 유튜브 특유의 접두사(안 읽은 알림 수)·접미사(" - YouTube")를 제거한다.
 * @returns {string|null} 정제된 제목, placeholder("YouTube")이거나 없으면 null
 */
function parseTitle() {
  const raw = document.title;
  if (!raw) return null;
  // placeholder 판정은 접두사(안 읽은 알림 개수)·접미사(" - YouTube") 제거 이후에 해야 한다.
  const cleaned = raw
    .replace(/^\(\d+\)\s+/, "")
    .replace(/\s+-\s+YouTube$/, "")
    .trim();
  return cleaned && cleaned !== "YouTube" ? cleaned : null;
}

/**
 * 지금까지 추적 중이던 영상의 시청시간 스냅샷을 반환한다(클릭성 이탈 판별용 원시 데이터).
 * watchTracker는 파일 하단에서 선언되지만 호출은 항상 그 이후 시점이라 문제없고,
 * typeof 가드는 이 함수만 격리 테스트할 때 예외 대신 null을 반환하게 한다.
 * @returns {{watchedSeconds: number|null, playbackRate: number|null, wasBackgrounded: 0|1}|null} watchTracker가 없으면 null
 */
function captureWatchStatsSnapshot() {
  if (typeof watchTracker === "undefined" || !watchTracker) return null;
  return {
    watchedSeconds: watchTracker.lastWatchedSeconds ?? null,
    playbackRate: watchTracker.lastPlaybackRate ?? null,
    wasBackgrounded: watchTracker.sawHidden ? 1 : 0,
  };
}

/**
 * recordVideo가 방금 기록한 영상의 sessionId·eventId
 * 이 탭의 실행 컨텍스트 안에서만 사는 값이라, background.js의 세션 타임아웃이
 * storage의 lastRecordedVideo를 null로 지워도 영향받지 않는다.
 * rememberTrackedVideo(recordVideo 안에서 호출)가 갱신한다.
 * @type {{sessionId: string, eventId: string}|null}
 */
let trackedVideoIdentity = null;

/**
 * 지금 추적 중인 영상의 식별자를 반환한다. handleVideoChange가 이동 감지 직후(동기
 * 구간, resetWatchTracker가 다음 영상용으로 리셋하기 전)에 호출해야 정확하다.
 * typeof 가드는 이 함수만 격리 테스트할 때 예외 대신 null을 반환하게 한다.
 * @returns {{sessionId: string, eventId: string}|null}
 */
function captureTrackedVideoIdentity() {
  return typeof trackedVideoIdentity !== "undefined"
    ? trackedVideoIdentity
    : null;
}

/**
 * document.title이 prevTitle과 달라질 때까지 폴링해 새 제목을 기다린다.
 * @param {string|null} prevTitle - 비교 기준이 되는 이전 제목
 * @param {number} [maxRetries=10] - 최대 폴링 횟수
 * @param {number} [interval=200] - 폴링 간격(ms)
 * @returns {Promise<string|null>} 새 제목, 시간 내 못 구하면 null
 */
function waitForTitle(prevTitle, maxRetries = 10, interval = 200) {
  return new Promise((resolve) => {
    let attempts = 0;

    const check = () => {
      const title = parseTitle();
      if (title && title !== prevTitle) {
        resolve(title);
        return;
      }
      attempts++;
      if (attempts >= maxRetries) {
        resolve(null);
        return;
      }
      setTimeout(check, interval);
    };

    check();
  });
}

// 서비스 워커 수면과 무관하게 storage에 직접 기록
let writeQueue = Promise.resolve();

/**
 * 이 탭의 실행 컨텍스트 안에서만 사는 값이다. storage의 lastRecordedVideo는
 * background.js의 세션 타임아웃(endSession)이 전혀 다른 실행 컨텍스트에서
 * 언제든 null로 지울 수 있다. 한 영상을 끊기지 않고 10분 넘게 계속 보기만 해도
 * lastWatchedAt이 그 영상 "시작" 시각에 고정된 채라 세션이 강제 종료되기 때문이다
 * 이 값에 우선 의존하면 그 클로버링에 영향받지 않는다.
 * @type {{sessionId: string, eventId: string}|null}
 */
function rememberTrackedVideo(sessionId, eventId) {
  if (typeof trackedVideoIdentity === "undefined") return;
  trackedVideoIdentity = { sessionId, eventId };
}

/**
 * 특정 영상의 video_events 행(들)에 patch를 병합한다. 라이브 키(video__)가 있으면
 * 그쪽을, 이미 세션 종료로 sessions[]에 옮겨갔다면 그 안의 해당 영상 항목을 찾아 갱신한다.
 * @param {{sessionId: string, eventId: string}} target - 갱신 대상 식별 정보
 * @param {object} patch - 병합할 필드
 * @returns {Promise<boolean>} 실제로 어딘가에서 찾아 갱신했으면 true
 */
async function applyWatchStatsPatch(target, patch) {
  const videoKey = `video__${target.sessionId}__${target.eventId}`;
  const { [videoKey]: live } = await chrome.storage.local.get(videoKey);
  if (live) {
    await chrome.storage.local.set({ [videoKey]: { ...live, ...patch } });
    return true;
  }

  const { sessions } = await chrome.storage.local.get("sessions");
  if (!Array.isArray(sessions)) return false;
  let found = false;
  const updated = sessions.map((session) => {
    if (session.sessionId !== target.sessionId) return session;
    return {
      ...session,
      videos: (session.videos ?? []).map((v) => {
        if (v.eventId !== target.eventId) return v;
        found = true;
        return { ...v, ...patch };
      }),
    };
  });
  if (!found) return false;
  await chrome.storage.local.set({ sessions: updated });
  return true;
}

/**
 * 방금 떠난 영상의 실제 시청시간·배속·백그라운드 여부를 서버 video_events 행에 반영한다.
 * 실패해도 로컬에 watchStatsSent:false로 남겨 background.js의 재시도 큐가 찾아내게 한다.
 * @param {{sessionId: string, eventId: string}} target - 방금 떠난 영상의 식별 정보
 * @param {{watchedSeconds: number|null, playbackRate: number|null, wasBackgrounded: 0|1}} stats - captureWatchStatsSnapshot 결과
 * @returns {Promise<void>}
 */
async function finalizePreviousWatchStats(target, stats) {
  // 라이브 키·sessions[] 어디에도 없으면(참여자가 데이터를 지웠거나 하는 극단적
  // 경우) 조용히 포기한다. 갱신할 대상 자체가 없다.
  const applied = await applyWatchStatsPatch(target, {
    ...stats,
    watchStatsSent: false,
  });
  if (!applied) return;

  const { anonymousId, serverUrl, participantToken } =
    await chrome.storage.local.get([
      "anonymousId",
      "serverUrl",
      "participantToken",
    ]);
  if (!anonymousId || !serverUrl || serverUrl.startsWith("YOUR_")) return;

  try {
    const response = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/video-events/${encodeURIComponent(target.eventId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anonymousId, participantToken, ...stats }),
      },
    );
    if (response.ok && chrome.runtime?.id) {
      await applyWatchStatsPatch(target, { watchStatsSent: true });
    }
  } catch {
    // 네트워크 오류 — watchStatsSent:false로 남아 재시도 큐 대상이 된다.
  }
}

/**
 * 새 영상 감지를 로컬 저장소에 기록하고 서버로 전송한다. 탭마다 독립된 콘텐츠 스크립트가
 * 돌아 큐만으로는 다중 탭 동시 시청 시 경합을 못 막는다.
 * @param {string} videoId - 감지된 videoId
 * @param {string|null} title - 영상 제목
 * @param {string|null} entryHost - 직전 페이지 도메인
 * @param {string|null} entryPath - 직전 페이지 경로(유튜브 내부일 때만)
 * @param {"ended"|"interaction"|null} navigationTrigger - 전환 원인 추정값
 * @param {{watchedSeconds: number|null, playbackRate: number|null, wasBackgrounded: 0|1}|null} previousWatchStats - 직전 영상의 시청시간 스냅샷
 * @param {{sessionId: string, eventId: string}|null} previousVideoIdentity - captureTrackedVideoIdentity 결과(이 탭 메모리 기준)
 * @returns {Promise<void>}
 */
function recordVideo(
  videoId,
  title,
  entryHost,
  entryPath,
  navigationTrigger,
  previousWatchStats,
  previousVideoIdentity,
) {
  writeQueue = writeQueue.then(async () => {
    // 확장 리로드/업데이트 후 남은 탭은 새로고침 전까지 컨텍스트가 무효화돼 chrome.*
    // 호출이 전부 예외를 던진다 — 조용히 삼키지 않고 콘솔에 남긴다.
    if (!chrome.runtime?.id) {
      console.warn(
        "[content] 확장 컨텍스트 무효화됨(리로드/업데이트) — 이 탭을 새로고침해야 기록이 재개됩니다.",
      );
      return;
    }

    try {
      const now = new Date().toISOString();
      const {
        currentSession,
        lastRecordedVideo,
        anonymousId,
        serverUrl,
        participantToken,
      } = await chrome.storage.local.get([
        "currentSession",
        "lastRecordedVideo",
        "anonymousId",
        "serverUrl",
        "participantToken",
      ]);

      // 새로고침(F5)으로 같은 영상이 다시 감지되는 경우를 막는다.
      const session = currentSession ?? {
        sessionId: String(Date.now()),
        startTime: now,
      };
      if (
        lastRecordedVideo?.videoId === videoId &&
        lastRecordedVideo?.sessionId === session.sessionId
      ) {
        return;
      }

      // 직전 영상의 시청시간 스냅샷을 여기서 확정한다.
      // previousVideoIdentity(이 탭 자신의 메모리)만 신뢰한다.
      // storage의 lastRecordedVideo는 모든 탭이 공유해, 폴백으로 쓰면
      // 다른 탭이 마지막으로 쓴 eventId에 이 탭의 시청시간을 잘못 붙일 수 있다.
      // 이 탭이 막 로드돼 아직 기억해 둔 값이 없으면 확정을 포기한다. 데이터 유실은 눈에 보이지만
      // 다른 탭 데이터로 오염되는 건 눈에 안 보이므로, 유실 쪽이 안전하다.
      if (previousWatchStats && previousVideoIdentity?.eventId) {
        finalizePreviousWatchStats(previousVideoIdentity, previousWatchStats);
      }

      // uuid를 videoKey와 eventId 양쪽에 재사용한다.
      const eventId = crypto.randomUUID();
      rememberTrackedVideo(session.sessionId, eventId);
      const videoKey = `video__${session.sessionId}__${eventId}`;
      // sent:false로 시작 — 전송 실패 시 이 값이 남아 background.js의 재시도 큐가 찾아낸다.
      await chrome.storage.local.set({
        lastWatchedAt: now,
        currentSession: {
          ...session,
          // 화면의 "N개 수집 중" 표시용 참고치일 뿐 저장 근거로는 쓰이지 않는다 —
          // 탭 경합으로 순간적으로 1 어긋나도(드묾) 실제 데이터에는 영향이 없다.
          videoCount: (session.videoCount ?? 0) + 1,
        },
        // eventId를 함께 저장해야, 다음 영상 전환 때 이 영상의 시청시간을 finalize할
        // video_events 행을 정확히 특정할 수 있다.
        lastRecordedVideo: { videoId, sessionId: session.sessionId, eventId },
        [videoKey]: {
          videoId,
          title,
          watchedAt: now,
          sent: false,
          eventId,
          entryHost,
          entryPath,
          navigationTrigger,
        },
      });
      console.log("[content] recorded:", { videoId, title });

      // 서버에 즉시 전송 — 성공(200) 시에만 sent:true로 갱신, 실패해도 여기서 재시도 안 함.
      if (anonymousId && serverUrl && !serverUrl.startsWith("YOUR_")) {
        fetch(`${serverUrl.replace(/\/$/, "")}/api/video-events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            anonymousId,
            participantToken,
            videoId,
            title: title ?? null,
            watchedAt: now,
            sessionId: session.sessionId,
            eventId,
            entryHost,
            entryPath,
            navigationTrigger,
          }),
        })
          .then((response) => {
            if (response.ok && chrome.runtime?.id) {
              chrome.storage.local.set({
                [videoKey]: {
                  videoId,
                  title,
                  watchedAt: now,
                  sent: true,
                  eventId,
                  entryHost,
                  entryPath,
                  navigationTrigger,
                },
              });
            }
          })
          .catch(() => {});
      }
    } catch (error) {
      // 컨텍스트가 호출 도중 무효화된 경우 등 — 조용히 삼키지 않고 원인을 남긴다.
      console.warn("[content] 영상 기록 실패:", error.message);
    }
  });
  return writeQueue;
}

let lastVideoId = null;
// waitForTitle의 staleness 비교 기준(새 title을 실제로 확보했을 때만 갱신)
let lastTitle = null;
// 탭 최초 진입은 document.referrer로 시작, 이후 SPA 이동마다 갱신(referrer는 최초 이후 안 바뀜).
let previousLocationHref = document.referrer || null;

// 자동재생 종료 vs 관련영상 클릭 구분용 상태
let lastEndedAt = null;
let lastInteractionAt = null;
// 자동재생 카운트다운(~8초)보다 여유를 둔 판정 창
const NAV_TRIGGER_WINDOW_MS = 12000;

// ended는 버블링 안 돼 캡처 단계(3번째 인자 true)에서 등록 — SPA로 <video>가 바뀌어도 재등록 불필요.
document.addEventListener(
  "ended",
  () => {
    lastEndedAt = Date.now();
  },
  true,
);
document.addEventListener("click", () => {
  lastInteractionAt = Date.now();
});
document.addEventListener("keydown", () => {
  lastInteractionAt = Date.now();
});

/**
 * 영상 전환 직전 lastEndedAt/lastInteractionAt 중 더 최근 신호를 전환 원인으로 추정한다.
 * 판정에 쓴 신호는 즉시 초기화해 다음 전환이 오래된 신호를 재사용하지 않게 한다.
 *
 * @param {number} now - 판정 시각(Date.now())
 * @returns {"ended"|"interaction"|null} 둘 다 판정 창 밖이거나 없으면 null
 */
function classifyNavigationTrigger(now) {
  const endedDelta = lastEndedAt === null ? Infinity : now - lastEndedAt;
  const interactionDelta =
    lastInteractionAt === null ? Infinity : now - lastInteractionAt;

  lastEndedAt = null;
  lastInteractionAt = null;

  if (
    endedDelta > NAV_TRIGGER_WINDOW_MS &&
    interactionDelta > NAV_TRIGGER_WINDOW_MS
  ) {
    return null;
  }
  return endedDelta <= interactionDelta ? "ended" : "interaction";
}

// handleVideoChange 재진입 감지용 세대 카운터 — document.title은 탭 전체가 공유하는 값이라
// 빠른 연속 이동 시 이전 호출의 waitForTitle 폴링이 다음 영상의 title을 가로챌 수 있다(실제
// 데이터 오염 사례 있음). await 후 세대가 앞질러졌으면 잡은 title을 못 믿으므로 포기한다.
let handleVideoChangeGen = 0;

/**
 * URL 변경(SPA 이동)을 감지해 새 영상이면 제목을 기다렸다가 recordVideo로 기록한다.
 * @returns {Promise<void>}
 */
async function handleVideoChange() {
  const videoId = extractVideoId(location.href);

  if (!videoId) {
    // watch/shorts가 아닌 페이지(홈, 검색결과 등)도 다음 영상의 "직전 페이지"가 될 수 있으므로 갱신한다.
    previousLocationHref = location.href;
    lastVideoId = null;
    lastTitle = null;
    return;
  }

  if (videoId === lastVideoId) return;

  // 비디오 계측 리스너가 리셋하기 전인 지금(handleVideoChange가 먼저 등록된 리스너라
  // 동기 구간이 먼저 실행됨) 캡처해야 "막 떠나는 영상"의 스냅샷을 얻는다. await 이후엔
  // 계측 리스너가 이미 새 영상으로 리셋한 뒤라 값이 섞인다.
  const previousWatchStats = captureWatchStatsSnapshot();
  const previousVideoIdentity = captureTrackedVideoIdentity();

  // 덮어쓰기 전에 먼저 읽어야 "이 영상 직전 페이지"를 알 수 있다.
  const { entryHost, entryPath } = parseEntryLocation(previousLocationHref);
  const navigationTrigger = classifyNavigationTrigger(Date.now());
  previousLocationHref = location.href;

  lastVideoId = videoId;

  const myGen = ++handleVideoChangeGen;
  const title = await waitForTitle(lastTitle);
  if (myGen !== handleVideoChangeGen) {
    // await 도중 더 최신 이동이 시작됨 — 잡은 title이 그쪽 것일 수 있어 조용히 포기.
    console.warn(
      "[content] 더 빠른 다음 이동 감지 — 기록 건너뜀(재진입 방지):",
      {
        videoId,
      },
    );
    return;
  }
  if (title) lastTitle = title;
  console.log("[content] video detected:", { videoId, title });

  await recordVideo(
    videoId,
    title,
    entryHost,
    entryPath,
    navigationTrigger,
    previousWatchStats,
    previousVideoIdentity,
  );
}

handleVideoChange();

document.addEventListener("yt-navigate-finish", handleVideoChange);
window.addEventListener("popstate", handleVideoChange);

// ── 비디오 엘리먼트 계측 ──
// handleVideoChange와 독립된 후행 리스너로, 항상 "전환 직전 스냅샷 → 다음 영상용 리셋"
// 순서로 실행된다. video.played(TimeRanges)로 재생 구간을 누적해 pause/seek에 견고하나,
// SPA 전환 중 <video> 엘리먼트가 교체되는 경우(쇼츠 피드 등)는 수동 검증이 필요하다.
let watchTracker = null;
let trackedVideoEl = null;

/**
 * TimeRanges의 각 구간 길이를 합산한다.
 * @param {TimeRanges} ranges - video.played 등에서 얻은 시간 구간 목록
 * @returns {number} 합산된 총 초
 */
function sumPlayedRanges(ranges) {
  let total = 0;
  for (let i = 0; i < ranges.length; i++) {
    total += ranges.end(i) - ranges.start(i);
  }
  return total;
}

/**
 * 추적 중인 video 엘리먼트의 timeupdate마다 누적 시청시간·배속을 watchTracker에 반영한다.
 * @returns {void}
 */
function onTrackedVideoTimeUpdate() {
  if (!watchTracker || !trackedVideoEl) return;
  try {
    watchTracker.lastWatchedSeconds = sumPlayedRanges(trackedVideoEl.played);
    watchTracker.lastPlaybackRate = trackedVideoEl.playbackRate;
  } catch {
    // played/playbackRate 접근 자체가 실패하는 비표준 플레이어 상태 — 조용히 무시.
  }
}

/**
 * 현재 페이지의 <video> 엘리먼트에 timeupdate 리스너를 연결한다. SPA 전환으로 엘리먼트가
 * 바뀌면 이전 리스너를 해제하고 새로 연결한다.
 * @returns {void}
 */
function attachVideoTracking() {
  const videoEl = document.querySelector("video");
  if (!videoEl || videoEl === trackedVideoEl) return;
  if (trackedVideoEl) {
    trackedVideoEl.removeEventListener("timeupdate", onTrackedVideoTimeUpdate);
  }
  trackedVideoEl = videoEl;
  trackedVideoEl.addEventListener("timeupdate", onTrackedVideoTimeUpdate);
}

/**
 * 새 영상 진입 시 watchTracker를 초기화하고 <video> 엘리먼트에 다시 연결한다.
 * @returns {void}
 */
function resetWatchTracker() {
  watchTracker = {
    lastWatchedSeconds: 0,
    lastPlaybackRate: 1,
    sawHidden: document.hidden,
  };
  attachVideoTracking();
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden && watchTracker) watchTracker.sawHidden = true;
});

resetWatchTracker();
document.addEventListener("yt-navigate-finish", resetWatchTracker);
window.addEventListener("popstate", resetWatchTracker);

// 탭 종료 시 마지막 영상의 시청시간을 최선노력으로 로컬에만 남긴다. sendBeacon은 POST만
// 지원해 이 값을 반영할 PATCH를 못 쓰므로, background.js의 재시도 큐가 다음 기회에
// 전송하게 한다. storage.local.set도 pagehide 시점 완주를 보장하진 않는다.
// trackedVideoIdentity(이 탭 자신의 메모리)만 쓴다. storage의 lastRecordedVideo는
// 다른 탭이 덮어썼을 수 있어 여기서 그걸 읽으면 다른 탭의 eventId를 이 탭의
// 시청시간으로 오염시킬 수 있다.
window.addEventListener("pagehide", () => {
  if (!watchTracker) return;
  const target = captureTrackedVideoIdentity();
  if (!target?.eventId) return;
  applyWatchStatsPatch(target, {
    watchedSeconds: watchTracker.lastWatchedSeconds ?? null,
    playbackRate: watchTracker.lastPlaybackRate ?? null,
    wasBackgrounded: watchTracker.sawHidden ? 1 : 0,
    watchStatsSent: false,
  });
});
