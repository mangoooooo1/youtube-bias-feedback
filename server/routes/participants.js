const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");

const router = express.Router();

const insertParticipant = db.prepare(`
  INSERT INTO participants (anonymousId, participantCode, group_code, installDate)
  VALUES (@anonymousId, @participantCode, @group_code, @installDate)
`);

router.post("/", (req, res, next) => {
  const { anonymousId, participantCode, group_code, installDate } = req.body;

  for (const field of ["anonymousId", "group_code", "installDate"]) {
    const value = req.body[field];
    if (typeof value !== "string" || !value.trim()) {
      return fail(res, 400, ERROR_CODES.MISSING_REQUIRED_FIELD, `${field} 필드가 올바르지 않습니다.`, field);
    }
  }

  if (isNaN(Date.parse(installDate))) {
    return fail(res, 400, ERROR_CODES.INVALID_FIELD_VALUE, "installDate 필드가 올바르지 않습니다.", "installDate");
  }

  try {
    insertParticipant.run({ anonymousId, group_code, installDate });
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return success(res); // 이미 등록된 참여자면 무시
    }
    return next(err);
  }

  return success(res);
});

module.exports = router;
