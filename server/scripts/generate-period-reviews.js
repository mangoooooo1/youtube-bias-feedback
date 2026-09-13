/**
 * 기간(일차·주차) 리뷰 생성 스크립트
 *
 * 완료된 기간 중 아직 period_reviews가 없는 것을 찾아
 * 그 기간의 sessions/video_events를 집계해 Gemini로 리뷰를 생성하고 저장한다.
 *
 * 기간별 처리는 각자 try/catch로 감싸 한 기간의 실패가 다른 참여자/기간을 막지 않게
 * 하지만(processPeriod 자체도 Gemini 실패를 fallback으로 흡수), 그 결과 run()은
 * 거의 항상 정상 종료했다. Gemini 키가 통째로 무효화돼 모든 기간이 fallback으로
 * 떨어져도 exit code는 계속 0이었다. shouldFail()이 이 경우를 판정해 main()이
 * 실패로 끝내도록 한다: 실제로 예외가 난 기간(skipped)이 하나라도 있거나,
 * Gemini를 시도한 기간 중 하나도 성공 못 했으면(전량 fallback, "세션 없어 애초에 시도 안 함"은 제외) 실패로 본다.
 *
 * 사용:
 *   node server/scripts/generate-period-reviews.js
 *
 */
const path = require("path");

// cron으로 실행될 때는 server/.env가 자동으로 로드되지 않으므로 명시적으로 불러온다
// (backup-db.js와 동일 이유).
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const {
  kstDateStr,
  mergeSessionDistributions,
  pendingCompletedPeriods,
} = require("../pipeline/period-boundaries");
const {
  buildPeriodPrompt,
  generatePeriodReview,
  generatePeriodFallbackReview,
} = require("../pipeline/period-review-llm");
const {
  TOTAL_DAYS,
  DAYS_PER_PERIOD,
  BASELINE_DAYS,
} = require("../pipeline/study-constants");

// 대조군(CON, TEST-CON)도 실험군과 동일한 주기·동일한 코드 경로로 사전 생성한다
const ELIGIBLE_GROUPS = ["EXP", "TEST-EXP", "CON", "TEST-CON"];
const FALLBACK_RETRY_WINDOW_DAYS = 3;

/** 해당 참여자의 세션/영상 제목을 기간 범위(KST 날짜 문자열 기준)로 좁힌다 */
function inRange(dateStr, periodStart, periodEnd) {
  return dateStr >= periodStart && dateStr <= periodEnd;
}

/** periodEnd로부터 FALLBACK_RETRY_WINDOW_DAYS 안이면(오늘 포함) 아직 재시도 대상이다. */
function isRetryEligible(periodEnd) {
  const deadlineMs =
    new Date(periodEnd).getTime() + FALLBACK_RETRY_WINDOW_DAYS * 86400000;
  return kstDateStr(new Date()) <= kstDateStr(new Date(deadlineMs));
}

async function processPeriod({
  apiKey,
  anonymousId,
  period,
  allSessions,
  allTitles,
  insertPeriodReview,
}) {
  const sessionsInRange = allSessions.filter((s) =>
    inRange(
      kstDateStr(new Date(s.endTime)),
      period.periodStart,
      period.periodEnd,
    ),
  );
  const titlesInRange = allTitles
    .filter((v) =>
      inRange(
        kstDateStr(new Date(v.watchedAt)),
        period.periodStart,
        period.periodEnd,
      ),
    )
    .map((v) => v.title);

  const { categoryDistribution, entropy, videoCount } =
    mergeSessionDistributions(sessionsInRange);

  let result;
  let llmStatus;
  let failureReason = null;
  let geminiMs = null;

  if (sessionsInRange.length === 0) {
    // 이 기간엔 분석할 시청 기록이 없음 — Gemini 호출 자체를 생략(불필요한 비용 방지).
    result = generatePeriodFallbackReview({
      categoryDistribution: {},
      videoCount: 0,
    });
    llmStatus = "fallback";
  } else {
    const prompt = buildPeriodPrompt({
      categoryDistribution,
      entropy,
      videoCount,
      videoTitles: titlesInRange,
    });

    const startedAt = Date.now();
    try {
      result = await generatePeriodReview(prompt, apiKey);
      llmStatus = "success";
    } catch (err) {
      result = generatePeriodFallbackReview({
        categoryDistribution,
        videoCount,
      });
      llmStatus = "fallback";
      failureReason = err.failureReason ?? "network_error";
    } finally {
      geminiMs = Date.now() - startedAt;
    }
  }

  insertPeriodReview.run({
    anonymousId,
    periodIndex: period.periodIndex,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    isBaseline: period.isBaseline,
    sessionCount: sessionsInRange.length,
    videoCount,
    categoryDistribution: JSON.stringify(categoryDistribution),
    entropy,
    review: result.feedback,
    reviewTopic: result.topic,
    source: result.source,
    promptVersion: result.promptVersion,
    llmStatus,
    failureReason,
    geminiMs,
    generatedAt: new Date().toISOString(),
  });

  return { llmStatus, failureReason };
}

/**
 * run()이 집계한 카운트로 이번 배치를 실패로 볼지 판정하는 순수 함수
 *
 * - skipped(코드 예외로 처리 자체를 못 한 기간)가 하나라도 있으면 무조건 실패
 *   LLM 문제가 아니라 데이터/로직 버그일 가능성이 커 관대하게 볼 이유가 없다.
 * - llmFailures(세션은 있어서 Gemini를 실제로 호출했는데 실패한 기간)가 있는데
 *   created(성공)가 0이면 실패 "시도한 건 있는데 하나도 못 살렸다"는 패턴은
 *   YouTube API 사고와 같은 유형의 전량 실패를 뜻한다.
 * - fallback(세션이 아예 없어 Gemini 호출 자체를 생략한, 정상적인 경우)만 있고
 *   llmFailures가 0이면 실패가 아니다. 참여자가 그 기간에 안 봤을 뿐이다.
 */
