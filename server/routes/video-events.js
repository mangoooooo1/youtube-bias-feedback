const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");

const router = express.Router();

const insertEvent = db.prepare(`
  INSERT INTO video_events (anonymousId, videoId, title, watchedAt)
  VALUES (@anonymousId, @videoId, @title, @watchedAt)
`);

router.post("/", (req, res, next) => {
  const { anonymousId, videoId, watchedAt, title } = req.body;

  for (const field of ["anonymousId", "videoId", "watchedAt"]) {
    if (!req.body[field]?.toString().trim()) {
      return fail(res, 400, ERROR_CODES.MISSING_REQUIRED_FIELD, `${field} 필드가 올바르지 않습니다.`, field);
    }
  }

  if (isNaN(Date.parse(watchedAt))) {
    return fail(res, 400, ERROR_CODES.INVALID_FIELD_VALUE, "watchedAt 필드가 올바르지 않습니다.", "watchedAt");
  }

  try {
    insertEvent.run({ anonymousId, videoId, title: title ?? null, watchedAt });
  } catch (err) {
    return next(err);
  }

  return success(res);
});

module.exports = router;
