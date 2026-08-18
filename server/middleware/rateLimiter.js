// 고정 윈도우 방식 IP별 요청 횟수 제한

const { fail, ERROR_CODES } = require("./responseHandler");

/** 순수 판정 함수 — Express 없이 단위 테스트 가능. true면 허용, false면 한도 초과. */
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

/** windowMs 동안 IP(req.ip)당 최대 max회까지만 허용하는 Express 미들웨어를 만든다. */
function rateLimiter({ windowMs, max, now = Date.now }) {
  const state = new Map();
  return (req, res, next) => {
    const allowed = checkRateLimit(state, req.ip, now(), windowMs, max);
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

module.exports = { checkRateLimit, rateLimiter };
