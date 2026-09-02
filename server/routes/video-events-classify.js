// 직전 URL(entryHost/entryPath)과 자동재생/클릭 원시 신호(navigationTrigger)를 받아
// referrerType(유입 경로)과 relatedTrigger(관련 동영상일 때만 의미 있는 세부 원인)를 정한다.

const YOUTUBE_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

function classifyReferrerType(entryHost, entryPath, navigationTrigger) {
  // 직전 URL 자체를 못 구한 경우(탭 최초 진입인데 referrer가 없는 등)
  if (!entryPath) {
    return { referrerType: "unknown", relatedTrigger: null };
  }

  // SPA 내부 이동은 항상 유튜브 도메인 안에서만 일어나므로, 도메인이 다르면(혹은 없으면)
  // 이 값은 탭이 처음 열릴 때의 document.referrer에서 온 것
  if (!entryHost || !YOUTUBE_HOSTS.has(entryHost)) {
    return { referrerType: "external", relatedTrigger: null };
  }

  if (entryPath === "/results") {
    return { referrerType: "direct_search", relatedTrigger: null };
  }

  if (entryPath === "/") {
    return { referrerType: "home_feed", relatedTrigger: null };
  }

  if (entryPath === "/watch" || entryPath.startsWith("/shorts/")) {
    const relatedTrigger =
      navigationTrigger === "ended"
        ? "autoplay"
        : navigationTrigger === "interaction"
          ? "click"
          : "unknown";
    return { referrerType: "related", relatedTrigger };
  }

  // 재생목록/채널/피드 등 4분류 밖의 경로 — 억지로 끼워맞추지 않고 알 수 없음으로 남긴다.
  return { referrerType: "unknown", relatedTrigger: null };
}

module.exports = { classifyReferrerType };
