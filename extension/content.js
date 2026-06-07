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

async function sendWithRetry(message, maxRetries = 3, delay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    if (!chrome.runtime?.sendMessage) {
      console.warn("[content] Extension context invalidated");
      return;
    }

    const response = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime?.lastError) {
            resolve(null);
          } else {
            resolve(res);
          }
        });
      } catch {
        resolve(null);
      }
    });

    if (response) {
      console.log("[content] background response:", response);
      return;
    }

    if (i < maxRetries - 1) await new Promise((r) => setTimeout(r, delay));
  }
  console.warn("[content] sendMessage 최종 실패:", message.videoId);
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

  sendWithRetry({
    type: "VIDEO_DETECTED",
    videoId,
    title,
    url: location.href,
  }).catch(() => {});
}

handleVideoChange();

document.addEventListener("yt-navigate-finish", handleVideoChange);
window.addEventListener("popstate", handleVideoChange);
