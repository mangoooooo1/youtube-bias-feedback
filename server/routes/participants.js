const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");
const { recordStudyEndReviewEvent } = require("./study-end-review-event");
const {
  TEST_CODES,
  isPreviouslyRegistered,
  findEarliestParticipant,
} = require("./participant-recovery");
const { rateLimiter } = require("../middleware/rateLimiter");

const router = express.Router();

const STUDY_END_EVENTS = new Set(["modal_shown", "review_viewed"]);

// 참여코드는 "사실상의 인증 수단"이라 별도 강한 인증은 두지 않되, 온라인 대입 시도를 비현실적으로 느리게 만드는 최소 방어선을 둔다.
// 실제 참여자는 재설치당 1회만 호출하므로 15분에 5회면 정상 사용을 막지 않는다.
const recoverRateLimit = rateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

const insertParticipant = db.prepare(`
  INSERT INTO participants (anonymousId, participantCode, group_code, installDate)
  VALUES (@anonymousId, @participantCode, @group_code, @installDate)
`);
const findIssuedCode = db.prepare(
  "SELECT group_code FROM issued_codes WHERE code = ?",
);
const countIssuedCodes = db.prepare("SELECT COUNT(*) AS c FROM issued_codes");
const findParticipant = db.prepare(
  "SELECT 1 AS x FROM participants WHERE anonymousId = ?",
);

router.post("/", (req, res, next) => {
  const { anonymousId, participantCode, installDate } = req.body;
  let { group_code } = req.body;

  for (const field of ["anonymousId", "group_code", "installDate"]) {
    const value = req.body[field];
    if (typeof value !== "string" || !value.trim()) {
      return fail(
        res,
        400,
        ERROR_CODES.MISSING_REQUIRED_FIELD,
        `${field} 필드가 올바르지 않습니다.`,
        field,
      );
    }
  }

  if (isNaN(Date.parse(installDate))) {
    return fail(
      res,
      400,
      ERROR_CODES.INVALID_FIELD_VALUE,
      "installDate 필드가 올바르지 않습니다.",
      "installDate",
    );
  }

  // 이미 등록된 참여자면 재동기화로 간주하고 그대로 성공 처리 (멱등성 보장)
  if (findParticipant.get(anonymousId)) {
    return success(res);
  }

  // 발급 코드 검증: issued_codes 명단이 등록돼 있으면(시드 후) 신규 등록 시 참여 코드가 필수이며,
  // 명단에 있는 코드만 허용하고 그룹은 명단(issued_codes)을 권위로 사용한다. TEST 코드는 예외.
  // 명단이 비어 있으면(시드 전) 검증을 건너뛴다.
  if (countIssuedCodes.get().c > 0) {
    if (!participantCode) {
      return fail(
        res,
        400,
        ERROR_CODES.MISSING_REQUIRED_FIELD,
        "참여 코드가 필요합니다.",
        "participantCode",
      );
    }
    if (!TEST_CODES.has(participantCode)) {
      const issued = findIssuedCode.get(participantCode);
      if (!issued) {
        return fail(
          res,
          400,
          ERROR_CODES.INVALID_FIELD_VALUE,
          "발급되지 않은 참여 코드입니다.",
          "participantCode",
        );
      }
      group_code = issued.group_code;
    }
  }

  try {
    insertParticipant.run({
      anonymousId,
      participantCode: participantCode ?? null,
      group_code,
      installDate,
    });
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return success(res); // 이미 등록된 참여자면 무시
    }
    return next(err);
  }

  return success(res);
});

// 온보딩 코드 검증 — 발급 명단(issued_codes)과 대조 (등록 없이 확인만)
// 응답 data: { valid: boolean, group_code?: string, previouslyRegistered?: boolean }
router.get("/validate", (req, res) => {
  const code = (req.query.code || "").toString().trim().toUpperCase();
  if (!code) {
    return fail(
      res,
      400,
      ERROR_CODES.MISSING_REQUIRED_FIELD,
      "code 파라미터가 필요합니다.",
      "code",
    );
  }
  const previouslyRegistered = isPreviouslyRegistered(db, code);
  if (TEST_CODES.has(code))
    return success(res, {
      valid: true,
      group_code: code,
      previouslyRegistered,
    });
  if (countIssuedCodes.get().c === 0)
    return success(res, {
      valid: true,
      group_code: null,
      previouslyRegistered,
    }); // 시드 전 permissive
  const issued = findIssuedCode.get(code);
  return success(
    res,
    issued
      ? { valid: true, group_code: issued.group_code, previouslyRegistered }
      : { valid: false },
  );
});

// 참여코드 기반 재설치 복구 (이슈 4) — bindOnboarding 확인 모달에서 "예" 선택 시에만 호출된다.
// 응답 data: { anonymousId, installDate, group_code }
router.post("/recover", recoverRateLimit, (req, res) => {
  const participantCode = (req.body.participantCode || "")
    .toString()
    .trim()
    .toUpperCase();

  if (!participantCode || TEST_CODES.has(participantCode)) {
    return fail(
      res,
      400,
      ERROR_CODES.INVALID_FIELD_VALUE,
      "복구할 수 없는 코드입니다.",
      "participantCode",
    );
  }

  const row = findEarliestParticipant(db, participantCode);
  if (!row) {
    return fail(
      res,
      404,
      ERROR_CODES.NOT_FOUND,
      "등록 이력을 찾을 수 없습니다.",
      "participantCode",
    );
  }

  return success(res, row);
});

// 대조군 종료 안내 모달 노출 / 6주 누적 리뷰 열람 이벤트 기록
router.post("/study-end-review-event", (req, res, next) => {
  const { anonymousId, event } = req.body;

  if (typeof anonymousId !== "string" || !anonymousId.trim()) {
    return fail(
      res,
      400,
      ERROR_CODES.MISSING_REQUIRED_FIELD,
      "anonymousId 필드가 올바르지 않습니다.",
      "anonymousId",
    );
  }
  if (!STUDY_END_EVENTS.has(event)) {
    return fail(
      res,
      400,
      ERROR_CODES.INVALID_FIELD_VALUE,
      "event 필드가 올바르지 않습니다.",
      "event",
    );
  }

  let result;
  try {
    result = recordStudyEndReviewEvent(db, anonymousId, event);
  } catch (err) {
    return next(err);
  }

  if (result === "not_found") {
    return fail(
      res,
      404,
      ERROR_CODES.NOT_FOUND,
      "등록되지 않은 참여자입니다.",
      "anonymousId",
    );
  }
  if (result === "not_eligible") {
    return fail(
      res,
      403,
      ERROR_CODES.NOT_ELIGIBLE,
      "연구 종료 후 리뷰 열람이 아직 허용되지 않은 참여자입니다.",
      "anonymousId",
    );
  }

  return success(res);
});

module.exports = router;
