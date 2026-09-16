const express = require("express");
const { db } = require("../db");
const { success, fail, ERROR_CODES } = require("../middleware/responseHandler");
const { validateSession } = require("./sessions-validate");
const { insertSession, recordFeedbackTimestamp } = require("./sessions-store");
const { requireParticipant } = require("../middleware/requireParticipant");
const { generateAndStoreTodayReview } = require("./today-review-generate");
const { isTodayReviewEligible } = require("./today-reviews-query");
const {
  ensureVideoMetadata,
  getCategoryIdsForVideos,
  getDurationsForVideos,
  findMissingVideoIds,
} = require("./video-metadata-store");
const {
  calculateDistribution,
  calculateEntropy,
  isValidWatch,
  calculateWeightedDistribution,
} = require("../pipeline/category-diversity");

const router = express.Router();

/**
 * categoryId가 전부 해소된 뒤 호출한다. 클릭성 이탈(오클릭) 영상을 걸러낸 1차 지표
 * (영상 개수 가중)와, 같은 필터를 통과한 영상들을 실제 시청 시간으로 가중한 보조 지표(weightedEntropy)를 함께 산출한다.
 * watchedSecondsList가 전혀 없는(구버전 확장) 요청은 isValidWatch가 전부 true를 반환해 기존 동작과 동일하게 유지되고, weighted 계열만 "데이터 없음(null)"으로 남는다.
 * @param {import("better-sqlite3").Database} db - DB 커넥션
 * @param {string[]} videoIds - 세션에서 시청한 videoId 목록 (중복 포함)
 * @param {(number|null)[]|undefined} watchedSecondsList - videoIds와 병렬인 시청시간(초) 원시값, 없으면 undefined
 * @returns {{categoryDistribution: object, entropy: number, weightedCategoryDistribution: object|null, weightedEntropy: number|null, validVideoCount: number}}
 */
function computeSessionAnalysis(db, videoIds, watchedSecondsList) {
  const categoryIds = getCategoryIdsForVideos(db, videoIds);
  const durations = getDurationsForVideos(db, videoIds);
  const list = Array.isArray(watchedSecondsList)
    ? watchedSecondsList
    : videoIds.map(() => null);

  const entries = videoIds.map((_, i) => ({
    categoryId: categoryIds[i],
    durationSeconds: durations[i],
    watchedSeconds: list[i] ?? null,
  }));
  const validEntries = entries.filter((e) => isValidWatch(e));

  const categoryDistribution = calculateDistribution(
    validEntries.map((e) => e.categoryId),
  );
  const entropy = calculateEntropy(categoryDistribution);

  // 합을 구해 0보다 큰지 보는 대신 양수 항목의 존재 자체를 본다.
  // 유효 항목이 많으면 개별 값은 유한해도 그 합이 부동소수점 오버플로로 Infinity가 될 수 있는데,
  // 이 분기 판단에 굳이 그런 위험을 지닌 합계를 만들어 쓸 이유가 없다.
  const hasPositiveWatchedSeconds = validEntries.some(
    (e) => (e.watchedSeconds ?? 0) > 0,
  );
  let weightedCategoryDistribution = null;
  let weightedEntropy = null;
  if (hasPositiveWatchedSeconds) {
    weightedCategoryDistribution = calculateWeightedDistribution(
      validEntries.map((e) => ({
        categoryId: e.categoryId,
        weight: e.watchedSeconds ?? 0,
      })),
    );
    weightedEntropy = calculateEntropy(weightedCategoryDistribution);
  }

  return {
    categoryDistribution,
    entropy,
    weightedCategoryDistribution,
    weightedEntropy,
    validVideoCount: validEntries.length,
  };
}

router.post("/", requireParticipant, async (req, res, next) => {
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
  // 클라이언트는 이 세션에서 시청한 videoId 목록(중복 포함)과, 같은 순서의 시청시간
  // 원시 데이터(watchedSecondsList, 선택)만 보낸다.
  const { videoIds, watchedSecondsList } = req.body;
  const youtubeStart = Date.now();
  await ensureVideoMetadata(db, videoIds, process.env.YOUTUBE_API_KEY);
  // YOUTUBE_API_KEY 미설정·일시적 API 장애 등으로 일부 videoId가 끝내 캐시되지
  // 못했으면(ensureVideoMetadata가 건너뛰었거나 청크 전체가 실패한 경우), 이 시점엔
  // 다양성을 확정하지 않는다. {}·0으로 저장해버리면 "확인해봤더니 카테고리가 없음"과
  // "확인 자체를 못함"이 구분되지 않고, insertSession은 UPSERT가 아니라서 원인이
  // 나중에 해소돼도 갱신할 방법이 없어 잘못된 값이 영구히 남는다.
  const unresolvedVideoIds = findMissingVideoIds(db, videoIds);
  const analysis =
    unresolvedVideoIds.length === 0
      ? computeSessionAnalysis(db, videoIds, watchedSecondsList)
      : {
          categoryDistribution: null,
          entropy: null,
          weightedCategoryDistribution: null,
          weightedEntropy: null,
          validVideoCount: null,
        };
  const { categoryDistribution, entropy } = analysis;
  // youtubeMs는 더 이상 클라이언트가 측정해 보내지 않는다.
  const youtubeMs = Date.now() - youtubeStart;

  try {
    insertSession(db, {
      ...req.body,
      ...analysis,
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
      // 갱신한다. insertSession이 못 하는 갱신을 여기서 대신 한다. weighted 계열도
      // 같은 시점에 함께 확정되므로 같이 갱신한다.
      if (categoryDistribution !== null && existingDistribution === null) {
        db.prepare(
          `UPDATE sessions SET categoryDistribution = ?, entropy = ?,
             weightedCategoryDistribution = ?, weightedEntropy = ?, validVideoCount = ?
           WHERE sessionId = ?`,
        ).run(
          JSON.stringify(categoryDistribution),
          entropy,
          analysis.weightedCategoryDistribution != null
            ? JSON.stringify(analysis.weightedCategoryDistribution)
            : null,
          analysis.weightedEntropy,
          analysis.validVideoCount,
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

/**
 * 지정한 컬럼에 피드백 열람/확인 시각을 기록하는 Express 라우트 핸들러를 만든다.
 * 세션 생성 POST와 별도 시점에(알림 클릭, 확인 버튼 클릭 등) 호출되며, anonymousId로
 * 소유권을 확인해 다른 참여자의 세션을 갱신하지 못하도록 막는다. column은 요청 값이
 * 아니라 아래 두 router.patch 호출부에서만 하드코딩으로 주어지므로 SQL 인젝션 경로가
 * 없다(server/db.js의 addColumn(table, name, type) 패턴과 동일한 근거).
 * @param {string} column - 갱신할 sessions 테이블 컬럼명 (예: "feedbackViewedAt")
 * @returns {import("express").RequestHandler} sessionId 세션에 해당 컬럼을 기록하는 핸들러
 */
function makeFeedbackTimestampHandler(column) {
  return (req, res, next) => {
    const { sessionId } = req.params;
    // requireParticipant가 이미 anonymousId 존재·형식을 검증한 뒤에만 여기 도달한다.
    const anonymousId = req.body.anonymousId;

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
  requireParticipant,
  makeFeedbackTimestampHandler("feedbackViewedAt"),
);
// "피드백 확인하기" 블러 해제 버튼 클릭 기준 — popup.js가 호출 (가장 엄격한 신호)
router.patch(
  "/:sessionId/feedback-confirmed",
  requireParticipant,
  makeFeedbackTimestampHandler("feedbackConfirmedAt"),
);

module.exports = router;
