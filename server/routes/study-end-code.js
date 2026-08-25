// 대조군 연구종료 설문 연동 리뷰 열람 게이트 — 참여자 전원 공통 코드 검증

const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");
const { rateLimiter } = require("../middleware/rateLimiter");
const { verifyAndRecordStudyEndCode } = require("./study-end-code-validation");

const router = express.Router();

// 참여코드 복구 API와 동일한 레이트리밋(15분 5회)을 그대로 적용한다.
const validateRateLimit = rateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

// code를 쿼리스트링이 아니라 요청 본문으로 받는다
router.post("/validate", validateRateLimit, (req, res) => {
  const { code, anonymousId } = req.body;
  if (typeof code !== "string" || !code.trim()) {
    return fail(
      res,
      400,
      ERROR_CODES.MISSING_REQUIRED_FIELD,
      "code 필드가 필요합니다.",
      "code",
    );
  }
  if (typeof anonymousId !== "string" || !anonymousId.trim()) {
    return fail(
      res,
      400,
      ERROR_CODES.MISSING_REQUIRED_FIELD,
      "anonymousId 필드가 필요합니다.",
      "anonymousId",
    );
  }

  const valid = verifyAndRecordStudyEndCode(
    db,
    anonymousId,
    code,
    process.env.STUDY_END_REVEAL_CODE,
  );
  return success(res, { valid });
});

module.exports = router;
