// API 응답의 success:false 케이스에서 공통으로 쓰는 에러 식별 코드 모음.
const ERROR_CODES = {
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
  INVALID_FIELD_VALUE: "INVALID_FIELD_VALUE",
  DUPLICATE_SESSION: "DUPLICATE_SESSION",
  NOT_FOUND: "NOT_FOUND",
  NOT_ELIGIBLE: "NOT_ELIGIBLE",
  TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS",
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
};

/**
 * 성공 응답을 표준 포맷으로 전송한다.
 * @param {import("express").Response} res - Express 응답 객체
 * @param {*} [data=null] - 클라이언트에 반환할 데이터
 * @param {string} [message="ok"] - 성공 메시지
 * @returns {import("express").Response} JSON 본문이 담긴 res 객체
 */
function success(res, data = null, message = "ok") {
  return res.status(200).json({ success: true, message, data });
}

/**
 * 실패 응답을 표준 포맷으로 전송한다.
 * production 환경에서는 detail을 응답에서 제외해 내부 정보 노출을 막는다.
 * @param {import("express").Response} res - Express 응답 객체
 * @param {number} [status=500] - HTTP 상태 코드
 * @param {string} [code=ERROR_CODES.INTERNAL_SERVER_ERROR] - 에러 식별 코드
 * @param {string} [message="서버 오류가 발생했습니다."] - 에러 메시지
 * @param {*} [detail=null] - 에러 상세 정보 (development 환경에서만 응답에 포함)
 * @returns {import("express").Response} JSON 본문이 담긴 res 객체
 */
function fail(
  res,
  status = 500,
  code = ERROR_CODES.INTERNAL_SERVER_ERROR,
  message = "서버 오류가 발생했습니다.",
  detail = null,
) {
  const isProduction = process.env.NODE_ENV === "production";
  return res.status(status).json({
    success: false,
    message,
    code,
    detail: isProduction ? null : detail,
  });
}

/**
 * Express 에러 핸들링 미들웨어. err에 담긴 status/code/message/detail을 fail() 응답으로 변환한다.
 * next는 사용하지 않지만 Express가 인자 개수(4개)로 에러 핸들러 미들웨어를 판별하므로 시그니처에서 제거할 수 없다.
 * @param {Error & { status?: number, code?: string, detail?: * }} err - 발생한 에러 객체
 * @param {import("express").Request} req - Express 요청 객체
 * @param {import("express").Response} res - Express 응답 객체
 * @param {import("express").NextFunction} _next - 사용하지 않음 (Express arity 요건상 필요)
 * @returns {import("express").Response} fail()이 반환한 응답 객체
 */
function errorHandler(err, req, res, _next) {
  console.error(`[Error] ${req.method} ${req.path} : ${err.message}`);

  const status = err.status || 500;
  const code = err.code || ERROR_CODES.INTERNAL_SERVER_ERROR;
  const message = err.message || "서버 오류가 발생했습니다.";

  return fail(res, status, code, message, err.detail || null);
}

module.exports = { success, fail, errorHandler, ERROR_CODES };
