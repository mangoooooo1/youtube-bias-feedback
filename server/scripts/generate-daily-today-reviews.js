/**
 * 지난 날짜의 오늘 리뷰 마감 생성 스크립트
 *
 * 매일 자정 직후 실행해 어제부터 RETRY_DAYS일 전까지의 날짜마다 참여자별 오늘 리뷰를 만든다.
 * - 대조군: 세션 종료 때는 만들지 않으므로(sessions.js) 여기서 그날 전체로 한 번 만든다.
 * - 실험군: 그날 마지막 생성 이후 유효 시청 영상이 늘었으면 한 번 더 만든다.
 * 다시 만들지는 generateAndStoreTodayReview의 규칙(유효 영상 증가 또는 지난 결과가 폴백)을 그대로 따른다.
 * 그래서 이미 정상인 날은 건너뛰고, 폴백인 날은 RETRY_DAYS일 동안 하루 한 번 재시도된다. 실패 판정은 기간 리뷰 크론과 같다.
 *
 * 사용:
 *   node server/scripts/generate-daily-today-reviews.js
 */
const path = require("path");

// cron으로 실행될 때는 server/.env가 자동으로 로드되지 않으므로 명시적으로 불러온다
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const {
  generateAndStoreTodayReview,
} = require("../routes/today-review-generate");
const { kstDateStr } = require("../pipeline/period-boundaries");
const { closeLlmMetrics } = require("../monitoring/llm-metrics");
const { shouldFail } = require("./generate-period-reviews");

// 어제부터 며칠 전까지 처리할지
const RETRY_DAYS = 3;

/** now 기준 어제부터 RETRY_DAYS일 전까지의 KST 날짜(오래된 순). */
function targetDates(now) {
  const todayStart = Date.parse(`${kstDateStr(now)}T00:00:00+09:00`);
  return Array.from({ length: RETRY_DAYS }, (_, i) =>
    kstDateStr(new Date(todayStart - (RETRY_DAYS - i) * 86400000)),
  );
}

/** 그 날짜를 "오늘"로 보고 집계하도록 넘길 기준 시각(그날 KST 마지막 순간). */
function endOfKstDay(date) {
  return new Date(`${date}T23:59:59.999+09:00`);
}

async function run(db, apiKey, { now = new Date(), recordMetric } = {}) {
  const participants = db.prepare("SELECT anonymousId FROM participants").all();
  const dates = targetDates(now);

  let created = 0;
  let fallback = 0;
  let llmFailures = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const { anonymousId } of participants) {
    for (const date of dates) {
      try {
        const generated = await generateAndStoreTodayReview(db, {
          anonymousId,
          apiKey,
          now: endOfKstDay(date),
          recordMetric,
        });
        // 그날 유효 시청이 없거나 다시 만들 필요가 없음
        if (!generated) unchanged++;
        else if (generated.llmStatus === "success") created++;
        // failureReason이 있으면 Gemini를 실제로 호출했다가 실패한 것
        else if (generated.failureReason) llmFailures++;
        else fallback++;
      } catch (err) {
        // 한 건의 실패가 다른 참여자·날짜를 막지 않도록 로그만 남기고 계속한다
        console.error(
          `[daily-today-reviews] ${anonymousId} ${date} 처리 실패:`,
          err.message,
        );
        skipped++;
      }
    }
  }

  console.log(
    `[daily-today-reviews] 완료 — 참여자 ${participants.length}명, 날짜 ${dates.join(",")}, 생성 llm=${created} fallback=${fallback} llm실패=${llmFailures} 변화없음=${unchanged} 처리실패=${skipped}`,
  );

  return { created, fallback, llmFailures, unchanged, skipped };
}

async function main() {
  const apiKey = process.env.TODAY_REVIEW_GEMINI_API_KEY;
  if (!apiKey) {
    // 키 없이 돌면 폴백만 조용히 쌓이므로 실패로 끝낸다
    console.error(
      "[daily-today-reviews] TODAY_REVIEW_GEMINI_API_KEY 환경변수가 필요합니다.",
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
      `[daily-today-reviews] 실패 판정 — llm실패=${summary.llmFailures} 처리실패=${summary.skipped} (created=${summary.created}, fallback=${summary.fallback})`,
    );
    process.exitCode = 1;
  }

  await closeLlmMetrics();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[daily-today-reviews] 실패:", err.message);
    process.exitCode = 1;
  });
}

module.exports = { run, targetDates, RETRY_DAYS };
