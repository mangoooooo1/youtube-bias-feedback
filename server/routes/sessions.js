const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");
const { validateSession } = require("./sessions-validate");

const router = express.Router();

const insertSession = db.prepare(`
  INSERT INTO sessions (anonymousId, sessionId, startTime, endTime, videoCount, categoryDistribution, entropy, totalMs, youtubeMs, geminiMs, llmStatus, failureReason, httpStatus, timedOut, feedbackNotifiedAt, review, reviewTopic, source, promptVersion)
  VALUES (@anonymousId, @sessionId, @startTime, @endTime, @videoCount, @categoryDistribution, @entropy, @totalMs, @youtubeMs, @geminiMs, @llmStatus, @failureReason, @httpStatus, @timedOut, @feedbackNotifiedAt, @review, @reviewTopic, @source, @promptVersion)
`);

router.post("/", (req, res, next) => {
  const error = validateSession(req.body);
  if (error) {
    return fail(
      res,
      400,
      error.code,
      `${error.field} 필드가 올바르지 않습니다.`,
      error.field,
    );
  }

  const {
    anonymousId,
    sessionId,
    startTime,
    endTime,
    videoCount,
    categoryDistribution,
    entropy,
    totalMs,
    youtubeMs,
    geminiMs,
    llmStatus,
    failureReason,
    httpStatus,
    timedOut,
    feedbackNotifiedAt,
    review,
    reviewTopic,
    source,
    promptVersion,
  } = req.body;

  try {
    insertSession.run({
      anonymousId,
      sessionId,
      startTime,
      endTime,
      videoCount: videoCount ?? null,
      categoryDistribution:
        categoryDistribution != null
          ? JSON.stringify(categoryDistribution)
          : null,
      entropy: entropy ?? null,
      totalMs: totalMs ?? null,
      youtubeMs: youtubeMs ?? null,
      geminiMs: geminiMs ?? null,
      llmStatus: llmStatus ?? null,
      failureReason: failureReason ?? null,
      httpStatus: httpStatus ?? null,
      timedOut: timedOut ?? null,
      feedbackNotifiedAt: feedbackNotifiedAt ?? null,
      review: review ?? null,
      reviewTopic: reviewTopic ?? null,
      source: source ?? null,
      promptVersion: promptVersion ?? null,
    });
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return fail(
        res,
        409,
        ERROR_CODES.DUPLICATE_SESSION,
        "이미 존재하는 세션입니다.",
        sessionId,
      );
    }
    return next(err);
  }

  return success(res);
});

// 피드백 열람/확인 시각 갱신 () — 세션 생성 POST와 별도 시점에(알림 클릭, 확인 버튼 클릭 등)
// 호출된다. anonymousId로 소유권을 확인해 다른 참여자의 세션을 갱신하지 못하도록 막는다.
// column은 요청 값이 아니라 아래 두 router.patch 호출부에서만 하드코딩으로 주어지므로
// SQL 인젝션 경로가 없다(server/db.js의 addColumn(table, name, type) 패턴과 동일한 근거).
function makeFeedbackTimestampHandler(column) {
  const exists = db.prepare(
    `SELECT 1 FROM sessions WHERE sessionId = @sessionId AND anonymousId = @anonymousId`,
  );
  // 최초 호출만 기록 — 퍼널 지연 분석(생성→알림→클릭→확인)은 최초 시각이 필요하므로
  // 이미 값이 있으면(재호출) 덮어쓰지 않는다.
  const update = db.prepare(
    `UPDATE sessions SET ${column} = @value WHERE sessionId = @sessionId AND anonymousId = @anonymousId AND ${column} IS NULL`,
  );
  return (req, res, next) => {
    const { sessionId } = req.params;
    // req.body가 null/undefined일 수 있어(본문 없는 요청) 구조 분해 대신 옵셔널 체이닝으로
    // 접근한다 — 구조 분해였다면 여기서 예외가 던져져 아래 400 검증을 건너뛰고 500으로 샜다.
    const anonymousId = req.body?.anonymousId;

    if (typeof anonymousId !== "string" || !anonymousId.trim()) {
      return fail(
        res,
        400,
        ERROR_CODES.MISSING_REQUIRED_FIELD,
        "anonymousId 필드가 올바르지 않습니다.",
        "anonymousId",
      );
    }

    try {
      if (!exists.get({ sessionId, anonymousId })) {
        return fail(
          res,
          404,
          ERROR_CODES.NOT_FOUND,
          "세션을 찾을 수 없습니다.",
          sessionId,
        );
      }
      // changes === 0이어도(이미 값이 있던 재호출) 세션은 존재하므로 성공으로 처리한다.
      update.run({
        sessionId,
        anonymousId,
        value: new Date().toISOString(),
      });
    } catch (err) {
      return next(err);
    }

    return success(res);
  };
}

// 알림 클릭 기준 — background.js가 호출 (느슨한 신호)
router.patch(
  "/:sessionId/feedback-viewed",
  makeFeedbackTimestampHandler("feedbackViewedAt"),
);
// "피드백 확인하기" 블러 해제 버튼 클릭 기준 — popup.js가 호출 (가장 엄격한 신호)
router.patch(
  "/:sessionId/feedback-confirmed",
  makeFeedbackTimestampHandler("feedbackConfirmedAt"),
);

module.exports = router;
