// participants 등록/온보딩 코드 검증 로직

const {
  TEST_CODES,
  isPreviouslyRegistered,
} = require("./participant-recovery");

/**
 * 참여자 등록.
 *
 * @returns {{status: "missing_field", field: string}
 *         | {status: "invalid_install_date"}
 *         | {status: "missing_participant_code"}
 *         | {status: "invalid_participant_code"}
 *         | {status: "registered"}}
 *   "registered"는 신규 등록·이미 등록된 참여자(멱등 재동기화)·INSERT 시점 경쟁 조건(UNIQUE
 *   충돌) 세 경우 모두를 포함한다 — 원본 라우트가 셋 다 동일하게 success 처리하던 것과 동일.
 */
function registerParticipant(db, body) {
  const { anonymousId, participantCode, installDate } = body;
  let { group_code } = body;

  for (const field of ["anonymousId", "group_code", "installDate"]) {
    const value = body[field];
    if (typeof value !== "string" || !value.trim()) {
      return { status: "missing_field", field };
    }
  }

  if (isNaN(Date.parse(installDate))) {
    return { status: "invalid_install_date" };
  }

  // 이미 등록된 참여자면 재동기화로 간주하고 그대로 성공 처리(멱등성 보장)
  const alreadyRegistered = db
    .prepare("SELECT 1 AS x FROM participants WHERE anonymousId = ?")
    .get(anonymousId);
  if (alreadyRegistered) {
    return { status: "registered" };
  }

  // 발급 코드 검증: issued_codes 명단이 등록돼 있으면(시드 후) 신규 등록 시 참여 코드가 필수이며,
  // 명단에 있는 코드만 허용하고 그룹은 명단(issued_codes)을 권위로 사용한다. TEST 코드는 예외.
  // 명단이 비어 있으면(시드 전) 검증을 건너뛴다.
  const issuedCodeCount = db
    .prepare("SELECT COUNT(*) AS c FROM issued_codes")
    .get().c;
  if (issuedCodeCount > 0) {
    if (!participantCode) {
      return { status: "missing_participant_code" };
    }
    if (!TEST_CODES.has(participantCode)) {
      const issued = db
        .prepare("SELECT group_code FROM issued_codes WHERE code = ?")
        .get(participantCode);
      if (!issued) {
        return { status: "invalid_participant_code" };
      }
      group_code = issued.group_code;
    }
  }

  try {
    db.prepare(
      `
      INSERT INTO participants (anonymousId, participantCode, group_code, installDate)
      VALUES (@anonymousId, @participantCode, @group_code, @installDate)
    `,
    ).run({
      anonymousId,
      participantCode: participantCode ?? null,
      group_code,
      installDate,
    });
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return { status: "registered" };
    }
    throw err;
  }

  return { status: "registered" };
}

/**
 * 온보딩 코드 검증 — 발급 명단(issued_codes)과 대조(등록 없이 확인만).
 *
 * @returns {{valid: true, group_code: string|null, previouslyRegistered: boolean}
 *         | {valid: false}}
 */
function validateParticipantCode(db, code) {
  const previouslyRegistered = isPreviouslyRegistered(db, code);

  if (TEST_CODES.has(code)) {
    return { valid: true, group_code: code, previouslyRegistered };
  }

  const issuedCodeCount = db
    .prepare("SELECT COUNT(*) AS c FROM issued_codes")
    .get().c;
  if (issuedCodeCount === 0) {
    return { valid: true, group_code: null, previouslyRegistered }; // 시드 전 permissive
  }

  const issued = db
    .prepare("SELECT group_code FROM issued_codes WHERE code = ?")
    .get(code);
  return issued
    ? { valid: true, group_code: issued.group_code, previouslyRegistered }
    : { valid: false };
}

module.exports = { registerParticipant, validateParticipantCode };
