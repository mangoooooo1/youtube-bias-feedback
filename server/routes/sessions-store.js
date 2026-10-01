// sessions 테이블 저장/갱신 로직

/**
 * 검증을 통과한 세션 데이터를 sessions 테이블에 저장한다.
 * LLM 생성 결과 칸(llmStatus~promptVersion)은 서버가 recordSessionReview로만 채운다.
 * 클라이언트가 보낸 값은 위조될 수 있어 받지 않는다.
 * @param {import("better-sqlite3").Database} db - DB 커넥션
 * @param {object} body - 세션 필드를 담은 요청 본문 (validateSession 통과 후 호출)
 * @returns {void}
 */
function insertSession(db, body) {
  const {
    anonymousId,
    sessionId,
    startTime,
    endTime,
    videoCount,
    categoryDistribution,
    entropy,
    weightedEntropy,
    weightedCategoryDistribution,
    validVideoCount,
    totalMs,
    youtubeMs,
    feedbackNotifiedAt,
  } = body;

  db.prepare(
    `
    INSERT INTO sessions (anonymousId, sessionId, startTime, endTime, videoCount, categoryDistribution, entropy, weightedEntropy, weightedCategoryDistribution, validVideoCount, totalMs, youtubeMs, feedbackNotifiedAt)
    VALUES (@anonymousId, @sessionId, @startTime, @endTime, @videoCount, @categoryDistribution, @entropy, @weightedEntropy, @weightedCategoryDistribution, @validVideoCount, @totalMs, @youtubeMs, @feedbackNotifiedAt)
  `,
  ).run({
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
    weightedEntropy: weightedEntropy ?? null,
    weightedCategoryDistribution:
      weightedCategoryDistribution != null
        ? JSON.stringify(weightedCategoryDistribution)
        : null,
    validVideoCount: validVideoCount ?? null,
    totalMs: totalMs ?? null,
    youtubeMs: youtubeMs ?? null,
    feedbackNotifiedAt: feedbackNotifiedAt ?? null,
  });
}

/**
 * 이 세션 종료로 생성한 오늘 리뷰 결과를 세션 행에 남긴다.
 * today_reviews는 날짜당 최신본만 남기므로, 생성마다의 성공·폴백과 노출 문장은 여기에만 남는다.
 * @param {import("better-sqlite3").Database} db - DB 커넥션
 * @param {string} sessionId - 이번 요청으로 저장한 세션 id
 * @param {object} generated - generateAndStoreTodayReview 반환값
 * @returns {void}
 */
function recordSessionReview(db, sessionId, generated) {
  db.prepare(
    `UPDATE sessions SET geminiMs = @geminiMs, llmStatus = @llmStatus, failureReason = @failureReason,
       httpStatus = @httpStatus, timedOut = @timedOut, review = @review, reviewTopic = @reviewTopic,
       source = @source, promptVersion = @promptVersion
     WHERE sessionId = @sessionId`,
  ).run({
    sessionId,
    geminiMs: generated.geminiMs ?? null,
    llmStatus: generated.llmStatus ?? null,
    failureReason: generated.failureReason ?? null,
    httpStatus: generated.httpStatus ?? null,
    timedOut: generated.timedOut ?? null,
    review: generated.review ?? null,
    reviewTopic: generated.reviewTopic ?? null,
    source: generated.source ?? null,
    promptVersion: generated.promptVersion ?? null,
  });
}

/**
 * 피드백 열람/확인 시각을 기록한다. 해당 컬럼이 이미 값을 가지고 있으면(중복 열람)
 * 덮어쓰지 않는다(SQL의 `IS NULL` 조건).
 * @param {import("better-sqlite3").Database} db - DB 커넥션
 * @param {string} column - 갱신할 컬럼명 (예: "todayFeedbackViewedAt")
 * @param {string} sessionId - 대상 세션 id
 * @param {string} anonymousId - 대상 참여자 익명 id
 * @returns {"recorded"|"not_found"} 세션 자체가 없으면 "not_found", 있으면 "recorded"
 */
function recordFeedbackTimestamp(db, column, sessionId, anonymousId) {
  const exists = db
    .prepare(
      `SELECT 1 FROM sessions WHERE sessionId = @sessionId AND anonymousId = @anonymousId`,
    )
    .get({ sessionId, anonymousId });

  if (!exists) return "not_found";

  db.prepare(
    `UPDATE sessions SET ${column} = @value WHERE sessionId = @sessionId AND anonymousId = @anonymousId AND ${column} IS NULL`,
  ).run({ sessionId, anonymousId, value: new Date().toISOString() });

  return "recorded";
}

module.exports = {
  insertSession,
  recordSessionReview,
  recordFeedbackTimestamp,
};
