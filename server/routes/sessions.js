const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");
const { validateSession } = require("./sessions-validate");
const { insertSession, recordFeedbackTimestamp } = require("./sessions-store");
const { generateAndStoreTodayReview } = require("./today-review-generate");
const { isTodayReviewEligible } = require("./today-reviews-query");
const {
  ensureVideoMetadata,
  getCategoryIdsForVideos,
  findMissingVideoIds,
} = require("./video-metadata-store");
const {
  calculateDistribution,
  calculateEntropy,
} = require("../pipeline/category-diversity");

const router = express.Router();

router.post("/", async (req, res, next) => {
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

  // categoryId 조회·다양성 계산은 이제 서버 책임이다.
  // 클라이언트는 이 세션에서 시청한 videoId 목록(중복 포함)만 보낸다.
  const { videoIds } = req.body;
  const youtubeStart = Date.now();
  await ensureVideoMetadata(db, videoIds, process.env.YOUTUBE_API_KEY);
  // YOUTUBE_API_KEY 미설정·일시적 API 장애 등으로 일부 videoId가 끝내 캐시되지
  // 못했으면(ensureVideoMetadata가 건너뛰었거나 청크 전체가 실패한 경우), 이 시점엔
  // 다양성을 확정하지 않는다. {}·0으로 저장해버리면 "확인해봤더니 카테고리가 없음"과
  // "확인 자체를 못함"이 구분되지 않고, insertSession은 UPSERT가 아니라서 원인이
  // 나중에 해소돼도 갱신할 방법이 없어 잘못된 값이 영구히 남는다.
  const unresolvedVideoIds = findMissingVideoIds(db, videoIds);
  const categoryDistribution =
    unresolvedVideoIds.length === 0
      ? calculateDistribution(getCategoryIdsForVideos(db, videoIds))
      : null;
  const entropy =
    categoryDistribution !== null
      ? calculateEntropy(categoryDistribution)
      : null;
  // youtubeMs는 더 이상 클라이언트가 측정해 보내지 않는다.
  const youtubeMs = Date.now() - youtubeStart;

  try {
    insertSession(db, {
      ...req.body,
      categoryDistribution,
      entropy,
      youtubeMs,
    });
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      // 최초 요청이 서버엔 이미 반영됐지만 응답만 못 받아 재시도가 여기 도달한 경우다.
      // fail()의 detail은 production에서 항상 null로 마스킹돼(민감정보 노출 방지) 여기엔
      // 못 쓰므로, 이 라우트만 직접 응답을 구성해 이미 저장된 categoryDistribution/entropy를
      // 함께 돌려준다. 그래야 클라이언트가 이번에도 로컬 카테고리 그래프를 채울 수 있다.
      const existing = db
        .prepare(
          "SELECT categoryDistribution, entropy FROM sessions WHERE sessionId = ?",
        )
        .get(req.body.sessionId);
      const existingDistribution = existing?.categoryDistribution
        ? JSON.parse(existing.categoryDistribution)
        : null;

      // 이번 재시도에서 새로 계산이 완료됐는데(categoryDistribution !== null) 기존
      // 저장값은 아직 미확정(null)이었다면, 최초 실패 원인이 해소된 것이므로 지금
      // 갱신한다. insertSession이 못 하는 갱신을 여기서 대신 한다.
      if (categoryDistribution !== null && existingDistribution === null) {
        db.prepare(
          "UPDATE sessions SET categoryDistribution = ?, entropy = ? WHERE sessionId = ?",
        ).run(
          JSON.stringify(categoryDistribution),
          entropy,
          req.body.sessionId,
        );
      }

      const responseDistribution =
        categoryDistribution !== null
          ? categoryDistribution
          : existingDistribution;
      const responseEntropy =
        categoryDistribution !== null ? entropy : (existing?.entropy ?? null);

      return res.status(409).json({
        success: false,
        message: "이미 존재하는 세션입니다.",
        code: ERROR_CODES.DUPLICATE_SESSION,
        detail:
          process.env.NODE_ENV === "production" ? null : req.body.sessionId,
        data: {
          categoryDistribution: responseDistribution,
          entropy: responseEntropy,
        },
      });
    }
    return next(err);
  }

  // "오늘" 누적 리뷰는 그룹·자격과 무관하게 항상 다시 계산해 저장하고, 지금 이 요청자가 볼 자격이 있을 때만 응답에 싣는다.
  let todayReview = null;
  try {
    const anonymousId = req.body.anonymousId;
    const generated = await generateAndStoreTodayReview(db, {
      anonymousId,
      apiKey: process.env.TODAY_REVIEW_GEMINI_API_KEY,
    });
    if (generated) {
      const participant = db
        .prepare(
          "SELECT group_code, installDate, studyEndCodeVerifiedAt FROM participants WHERE anonymousId = ?",
        )
        .get(anonymousId);
      if (isTodayReviewEligible(participant)) {
        todayReview = generated;
      }
    }
  } catch (err) {
    console.error("[sessions] 오늘 리뷰 생성 오류:", err.message);
  }

  // categoryDistribution/entropy를 응답에 실어 돌려준다.
  return success(res, { todayReview, categoryDistribution, entropy });
});

// 피드백 열람/확인 시각 갱신 — 세션 생성 POST와 별도 시점에(알림 클릭, 확인 버튼 클릭 등)
// 호출된다. anonymousId로 소유권을 확인해 다른 참여자의 세션을 갱신하지 못하도록 막는다.
// column은 요청 값이 아니라 아래 두 router.patch 호출부에서만 하드코딩으로 주어지므로
// SQL 인젝션 경로가 없다(server/db.js의 addColumn(table, name, type) 패턴과 동일한 근거).
function makeFeedbackTimestampHandler(column) {
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

    let result;
    try {
      result = recordFeedbackTimestamp(db, column, sessionId, anonymousId);
    } catch (err) {
      return next(err);
    }

    if (result === "not_found") {
      return fail(
        res,
        404,
        ERROR_CODES.NOT_FOUND,
        "세션을 찾을 수 없습니다.",
        sessionId,
      );
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
