/**
 * 피드백 열람 횟수와 다양성 변화량의 관계 — 탐색적 분석
 *
 * "피드백 열람 횟수와 변화량의 관계(열람을 많이 한 참여자일수록 변화가 큰지)"를 확인한다.
 * 실험군(EXP/TEST-EXP)만 대상으로 한다. 대조군은 연구 종료 전까지 피드백을 받지 않으므로
 * "열람 횟수"라는 변수 자체가 존재하지 않는다.
 *
 * 변화량은 참여자별 베이스라인 기간(period_reviews.isBaseline=1) 대비 가장 마지막으로
 * 완료된 개입기 기간의 entropy/weightedEntropy 차이로 정의한다. weightedEntropy는
 * 오클릭 필터 + 시청시간 가중이 적용된 2차 가설용 지표이므로 둘 다 함께
 * 보고해 1차 지표(entropy)만으로 내린 결론과 갈리는지 대조할 수 있게 한다.
 *
 * 새 데이터 수집이나 본실험 코드 변경 없이 이미 저장된 sessions.feedbackViewedAt,
 * popup_events.pastDayReviewViews, period_reviews만 읽는다.
 *
 * pastDayViewCount는 날짜 이동으로 지난 날 리뷰를 2초 이상 본 날짜 수를 팝업마다 더한 값이다.
 * viewCount(알림 클릭, 세션 단위)와 단위가 달라 합치지 않고 따로 보고한다. 팝업을 여러 번 열어
 * 같은 날짜를 다시 보면 그만큼 더 센다. 참여자 표본이 적을 때(파일럿 단계) 상관계수가 불안정할 수 있으므로
 * n을 항상 함께 보고한다.
 *
 * viewCount는 lastIntervention.periodEnd 이전(그날 포함) 열람만 센다 — 그 뒤에 발생한 열람을
 * 포함하면 아직 entropyChange에 반영되지 않은 미래 시점의 열람이 상관계수에 섞여 시간 순서가
 * 어긋난다(예측변수가 결과변수 측정 구간 이후에 일어난 사건을 포함하게 됨).
 *
 * 사용: node server/scripts/compute-feedback-engagement-correlation.js
 */
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { kstDateStr } = require("../pipeline/period-boundaries");

const round3 = (x) => Math.round(x * 1000) / 1000;

/** 피어슨 상관계수. n<2이거나 어느 한쪽 분산이 0이면(변화가 전혀 없는 표본) null을 반환한다. */
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return null;
  return round3(num / Math.sqrt(dx2 * dy2));
}

/**
 * periodEnd 이전(그날 포함)에 연 팝업의 지난 날 리뷰 열람 날짜 수 합.
 * openedAt이나 값이 없는 행(구버전 확장)은 세지 않는다.
 * @param {{openedAt: string|null, pastDayReviewViews: number|null}[]} events
 * @param {string} periodEnd - YYYY-MM-DD(KST)
 */
function countPastDayViews(events, periodEnd) {
  return events
    .filter(
      (e) =>
        e.openedAt != null &&
        e.pastDayReviewViews != null &&
        kstDateStr(new Date(e.openedAt)) <= periodEnd,
    )
    .reduce((sum, e) => sum + e.pastDayReviewViews, 0);
}

