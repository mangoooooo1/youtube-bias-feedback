// 고정 윈도우 방식 IP별 요청 횟수 제한

const { fail, ERROR_CODES } = require("./responseHandler");

/**
 * 주어진 key가 windowMs 시간 동안 max회를 초과했는지 판정하는 순수 함수
 * Express 객체에 의존하지 않아 단위 테스트가 쉽다.
 * @param {Map<string, {count: number, resetAt: number}>} state - 클라이언트별 요청 카운트 저장소
 * @param {string} key - 클라이언트 식별 키 (보통 IP)
 * @param {number} now - 현재 시각(ms)
 * @param {number} windowMs - 카운트 윈도우 길이(ms)
 * @param {number} max - 윈도우당 최대 허용 요청 수
 * @returns {boolean} true면 허용, false면 한도 초과
 */
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

/**
 * 요청에서 클라이언트 식별 키(IP)를 추출한다.
 *
 * nginx가 리버스 프록시로 앞단에 있어 req.ip는 항상 127.0.0.1로 찍힌다. nginx가 X-Forwarded-For가
 * 아닌 X-Real-IP만 전달하므로 Express trust proxy 대신 이 헤더를 직접 읽고, 헤더가 없는 로컬
 * 환경은 req.ip로 폴백한다. app.js가 루프백에만 바인딩돼 외부에서 직접 접속이 불가능하므로 이
 * 헤더는 위조 걱정 없이 신뢰할 수 있다.
 * @param {import("express").Request} req - Express 요청 객체
 * @returns {string} 클라이언트 식별 키
 */
function clientKey(req) {
  return req.headers["x-real-ip"] || req.ip;
}

/**
 * windowMs 시간 동안 클라이언트(IP)당 최대 max회까지만 허용하는 Express 미들웨어를 생성한다.
 * @param {object} options - 제한 정책
 * @param {number} options.windowMs - 카운트 윈도우 길이(ms)
 * @param {number} options.max - 윈도우당 최대 허용 요청 수
 * @param {() => number} [options.now=Date.now] - 현재 시각을 반환하는 함수 (테스트 시 대체 가능)
 * @returns {(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => void} rate limit 미들웨어
 */
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
