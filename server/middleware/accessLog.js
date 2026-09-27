// 4xx 응답 접근 로그
// fail()은 req 정보 없이 상태코드만 응답하므로, 어떤 요청이 왜 거부됐는지 남기려면 응답 완료 시점에 공통으로 기록해야 한다.

/**
 * 하위 라우터 안에서 응답하면 finish 시점에도 req.path에서 마운트 경로가 잘려 있어
 * (/api/video-events → /) baseUrl을 다시 붙인다. 어떤 라우터에도 매칭되지 않은 요청은
 * baseUrl이 undefined다. 라우터 루트("/")에서 응답했으면 끝 슬래시 없이 baseUrl만 쓴다(/api/video-events/ 방지).
 * 쿼리스트링(validate?code= 의 참여코드)을 남기지 않기 위해 originalUrl은 쓰지 않는다.
 */
function fullPath(req) {
  const base = req.baseUrl ?? "";
  if (base && req.path === "/") return base;
  return `${base}${req.path}`;
}

/** 마운트 경로 자체이거나 그 하위 경로면 감시 대상이다. 접두사만 같은 경로(/api/sessionsX)는 제외한다. */
function isMonitoredPath(path, mountPaths) {
  // Express 라우팅은 기본적으로 대소문자를 구분하지 않으므로 비교도 같게 맞춘다
  const target = path.toLowerCase();
  return mountPaths.some((p) => {
    const mount = p.toLowerCase();
    return target === mount || target.startsWith(`${mount}/`);
  });
}

/**
 * @param {string[]} mountPaths - 감시 대상 API 라우터의 마운트 경로 목록
 */
function createAccessLog(mountPaths) {
  return (req, res, next) => {
    res.on("finish", () => {
      if (res.statusCode < 400 || res.statusCode >= 500) return;
      const path = fullPath(req);
      const tag = isMonitoredPath(path, mountPaths)
        ? "[access]"
        : "[access-other]";
      const who = req.body?.anonymousId
        ? ` anonymousId=${JSON.stringify(req.body.anonymousId)}`
        : "";
      console.warn(`${tag} ${req.method} ${path} ${res.statusCode}${who}`);
    });
    next();
  };
}

module.exports = { createAccessLog, fullPath, isMonitoredPath };
