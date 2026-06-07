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
  if (!raw || raw === "YouTube") return null;
  return raw.replace(/^\(\d+\)\s+/, "").replace(/\s+-\s+YouTube$/, "") || null;
}

function waitForTitle(maxRetries = 10, interval = 200) {
  return new Promise((resolve) => {
    let attempts = 0;

    const check = () => {
      const title = parseTitle();
      if (title) {
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
    const now = new Date().toISOString();
    const { currentSession, anonymousId, serverUrl } = await chrome.storage.local.get([
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
        body: JSON.stringify({ anonymousId, videoId, title: title ?? null, watchedAt: now }),
      }).catch(() => {});
    }
  });
  return writeQueue;
}

let lastVideoId = null;

async function handleVideoChange() {
  const videoId = extractVideoId(location.href);

  if (!videoId) {
    lastVideoId = null;
    return;
  }

  if (videoId === lastVideoId) return;

  lastVideoId = videoId;

  const title = await waitForTitle();
  console.log("[content] video detected:", { videoId, title });

  await recordVideo(videoId, title);
}

handleVideoChange();

document.addEventListener("yt-navigate-finish", handleVideoChange);
window.addEventListener("popstate", handleVideoChange);
