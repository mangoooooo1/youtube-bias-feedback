const ERROR_CODES = {
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
  INVALID_FIELD_VALUE: "INVALID_FIELD_VALUE",
  DUPLICATE_SESSION: "DUPLICATE_SESSION",
  NOT_FOUND: "NOT_FOUND",
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
};

function success(res, data = null, message = "ok") {
  return res.status(200).json({ success: true, message, data });
}

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

function errorHandler(err, req, res, next) {
  console.error(`[Error] ${req.method} ${req.path} : ${err.message}`);

  const status = err.status || 500;
  const code = err.code || ERROR_CODES.INTERNAL_SERVER_ERROR;
  const message = err.message || "서버 오류가 발생했습니다.";

  return fail(res, status, code, message, err.detail || null);
}

module.exports = { success, fail, errorHandler, ERROR_CODES };
