const express = require("express");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");

const router = express.Router();

function validateSession(body) {
  const { anonymousId, sessionId, startTime, endTime, videoCount, entropy } = body;

  const requiredFields = ["anonymousId", "sessionId", "startTime", "endTime"];
  for (const field of requiredFields) {
    const value = body[field];
    if (value === undefined || value === null || String(value).trim() === "") {
      return { code: ERROR_CODES.MISSING_REQUIRED_FIELD, field };
    }
  }

  if (isNaN(Date.parse(startTime))) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "startTime" };
  }
  if (isNaN(Date.parse(endTime))) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "endTime" };
  }
  if (videoCount !== undefined && (!Number.isInteger(videoCount) || videoCount < 0)) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "videoCount" };
  }
  if (entropy !== undefined && (typeof entropy !== "number" || entropy < 0)) {
    return { code: ERROR_CODES.INVALID_FIELD_VALUE, field: "entropy" };
  }

  return null;
}

router.post("/", (req, res) => {
  const error = validateSession(req.body);
  if (error) {
    return fail(res, 400, error.code, `${error.field} 필드가 올바르지 않습니다.`, error.field);
  }

  return success(res);
});

module.exports = router;
