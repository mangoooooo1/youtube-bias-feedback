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

// 유튜브 탭을 여러 개 동시에 열어두면 탭마다 완전히 독립된 콘텐츠 스크립트 인스턴스가 돌아서 큐만으로는 탭 간 경합을 못 막는다.
function recordVideo(videoId, title) {
  writeQueue = writeQueue.then(async () => {
    // 확장을 리로드/업데이트하면 이미 열려있던 유튜브 탭의 content script는 페이지를
    // 새로고침하기 전까지 무효화된 컨텍스트로 남는다 — 이 상태에서 chrome.* 호출은 전부
    // 예외를 던진다. 미리 감지해 조용히 실패하지 말고 콘솔에 남겨서 원인을 알 수 있게 한다.
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
      // sent:false로 시작
      // 아래 전송이 실패하면 이 값이 그대로 남아, background.js의
      // 1분 재시도 큐(retryUnsentVideoEvents)가 나중에 다시 보낼 대상을 찾아낼 수 있다.
      await chrome.storage.local.set({
        lastWatchedAt: now,
        currentSession: {
          ...session,
          // 화면의 "N개 수집 중" 표시용 참고치일 뿐 저장 근거로는 쓰이지 않는다 —
          // 탭 경합으로 순간적으로 1 어긋나도(드묾) 실제 데이터에는 영향이 없다.
          videoCount: (session.videoCount ?? 0) + 1,
        },
        lastRecordedVideo: { videoId, sessionId: session.sessionId },
        [videoKey]: { videoId, title, watchedAt: now, sent: false, eventId },
      });
      console.log("[content] recorded:", { videoId, title });

      // 서버에 즉시 전송
      // 성공(200)했을 때만 sent:true로 갱신한다. 실패해도 여기서 다시 시도하지 않는다.
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

async function handleVideoChange() {
  const videoId = extractVideoId(location.href);

  if (!videoId) {
    lastVideoId = null;
    lastTitle = null;
    return;
  }

  if (videoId === lastVideoId) return;

  lastVideoId = videoId;

  const title = await waitForTitle(lastTitle);
  if (title) lastTitle = title;
  console.log("[content] video detected:", { videoId, title });

  await recordVideo(videoId, title);
}

handleVideoChange();

document.addEventListener("yt-navigate-finish", handleVideoChange);
window.addEventListener("popstate", handleVideoChange);
