function extractVideoId(url) {
  try {
    const parsed = new URL(url);

    if (parsed.pathname.startsWith('/shorts/')) {
      const id = parsed.pathname.split('/')[2];
      return id || null;
    }

    if (parsed.pathname === '/watch') {
      return parsed.searchParams.get('v');
    }

    return null;
  } catch {
    return null;
  }
}

function parseTitle() {
  const raw = document.title;
  if (!raw || raw === 'YouTube') return null;
  return raw.endsWith(' - YouTube') ? raw.slice(0, -' - YouTube'.length) : raw;
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

let lastVideoId = null;

async function handleVideoChange() {
  const videoId = extractVideoId(location.href);

  if (!videoId || videoId === lastVideoId) return;

  lastVideoId = videoId;

  const title = await waitForTitle();
  console.log('[content] video detected:', { videoId, title });

  chrome.runtime.sendMessage(
    { type: 'VIDEO_DETECTED', videoId, title, url: location.href },
    (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[content] sendMessage error:', chrome.runtime.lastError.message);
        return;
      }
      console.log('[content] background response:', response);
    }
  );
}

handleVideoChange();

document.addEventListener('yt-navigate-finish', handleVideoChange);
window.addEventListener('popstate', handleVideoChange);
