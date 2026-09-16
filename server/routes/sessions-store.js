// sessions 테이블 저장/갱신 로직

/**
 * 검증을 통과한 세션 데이터를 sessions 테이블에 저장한다.
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
  } = body;

  db.prepare(
    `
    INSERT INTO sessions (anonymousId, sessionId, startTime, endTime, videoCount, categoryDistribution, entropy, weightedEntropy, weightedCategoryDistribution, validVideoCount, totalMs, youtubeMs, geminiMs, llmStatus, failureReason, httpStatus, timedOut, feedbackNotifiedAt, review, reviewTopic, source, promptVersion)
    VALUES (@anonymousId, @sessionId, @startTime, @endTime, @videoCount, @categoryDistribution, @entropy, @weightedEntropy, @weightedCategoryDistribution, @validVideoCount, @totalMs, @youtubeMs, @geminiMs, @llmStatus, @failureReason, @httpStatus, @timedOut, @feedbackNotifiedAt, @review, @reviewTopic, @source, @promptVersion)
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

module.exports = { insertSession, recordFeedbackTimestamp };
