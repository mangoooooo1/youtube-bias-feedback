// 수집 요청을 보낸 확장 버전 — 전송 정체 등 문제가 생겼을 때 어느 버전에서 났는지 DB로 추적한다

const EXTENSION_VERSION_HEADER = "X-Extension-Version";

// 크롬 manifest 버전 형식: 점으로 나눈 정수 1~4개
const VERSION_PATTERN = /^\d{1,5}(\.\d{1,5}){0,3}$/;

/**
 * 요청 헤더의 확장 버전을 읽는다. 없거나 형식이 틀리면 null — 옛 확장도 기록은 받아야 하므로 거부하지 않는다.
 * @param {import("express").Request} req
 * @returns {string|null}
 */
function readExtensionVersion(req) {
  const value = req.get(EXTENSION_VERSION_HEADER);
  return typeof value === "string" && VERSION_PATTERN.test(value)
    ? value
    : null;
}

module.exports = { EXTENSION_VERSION_HEADER, readExtensionVersion };