function main() {
  // 모듈을 불러오는 것만으로 운영 DB를 열지 않도록 실행할 때 연다
  const { db, initializeDB } = require("../db");
  initializeDB();

  const participants = db
    .prepare(
      `SELECT anonymousId FROM participants WHERE group_code IN ('EXP', 'TEST-EXP')`,
    )
    .all();
  // 집계 COUNT가 아니라 개별 시각을 가져온다
  // lastIntervention.periodEnd 이전 열람만 세려면 JS 쪽에서 날짜 비교가 필요하다.
  const selectViewedAt = db.prepare(
    `SELECT feedbackViewedAt FROM sessions WHERE anonymousId = ? AND feedbackViewedAt IS NOT NULL`,
  );
  const selectPopupEvents = db.prepare(
    `SELECT openedAt, pastDayReviewViews FROM popup_events WHERE anonymousId = ?`,
  );
  const selectPeriods = db.prepare(
    `SELECT periodIndex, periodEnd, isBaseline, entropy, weightedEntropy FROM period_reviews
     WHERE anonymousId = ? ORDER BY periodIndex ASC`,
  );

  const rows = [];
  let excludedNoInterventionPeriod = 0;
  for (const p of participants) {
    const periods = selectPeriods.all(p.anonymousId);
    const baseline = periods.find((r) => r.isBaseline === 1);
    const interventionPeriods = periods.filter((r) => r.isBaseline === 0);
    const lastIntervention =
      interventionPeriods[interventionPeriods.length - 1];
    // 개입기가 아직 한 구간도 끝나지 않은 참여자는 "변화량"을 정의할 수 없어 제외한다
    // (아직 진행 중인 연구에서 당연히 발생 — 실패가 아니라 "표본 아직 미확보"로 기록).
    if (!baseline || !lastIntervention) {
      excludedNoInterventionPeriod++;
      continue;
    }

    // viewCount는 lastIntervention.periodEnd 이전(그날 포함) 열람만 센다.
    const viewCount = selectViewedAt
      .all(p.anonymousId)
      .filter(
        (r) =>
          kstDateStr(new Date(r.feedbackViewedAt)) <=
          lastIntervention.periodEnd,
      ).length;
    const pastDayViewCount = countPastDayViews(
      selectPopupEvents.all(p.anonymousId),
      lastIntervention.periodEnd,
    );
    const entropyChange =
      lastIntervention.entropy != null && baseline.entropy != null
        ? round3(lastIntervention.entropy - baseline.entropy)
        : null;
    const weightedEntropyChange =
      lastIntervention.weightedEntropy != null &&
      baseline.weightedEntropy != null
        ? round3(lastIntervention.weightedEntropy - baseline.weightedEntropy)
        : null;

    rows.push({
      anonymousId: p.anonymousId,
      viewCount,
      pastDayViewCount,
      lastInterventionPeriodIndex: lastIntervention.periodIndex,
      entropyChange,
      weightedEntropyChange,
    });
  }

  const withEntropyChange = rows.filter((r) => r.entropyChange != null);
  const withWeightedChange = rows.filter(
    (r) => r.weightedEntropyChange != null,
  );

  const report = {
    generatedAt: new Date().toISOString(),
    note:
      "상관계수는 참여자 수가 적으면(파일럿 단계) 불안정할 수 있다 — 항상 n과 함께 해석할 것. " +
      "weightedEntropyChange는 sessions/period_reviews에 시청시간 데이터가 쌓이기 전(구버전 확장) " +
      "참여자는 null이 될 수 있다(feedback 1 참고). " +
      "pastDayViewCount는 그 기록을 남기기 전 확장 버전의 팝업을 세지 않아 0일 수 있다.",
    eligibleParticipantCount: participants.length,
    excludedNoInterventionPeriod,
    analyzedParticipantCount: rows.length,
    pearson: {
      viewCount_vs_entropyChange: {
        n: withEntropyChange.length,
        r: pearson(
          withEntropyChange.map((r) => r.viewCount),
          withEntropyChange.map((r) => r.entropyChange),
        ),
      },
      viewCount_vs_weightedEntropyChange: {
        n: withWeightedChange.length,
        r: pearson(
          withWeightedChange.map((r) => r.viewCount),
          withWeightedChange.map((r) => r.weightedEntropyChange),
        ),
      },
      pastDayViewCount_vs_entropyChange: {
        n: withEntropyChange.length,
        r: pearson(
          withEntropyChange.map((r) => r.pastDayViewCount),
          withEntropyChange.map((r) => r.entropyChange),
        ),
      },
      pastDayViewCount_vs_weightedEntropyChange: {
        n: withWeightedChange.length,
        r: pearson(
          withWeightedChange.map((r) => r.pastDayViewCount),
          withWeightedChange.map((r) => r.weightedEntropyChange),
        ),
      },
    },
    rows,
  };

  db.close();

  const outDir = path.join(__dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `feedback-engagement-correlation-${Date.now()}.json`,
  );
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(
    `[feedback-engagement] 참여자 ${rows.length}명 처리 완료 — 저장됨: ${outPath}`,
  );
}

if (require.main === module) main();

module.exports = { countPastDayViews, pearson };
