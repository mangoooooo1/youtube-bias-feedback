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
      const { currentSession, anonymousId, serverUrl } =
        await chrome.storage.local.get([
          "currentSession",
          "anonymousId",
          "serverUrl",
        ]);

      const session = currentSession ?? {
        sessionId: String(Date.now()),
        startTime: now,
        videos: [],
      };

      await chrome.storage.local.set({ lastWatchedAt: now });

      const lastSaved = session.videos.at(-1);
      if (lastSaved?.videoId === videoId) return;

      session.videos.push({ videoId, title, watchedAt: now });
      await chrome.storage.local.set({ currentSession: session });
      console.log("[content] recorded:", { videoId, title });

      // 서버에 즉시 전송
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
          }),
        }).catch(() => {});
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
