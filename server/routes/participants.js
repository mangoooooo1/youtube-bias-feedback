const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");

const router = express.Router();

const insertParticipant = db.prepare(`
  INSERT INTO participants (anonymousId, participantCode, group_code, installDate)
  VALUES (@anonymousId, @participantCode, @group_code, @installDate)
`);
const findIssuedCode = db.prepare("SELECT group_code FROM issued_codes WHERE code = ?");
const countIssuedCodes = db.prepare("SELECT COUNT(*) AS c FROM issued_codes");

const TEST_CODES = new Set(["TEST-EXP", "TEST-CON"]);

router.post("/", (req, res, next) => {
  const { anonymousId, participantCode, installDate } = req.body;
  let { group_code } = req.body;

  for (const field of ["anonymousId", "group_code", "installDate"]) {
    const value = req.body[field];
    if (typeof value !== "string" || !value.trim()) {
      return fail(res, 400, ERROR_CODES.MISSING_REQUIRED_FIELD, `${field} 필드가 올바르지 않습니다.`, field);
    }
  }

  if (isNaN(Date.parse(installDate))) {
    return fail(res, 400, ERROR_CODES.INVALID_FIELD_VALUE, "installDate 필드가 올바르지 않습니다.", "installDate");
  }

  // 발급 코드 검증: TEST 코드는 예외. issued_codes 명단이 등록돼 있으면(시드 후) 명단에 있는 코드만 허용하고,
  // 그룹은 명단(issued_codes)을 권위로 사용한다. 명단이 비어 있으면(시드 전) 검증을 건너뛴다.
  if (participantCode && !TEST_CODES.has(participantCode)) {
    if (countIssuedCodes.get().c > 0) {
      const issued = findIssuedCode.get(participantCode);
      if (!issued) {
        return fail(res, 400, ERROR_CODES.INVALID_FIELD_VALUE, "발급되지 않은 참여 코드입니다.", "participantCode");
      }
      group_code = issued.group_code;
    }
  }

  try {
    insertParticipant.run({ anonymousId, participantCode: participantCode ?? null, group_code, installDate });
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return success(res); // 이미 등록된 참여자면 무시
    }
    return next(err);
  }

  return success(res);
});

// 온보딩 코드 검증 — 발급 명단(issued_codes)과 대조 (등록 없이 확인만)
// 응답 data: { valid: boolean, group_code?: string }
router.get("/validate", (req, res) => {
  const code = (req.query.code || "").toString().trim().toUpperCase();
  if (!code) {
    return fail(res, 400, ERROR_CODES.MISSING_REQUIRED_FIELD, "code 파라미터가 필요합니다.", "code");
  }
  if (TEST_CODES.has(code)) return success(res, { valid: true, group_code: code });
  if (countIssuedCodes.get().c === 0) return success(res, { valid: true, group_code: null }); // 시드 전 permissive
  const issued = findIssuedCode.get(code);
  return success(res, issued ? { valid: true, group_code: issued.group_code } : { valid: false });
});

module.exports = router;
