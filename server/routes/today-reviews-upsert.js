// today_reviews upsert 로직
//
// 실제 암호화 DB 연결에 의존하지 않고 db 인스턴스를 인자로 받는 형태로 분리

/** (anonymousId, reviewDate) 기준으로 오늘 누적 리뷰 최신본을 upsert한다. */
function upsertTodayReview(db, payload) {
  const {
    anonymousId,
    reviewDate,
    sessionCount,
    videoCount,
    categoryDistribution,
    entropy,
    review,
    reviewTopic,
    source,
    promptVersion,
    llmStatus,
    failureReason,
    geminiMs,
    genCount,
    generatedAt,
  } = payload;

  db.prepare(
    `INSERT INTO today_reviews
      (anonymousId, reviewDate, sessionCount, videoCount, categoryDistribution, entropy,
       review, reviewTopic, source, promptVersion, llmStatus, failureReason, geminiMs,
       genCount, generatedAt, updatedAt)
     VALUES
      (@anonymousId, @reviewDate, @sessionCount, @videoCount, @categoryDistribution, @entropy,
       @review, @reviewTopic, @source, @promptVersion, @llmStatus, @failureReason, @geminiMs,
       @genCount, @generatedAt, @updatedAt)
     ON CONFLICT(anonymousId, reviewDate) DO UPDATE SET
       sessionCount         = excluded.sessionCount,
       videoCount           = excluded.videoCount,
       categoryDistribution = excluded.categoryDistribution,
       entropy              = excluded.entropy,
       review               = excluded.review,
       reviewTopic          = excluded.reviewTopic,
       source               = excluded.source,
       promptVersion        = excluded.promptVersion,
       llmStatus            = excluded.llmStatus,
       failureReason        = excluded.failureReason,
       geminiMs             = excluded.geminiMs,
       genCount             = excluded.genCount,
       generatedAt          = excluded.generatedAt,
       updatedAt            = excluded.updatedAt
     WHERE excluded.genCount IS NULL
        OR today_reviews.genCount IS NULL
        OR excluded.genCount >= today_reviews.genCount`,
  ).run({
    anonymousId,
    reviewDate,
    sessionCount: sessionCount ?? null,
    videoCount: videoCount ?? null,
    categoryDistribution:
      categoryDistribution != null
        ? JSON.stringify(categoryDistribution)
        : null,
    entropy: entropy ?? null,
    review: review ?? null,
    reviewTopic: reviewTopic ?? null,
    source: source ?? null,
    promptVersion: promptVersion ?? null,
    llmStatus: llmStatus ?? null,
    failureReason: failureReason ?? null,
    geminiMs: geminiMs ?? null,
    genCount: genCount ?? null,
    generatedAt,
    updatedAt: new Date().toISOString(),
  });
}

module.exports = { upsertTodayReview };
