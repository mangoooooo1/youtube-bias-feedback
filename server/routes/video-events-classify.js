const YOUTUBE_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

/**
 * 직전 URL(entryHost/entryPath), 자동재생/클릭 원시 신호(navigationTrigger), 재생목록 여부를 받아
 * referrerType(direct_search/home_feed/related/playlist/external/unknown)과
 * relatedTrigger(related·playlist일 때 자동으로 넘어갔는지 직접 눌렀는지)로 분류한다.
 *
 * @param {string|null} entryHost - 직전 페이지 도메인
 * @param {string|null} entryPath - 직전 페이지 경로(유튜브 내부 페이지일 때만 존재)
 * @param {"ended"|"interaction"|null} navigationTrigger - 이동 직전 원시 신호(자동재생 종료 vs 클릭/키입력)
 * @param {{entryHasList?: 0|1|null, watchHasList?: 0|1|null}} [lists] - 직전·현재 URL에 재생목록(`list` 파라미터)이 있었는지. 옛 확장은 보내지 않는다
 * @returns {{ referrerType: "direct_search"|"home_feed"|"related"|"playlist"|"external"|"unknown", relatedTrigger: "autoplay"|"click"|"unknown"|null }}
 */
function classifyReferrerType(
  entryHost,
  entryPath,
  navigationTrigger,
  { entryHasList, watchHasList } = {},
) {
  // 확장은 외부 사이트의 경로를 보내지 않으므로 경로보다 도메인을 먼저 본다.
  // SPA 내부 이동은 항상 유튜브 도메인 안에서만 일어나므로, 도메인이 다르면
  // 이 값은 탭이 처음 열릴 때의 document.referrer에서 온 것
  if (entryHost && !YOUTUBE_HOSTS.has(entryHost)) {
    return { referrerType: "external", relatedTrigger: null };
  }

  // 직전 URL 자체를 못 구한 경우(탭 최초 진입인데 referrer가 없는 등)
  if (!entryPath) {
    return { referrerType: "unknown", relatedTrigger: null };
  }

  // entryHost가 없으면 "외부에서 왔다"고 단정할 근거가 없다.
  // content.js는 entryHost/entryPath를 항상 같이 보내지만, video-events-validate.js는 이 둘을 독립된 옵션 필드로 허용하므로
  // entryPath만 있고 entryHost가 빠진 요청도 여기까지 들어올 수 있다. 판단 불가는 unknown으로.
  if (!entryHost) {
    return { referrerType: "unknown", relatedTrigger: null };
  }

  if (entryPath === "/results") {
    return { referrerType: "direct_search", relatedTrigger: null };
  }

  if (entryPath === "/") {
    return { referrerType: "home_feed", relatedTrigger: null };
  }

  // 재생목록 페이지에서 왔거나 재생목록의 시청 화면에서 다음 영상으로 넘어간 경우.
  // 홈·검색에서 연 재생목록의 첫 영상은 찾은 곳 그대로 두고, 옆 추천으로 빠져나가면 related다.
  // 경로를 /watch로 한정해야 playlist의 저장 경로가 /playlist·/watch로만 남는다
  if (
    entryPath === "/playlist" ||
    (entryPath === "/watch" && entryHasList === 1 && watchHasList === 1)
  ) {
    return {
      referrerType: "playlist",
      relatedTrigger: triggerOf(navigationTrigger),
    };
  }

  if (entryPath === "/watch" || entryPath.startsWith("/shorts/")) {
    return {
      referrerType: "related",
      relatedTrigger: triggerOf(navigationTrigger),
    };
  }

  // 채널/피드 등 분류 밖의 경로 — 억지로 끼워맞추지 않고 알 수 없음으로 남긴다.
  return { referrerType: "unknown", relatedTrigger: null };
}

/**
 * 이동 직전 원시 신호를 자동재생/클릭으로 바꾼다. 판단할 신호가 없으면 unknown이다.
 * @param {"ended"|"interaction"|null} navigationTrigger
 * @returns {"autoplay"|"click"|"unknown"}
 */
function triggerOf(navigationTrigger) {
  if (navigationTrigger === "ended") return "autoplay";
  if (navigationTrigger === "interaction") return "click";
  return "unknown";
}

module.exports = { classifyReferrerType };
