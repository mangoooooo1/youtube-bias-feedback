// sessions 테이블 저장/갱신 로직

function insertSession(db, body) {
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
  } = body;

  db.prepare(
    `
    INSERT INTO sessions (anonymousId, sessionId, startTime, endTime, videoCount, categoryDistribution, entropy, totalMs, youtubeMs, geminiMs, llmStatus, failureReason, httpStatus, timedOut, feedbackNotifiedAt, review, reviewTopic, source, promptVersion)
    VALUES (@anonymousId, @sessionId, @startTime, @endTime, @videoCount, @categoryDistribution, @entropy, @totalMs, @youtubeMs, @geminiMs, @llmStatus, @failureReason, @httpStatus, @timedOut, @feedbackNotifiedAt, @review, @reviewTopic, @source, @promptVersion)
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

// 피드백 열람/확인 시각 갱신
// @returns {"recorded"|"not_found"}
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
