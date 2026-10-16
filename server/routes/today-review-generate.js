// 세션이 끝날 때마다(POST /api/sessions) "오늘" 누적 리뷰를 서버에서 다시 계산해 저장한다.
const { aggregateTodayCumulative } = require("../pipeline/today-boundaries");
const {
  buildTodayCumulativePrompt,
  generateTodayReview,
  generateTodayFallbackReview,
} = require("../pipeline/today-review-llm");
const { upsertTodayReview } = require("./today-reviews-upsert");
const { recordLlmCall } = require("../monitoring/llm-metrics");

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
 * 오늘 유효 시청 영상이 하나도 없으면 null을 반환한다. apiKey가 없으면(.env 미설정) Gemini 호출 없이
 * 결정론적 폴백 문구만 사용한다.
 */
async function generateAndStoreTodayReview(
  db,
  { anonymousId, apiKey, now = new Date(), recordMetric = recordLlmCall },
) {
  // 세션이 아니라 영상 기록에서 직접 집계한다. 카테고리를 아직 못
  // 가져온 영상도 포함해 넘긴다. 분포에서만 빠지고 영상 수·제목에는 들어간다.
  const events = db
    .prepare(
      `SELECT e.eventId, e.sessionId, e.title, e.watchedAt, e.watchedSeconds,
              m.categoryId, m.durationSeconds
       FROM video_events e
       LEFT JOIN video_metadata m ON m.videoId = e.videoId
       WHERE e.anonymousId = ?
       ORDER BY e.watchedAt ASC`,
    )
    .all(anonymousId);

  const aggregate = aggregateTodayCumulative({ events, now });
  if (!aggregate) return null;

  const prompt = buildTodayCumulativePrompt(aggregate);

  let result;
  let llmStatus = "success";
  let failureReason = null;
  let httpStatus = null;
  let timedOut = null;
  // 오늘 유효 영상이 모두 카테고리를 못 가져온 경우(유튜브 API 장애 등) — 프롬프트가 근거로 삼을
  // 분포가 없으므로 Gemini를 부르지 않고 "분석하지 못했다"는 폴백을 저장한다. 카테고리를 다시
  // 가져오면 다음 생성에서 정상 리뷰로 바뀐다. 일부만 없는 날은 그대로 Gemini를 부른다.
  const hasCategories = Object.keys(aggregate.categoryDistribution).length > 0;
  const callGemini = Boolean(apiKey) && hasCategories;
  const startedAt = Date.now();
  if (!callGemini) {
    // 키 미설정(예: 로컬 개발 환경)이거나 근거 분포가 없음 — Gemini를 부르지 않고 바로 폴백.
    result = generateTodayFallbackReview(aggregate);
    llmStatus = "fallback";
  } else {
    try {
      result = await generateTodayReview(prompt, apiKey);
    } catch (err) {
      result = generateTodayFallbackReview(aggregate);
      llmStatus = "fallback";
      failureReason = err.failureReason ?? "network_error";
      httpStatus = err.httpStatus ?? null;
      timedOut = err.timedOut ? 1 : null;
    }
  }
  const geminiMs = Date.now() - startedAt;
  recordMetric({
    kind: "today",
    llmStatus,
    failureReason,
    geminiMs,
    calledGemini: callGemini,
  });

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
    httpStatus,
    timedOut,
    geminiMs,
    genCount,
    generatedAt,
  };
}

module.exports = { generateAndStoreTodayReview };
