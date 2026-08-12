const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");
const { getPeriodReviews } = require("./period-reviews-query");

const router = express.Router();

router.get("/", (req, res) => {
  const anonymousId = (req.query.anonymousId || "").toString().trim();
  if (!anonymousId) {
    return fail(
      res,
      400,
      ERROR_CODES.MISSING_REQUIRED_FIELD,
      "anonymousId 파라미터가 필요합니다.",
      "anonymousId",
    );
  }

  return success(res, getPeriodReviews(db, anonymousId));
});

module.exports = router;
