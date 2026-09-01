// 고정 윈도우 방식 IP별 요청 횟수 제한

const { fail, ERROR_CODES } = require("./responseHandler");

/** 순수 판정 함수(true면 허용, false면 한도 초과) */
function checkRateLimit(state, key, now, windowMs, max) {
  const entry = state.get(key);
  if (!entry || now >= entry.resetAt) {
    state.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count += 1;
  return true;
}

// 운영 환경에서는 nginx가 리버스 프록시로 앞단에 있어 req.ip가 항상 127.0.0.1로 찍힌다.
// Express 기본 trust proxy는 X-Forwarded-For만 보는데, 현재 nginx 설정은 X-Real-IP만 전달하고 X-Forwarded-For는 안 보낸다.
// 그래서 trust proxy 설정 대신 X-Real-IP를 직접 읽는다. 이 헤더가 없는 환경(로컬 개발· 테스트처럼 nginx를 거치지 않는 경우)에서는 req.ip로 폴백한다.
// 이 헤더를 신뢰해도 되는 이유: server/app.js가 127.0.0.1(루프백)에만 바인딩돼 있어
// 외부에서는 이 서버로 직접 TCP 연결 자체가 불가능하다.
function clientKey(req) {
  return req.headers["x-real-ip"] || req.ip;
}

/** windowMs 동안 클라이언트(IP)당 최대 max회까지만 허용하는 미들웨어 */
function rateLimiter({ windowMs, max, now = Date.now }) {
  const state = new Map();
  return (req, res, next) => {
    const allowed = checkRateLimit(state, clientKey(req), now(), windowMs, max);
    if (!allowed) {
      return fail(
        res,
        429,
        ERROR_CODES.TOO_MANY_REQUESTS,
        "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      );
    }
    next();
  };
}

module.exports = { checkRateLimit, rateLimiter, clientKey };
