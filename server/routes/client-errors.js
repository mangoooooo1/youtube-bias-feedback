const express = require("express");
const { success, fail } = require("../middleware/responseHandler");
const { rateLimiter } = require("../middleware/rateLimiter");
const { validateClientErrors } = require("./client-errors-validate");
const { traceRef } = require("../tracing");

const router = express.Router();

// 확장은 15분 간격으로 묶어 보낸다. 같은 IP 뒤 여러 참여자(학교·기관망)를 고려해 여유를 둔다
const clientErrorsRateLimit = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
});

/**
 * 오류 1건을 error-monitor가 읽는 한 줄로 만든다. 허용 목록 필드만 쓴다.
 * 시각은 toISOString으로 다시 찍어 클라이언트 문자열이 그대로 남지 않게 한다.
 */
function formatClientErrorLine(entry, { anonymousId, version }, trace = "") {
  const who = anonymousId
    ? ` anonymousId=${JSON.stringify(anonymousId.trim())}`
    : "";
  return (
    `[client-error] code=${entry.code} where=${entry.where} count=${entry.count}` +
    ` version=${version}` +
    ` firstAt=${new Date(entry.firstAt).toISOString()}` +
    ` lastAt=${new Date(entry.lastAt).toISOString()}${who}${trace}`
  );
}

// 등록 전·토큰 불일치 상태의 오류도 받아야 해서 requireParticipant를 걸지 않는다
router.post("/", clientErrorsRateLimit, (req, res) => {
  const error = validateClientErrors(req.body);
  if (error) {
    return fail(
      res,
      400,
      error.code,
      `${error.field} 필드가 올바르지 않습니다.`,
      error.field,
    );
  }

  const trace = traceRef();
  for (const entry of req.body.errors) {
    console.error(formatClientErrorLine(entry, req.body, trace));
  }

  return success(res);
});

module.exports = router;
module.exports.formatClientErrorLine = formatClientErrorLine;