function shouldFail({ skipped, llmFailures, created }) {
  return skipped > 0 || (llmFailures > 0 && created === 0);
}

async function run(db, apiKey) {
  const selectParticipants = db.prepare(`
    SELECT anonymousId, installDate FROM participants
    WHERE group_code IN (${ELIGIBLE_GROUPS.map(() => "?").join(",")})
  `);
  const selectAnalyzedSessions = db.prepare(`
    SELECT categoryDistribution, videoCount, endTime FROM sessions
    WHERE anonymousId = ? AND endTime IS NOT NULL AND categoryDistribution IS NOT NULL
  `);
  const selectVideoTitles = db.prepare(`
    SELECT title, watchedAt FROM video_events
    WHERE anonymousId = ? AND title IS NOT NULL
    ORDER BY watchedAt ASC
  `);
  const selectExistingPeriodReviews = db.prepare(`
    SELECT periodIndex, llmStatus, periodEnd FROM period_reviews WHERE anonymousId = ?
  `);
  // OR REPLACE — llmStatus='fallback'이고 재시도 대상인 기간은 새로 덮어써야 한다.
  // lockedIndexes(아래)가 success/재시도 기간 만료 건만 걸러내므로, 이 문장이 실수로
  // success 행을 덮어쓸 일은 없다(그런 periodIndex는 애초에 처리 대상에 포함되지 않는다).
  const insertPeriodReview = db.prepare(`
    INSERT OR REPLACE INTO period_reviews
      (anonymousId, periodIndex, periodStart, periodEnd, isBaseline, sessionCount,
       videoCount, categoryDistribution, entropy, review, reviewTopic, source,
       promptVersion, llmStatus, failureReason, geminiMs, generatedAt)
    VALUES
      (@anonymousId, @periodIndex, @periodStart, @periodEnd, @isBaseline, @sessionCount,
       @videoCount, @categoryDistribution, @entropy, @review, @reviewTopic, @source,
       @promptVersion, @llmStatus, @failureReason, @geminiMs, @generatedAt)
  `);

  const participants = selectParticipants.all(...ELIGIBLE_GROUPS);
  let created = 0;
  let fallback = 0;
  let llmFailures = 0;
  let skipped = 0;

  for (const participant of participants) {
    const { anonymousId, installDate } = participant;

    const lockedIndexes = new Set(
      selectExistingPeriodReviews
        .all(anonymousId)
        .filter(
          (r) => r.llmStatus === "success" || !isRetryEligible(r.periodEnd),
        )
        .map((r) => r.periodIndex),
    );
    const periods = pendingCompletedPeriods({
      installDate,
      existingIndexes: lockedIndexes,
      totalDays: TOTAL_DAYS,
      daysPerPeriod: DAYS_PER_PERIOD,
      baselineDays: BASELINE_DAYS,
    });
    if (periods.length === 0) continue;

    const rawSessions = selectAnalyzedSessions.all(anonymousId);
    const allSessions = rawSessions
      .map((s) => ({
        ...s,
        categoryDistribution: JSON.parse(s.categoryDistribution || "{}"),
      }))
      .filter((s) => Object.keys(s.categoryDistribution).length > 0);
    const allTitles = selectVideoTitles.all(anonymousId);

    // 밀린 기간이 여러 개면 오래된 순서로 하나씩 — 참여자당 Gemini 호출을 직렬화한다.
    for (const period of periods) {
      try {
        const { llmStatus, failureReason } = await processPeriod({
          apiKey,
          anonymousId,
          period,
          allSessions,
          allTitles,
          insertPeriodReview,
        });
        if (llmStatus === "success") created++;
        // failureReason이 있으면 Gemini를 실제로 호출했다가 실패한 것(세션이 없어
        // 애초에 호출을 생략한 fallback은 failureReason이 null로 남는다. processPeriod 참고)
        else if (failureReason) llmFailures++;
        else fallback++;
      } catch (err) {
        // 한 기간 처리 실패가 다른 참여자/기간까지 막지 않도록 로그만 남기고 계속한다.
        console.error(
          `[period-reviews] ${anonymousId} periodIndex=${period.periodIndex} 처리 실패:`,
          err.message,
        );
        skipped++;
      }
    }
  }

  console.log(
    `[period-reviews] 완료 — 참여자 ${participants.length}명, 생성 llm=${created} fallback=${fallback} llm실패=${llmFailures} 처리실패=${skipped}`,
  );

  return { created, fallback, llmFailures, skipped };
}

async function main() {
  const apiKey = process.env.PERIOD_REVIEW_GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      "[period-reviews] PERIOD_REVIEW_GEMINI_API_KEY 환경변수가 필요합니다.",
    );
    process.exit(1);
  }

  const { db, initializeDB } = require("../db");
  initializeDB();

  let summary;
  try {
    summary = await run(db, apiKey);
  } finally {
    db.close();
  }

  if (shouldFail(summary)) {
    console.error(
      `[period-reviews] 실패 판정 — llm실패=${summary.llmFailures} 처리실패=${summary.skipped} (created=${summary.created}, fallback=${summary.fallback})`,
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[period-reviews] 실패:", err.message);
    process.exitCode = 1;
  });
}

module.exports = { run, processPeriod, inRange, shouldFail };
