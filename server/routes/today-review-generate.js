// 세션이 끝날 때마다(POST /api/sessions) "오늘" 누적 리뷰를 서버에서 다시 계산해 저장한다.
const { aggregateTodayCumulative } = require("../pipeline/today-boundaries");
const {
  buildTodayCumulativePrompt,
  generateTodayReview,
  generateTodayFallbackReview,
} = require("../pipeline/today-review-llm");
const { upsertTodayReview } = require("./today-reviews-upsert");

/** 같은 (anonymousId, reviewDate)의 기존 genCount보다 1 큰 값을 계산한다(없으면 1). */
function nextGenCount(db, anonymousId, reviewDate) {
  const existing = db
    .prepare(
      "SELECT genCount FROM today_reviews WHERE anonymousId = ? AND reviewDate = ?",
    )
    .get(anonymousId, reviewDate);
  return (existing?.genCount ?? 0) + 1;
}

/**
 * anonymousId의 "오늘" 누적 리뷰를 다시 계산해 today_reviews에 저장하고 그 결과를 반환한다.
 * 오늘 분석된 세션이 하나도 없으면(극히 드묾 — 오늘 모든 세션의 YouTube 카테고리 조회가
 * 전부 실패한 경우 등) null을 반환한다. apiKey가 없으면(.env 미설정) Gemini 호출 없이
 * 결정론적 폴백 문구만 사용한다.
 */
async function generateAndStoreTodayReview(
  db,
  { anonymousId, apiKey, now = new Date() },
) {
  const rawSessions = db
    .prepare(
      `SELECT sessionId, endTime, categoryDistribution, videoCount FROM sessions
       WHERE anonymousId = ? AND endTime IS NOT NULL AND categoryDistribution IS NOT NULL`,
    )
    .all(anonymousId);
  const sessions = rawSessions
    .map((s) => ({
      ...s,
      categoryDistribution: JSON.parse(s.categoryDistribution || "{}"),
    }))
    .filter((s) => Object.keys(s.categoryDistribution).length > 0);
  const titles = db
    .prepare(
      `SELECT title, watchedAt FROM video_events
       WHERE anonymousId = ? AND title IS NOT NULL ORDER BY watchedAt ASC`,
    )
    .all(anonymousId);

  const aggregate = aggregateTodayCumulative({ sessions, titles, now });
  if (!aggregate) return null;

  const prompt = buildTodayCumulativePrompt(aggregate);

  let result;
  let llmStatus = "success";
  let failureReason = null;
  const startedAt = Date.now();
  if (!apiKey) {
    // 키 미설정(예: 로컬 개발 환경) — Gemini를 부르지 않고 바로 폴백.
    result = generateTodayFallbackReview(aggregate);
    llmStatus = "fallback";
  } else {
    try {
      result = await generateTodayReview(prompt, apiKey);
    } catch (err) {
      result = generateTodayFallbackReview(aggregate);
      llmStatus = "fallback";
      failureReason = err.failureReason ?? "network_error";
    }
  }
  const geminiMs = Date.now() - startedAt;

  const genCount = nextGenCount(db, anonymousId, aggregate.reviewDate);
  const generatedAt = new Date().toISOString();

  upsertTodayReview(db, {
    anonymousId,
    reviewDate: aggregate.reviewDate,
    sessionCount: aggregate.sessionCount,
    videoCount: aggregate.videoCount,
    categoryDistribution: aggregate.categoryDistribution,
    entropy: aggregate.entropy,
    review: result.feedback,
    reviewTopic: result.topic,
    source: result.source,
    promptVersion: result.promptVersion,
    llmStatus,
    failureReason,
    geminiMs,
    genCount,
    generatedAt,
  });

  return {
    reviewDate: aggregate.reviewDate,
    review: result.feedback,
    reviewTopic: result.topic,
    source: result.source,
    promptVersion: result.promptVersion,
    llmStatus,
    failureReason,
    geminiMs,
    genCount,
    generatedAt,
  };
}

module.exports = { generateAndStoreTodayReview };
