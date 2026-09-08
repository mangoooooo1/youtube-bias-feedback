// URL에서 유튜브 영상 ID를 추출한다(/watch?v=, /shorts/ 형식만 지원, 그 외는 null).
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

// 탭마다 독립된 콘텐츠 스크립트가 돌아 큐만으로는 다중 탭 동시 시청 시 경합을 못 막는다.
function recordVideo(videoId, title, entryHost, entryPath, navigationTrigger) {
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
      const { currentSession, lastRecordedVideo, anonymousId, serverUrl } =
        await chrome.storage.local.get([
          "currentSession",
          "lastRecordedVideo",
          "anonymousId",
          "serverUrl",
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

      // uuid를 videoKey와 eventId 양쪽에 재사용한다.
      const eventId = crypto.randomUUID();
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
        lastRecordedVideo: { videoId, sessionId: session.sessionId },
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

  await recordVideo(videoId, title, entryHost, entryPath, navigationTrigger);
}

handleVideoChange();

document.addEventListener("yt-navigate-finish", handleVideoChange);
window.addEventListener("popstate", handleVideoChange);
