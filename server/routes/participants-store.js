// participants 등록/온보딩 코드 검증 로직

const {
  TEST_CODES,
  isPreviouslyRegistered,
} = require("./participant-recovery");
const { normalizeAnonymousId } = require("./anonymous-id");
const { normalizeParticipantCode } = require("./participant-code");

// 시간대가 없으면 JS(현지 시간)와 SQLite(UTC)가 다르게 읽으므로 Z/±HH:MM을 필수로 한다
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** 통과하면 toISOString() 형식(UTC) 문자열, 아니면 null. */
function normalizeInstallDate(value) {
  const match = ISO_WITH_OFFSET.exec(value);
  if (!match) return null;

  // Date는 02-30·24:00을 다음 날로 넘겨 받으므로 적힌 날짜·시각이 실제로 있는지 따로 본다
  const [y, mo, d, h, mi, s] = match.slice(1, 7).map(Number);
  const wall = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    wall.getUTCFullYear() !== y ||
    wall.getUTCMonth() !== mo - 1 ||
    wall.getUTCDate() !== d ||
    wall.getUTCHours() !== h ||
    wall.getUTCMinutes() !== mi ||
    wall.getUTCSeconds() !== s
  ) {
    return null;
  }

  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * 참여자 등록.
 *
 * @returns {{status: "missing_field", field: string}
 *         | {status: "invalid_install_date"}
 *         | {status: "missing_participant_code"}
 *         | {status: "invalid_participant_code"}
 *         | {status: "registered", anonymousId: string}}
 *   "registered"는 신규 등록·이미 등록된 참여자(멱등 재동기화)·INSERT 시점 경쟁 조건(UNIQUE
 *   충돌) 세 경우 모두를 포함한다 — 원본 라우트가 셋 다 동일하게 success 처리하던 것과 동일.
 *   anonymousId는 normalizeAnonymousId를 거친 값 — 호출부(participants.js)가 토큰을
 *   발급할 때 이 값을 그대로 써야 DB에 저장된 값과 어긋나지 않는다.
 */
function registerParticipant(db, body) {
  let { group_code } = body;
  // GET /validate·POST /recover와 동일하게 정규화
  const participantCode =
    normalizeParticipantCode(body.participantCode) || undefined;

  for (const field of ["anonymousId", "group_code", "installDate"]) {
    const value = body[field];
    if (typeof value !== "string" || !value.trim()) {
      return { status: "missing_field", field };
    }
  }

  // requireParticipant(checkParticipant)가 조회·토큰 계산에 쓰는 것과 동일한 정규화를
  // 저장 시점에도 적용해야, 등록 직후 issueParticipantToken(participants.js)이 발급한
  // 토큰이 나중에 checkParticipant로 검증될 때 어긋나지 않는다.
  const anonymousId = normalizeAnonymousId(body.anonymousId);

  const installDate = normalizeInstallDate(body.installDate);
  if (!installDate) {
    return { status: "invalid_install_date" };
  }

  // 이미 등록된 참여자면 재동기화로 간주하고 그대로 성공 처리(멱등성 보장)
  const alreadyRegistered = db
    .prepare("SELECT 1 AS x FROM participants WHERE anonymousId = ?")
    .get(anonymousId);
  if (alreadyRegistered) {
    return { status: "registered", anonymousId };
  }

  // 발급 코드 검증: 신규 등록은 참여 코드가 필수이며, 명단(issued_codes)에 있는 코드만 허용하고
  // 그룹은 명단을 권위로 사용한다. TEST 코드는 예외.
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
      return { status: "registered", anonymousId };
    }
    throw err;
  }

  return { status: "registered", anonymousId };
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

  const issued = db
    .prepare("SELECT group_code FROM issued_codes WHERE code = ?")
    .get(code);
  return issued
    ? { valid: true, group_code: issued.group_code, previouslyRegistered }
    : { valid: false };
}

module.exports = { registerParticipant, validateParticipantCode };
