// anonymousId 소유권 검증
// 등록이 발급한 서명 토큰으로, "이 요청자가 실제로 이 anonymousId를 발급받은 당사자"임을 증명한다.
const crypto = require("crypto");
const { db } = require("../db");
const { fail, ERROR_CODES } = require("./responseHandler");
const { normalizeAnonymousId } = require("../routes/anonymous-id");

function computeToken(anonymousId, secret) {
  return crypto.createHmac("sha256", secret).update(anonymousId).digest("hex");
}

/**
 * 참여자 등록/복구 성공 시 발급할 토큰. PARTICIPANT_TOKEN_SECRET 미설정 시 null(발급 안 함)
 * 클라이언트는 null이면 저장하지 않고, 이후 요청에도 토큰 필드를 비워 보낸다.
 * @param {string} anonymousId
 * @returns {string|null}
 */
function issueParticipantToken(anonymousId) {
  const secret = process.env.PARTICIPANT_TOKEN_SECRET;
  if (!secret) return null;
  return computeToken(normalizeAnonymousId(anonymousId), secret);
}

/**
 * requireParticipant의 순수 판정 로직
 * DB·secret을 인자로 받아 Express와 분리해 테스트하기 쉽게 만든다.
 * @returns {"ok" | "missing_anonymous_id" | "not_found" | "invalid_token"}
 */
function checkParticipant(db, secret, anonymousId, token) {
  const normalizedId = normalizeAnonymousId(anonymousId);
  if (!normalizedId) return "missing_anonymous_id";

  const exists = !!db
    .prepare("SELECT 1 FROM participants WHERE anonymousId = ?")
    .get(normalizedId);
  if (!exists) return "not_found";

  if (!secret) return "ok";
  const normalizedToken = (token || "").toString().trim();
  const expected = computeToken(normalizedId, secret);
  const expectedBuf = Buffer.from(expected, "hex");
  const tokenBuf = Buffer.from(normalizedToken, "hex");
  const valid =
    normalizedToken.length > 0 &&
    tokenBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(tokenBuf, expectedBuf);
  return valid ? "ok" : "invalid_token";
}

/**
 * Express 미들웨어. req.body의 anonymousId/participantToken을 확인해 등록된 참여자만,
 * PARTICIPANT_TOKEN_SECRET이 설정돼 있고 토큰까지 왔다면 그 토큰이 유효한 소유자인지까지
 * 확인한다. 실패 시 fail() 응답을 직접 보내고 next()를 호출하지 않는다.
 *
 * 통과 시 req.body.anonymousId를 정규화된 값으로 덮어쓴다 — 그래야 이 미들웨어 뒤에 오는
 * 라우트 핸들러가 req.body.anonymousId를 다시 꺼내 자체 DB 조회(recordFeedbackTimestamp,
 * recordStudyEndReviewEvent 등)에 쓸 때도 등록 시 저장된 정규화된 값과 일치한다. 이 단계에서
 * 덮어쓰지 않으면, 여기서는 통과해도 핸들러의 조회는 원본(트림 전) 값으로 실패할 수 있다
 * (코드리뷰로 발견된 정규화 불일치 버그의 연장선).
 */
function requireParticipant(req, res, next) {
  const result = checkParticipant(
    db,
    process.env.PARTICIPANT_TOKEN_SECRET,
    req.body?.anonymousId,
    req.body?.participantToken,
  );

  switch (result) {
    case "missing_anonymous_id":
      return fail(
        res,
        400,
        ERROR_CODES.MISSING_REQUIRED_FIELD,
        "anonymousId 필드가 올바르지 않습니다.",
        "anonymousId",
      );
    case "not_found":
      return fail(
        res,
        404,
        ERROR_CODES.NOT_FOUND,
        "등록되지 않은 참여자입니다.",
        "anonymousId",
      );
    case "invalid_token":
      return fail(
        res,
        403,
        ERROR_CODES.INVALID_PARTICIPANT_TOKEN,
        "참여자 인증에 실패했습니다.",
        "participantToken",
      );
    default:
      req.body.anonymousId = normalizeAnonymousId(req.body.anonymousId);
      return next();
  }
}

module.exports = {
  requireParticipant,
  issueParticipantToken,
  checkParticipant,
  normalizeAnonymousId,
};
