/**
 * 면담 대상자 선정 지원 — 베이스라인 대비 개입기 엔트로피 변화량 기준 목적표집
 *
 * "ViewLens 연구 설문지·면담 질문지 최종본"(2026-08-05) 면담 진행 안내: "무작위가 아니라,
 * 베이스라인 대비 개입기 엔트로피 변화량이 큰 상위 2~3명과 변화가 거의 없었던 하위 2~3명을
 * 의도적으로 포함하는 목적표집으로 선정"(실험군·대조군 각 5명). 이 스크립트는 그 선정
 * 근거 수치(순위)만 만든다 — 최종 대상자 확정은 연구자가 출력을 보고 판단한다(자동 확정 아님,
 * 예: 연락 가능 여부·응답률 등 이 스크립트가 모르는 요인도 고려해야 하므로).
 *
 * 변화량은 참여자별 베이스라인 기간(period_reviews.isBaseline=1) 대비 가장 마지막으로 완료된
 * 개입기 기간의 entropy 차이로 정의한다(1차 지표 기준으로 정렬). weightedEntropy 변화량(피드백
 * 1·2로 추가된 시간 가중 보조 지표)도 함께 보고해, 두 기준의 상위/하위 순위가 갈리는 참여자가
 * 있는지 연구자가 대조할 수 있게 한다.
 *
 * 새 데이터 수집이나 본실험 코드 변경 없이 이미 저장된 period_reviews만 읽는다.
 *
 * 사용: node server/scripts/select-interview-candidates.js [topN]
 *   topN 생략 시 3 (면담 가이드의 "상위 2~3명" 상한에 맞춤)
 */
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { db, initializeDB } = require("../db");

const round3 = (x) => Math.round(x * 1000) / 1000;
const GROUPS = { EXP: ["EXP", "TEST-EXP"], CON: ["CON", "TEST-CON"] };

function buildGroupCandidates(selectPeriods, groupCodes, topN) {
  const participants = db
    .prepare(
      `SELECT anonymousId FROM participants
       WHERE group_code IN (${groupCodes.map(() => "?").join(",")})`,
    )
    .all(...groupCodes);

  const rows = [];
  for (const p of participants) {
    const periods = selectPeriods.all(p.anonymousId);
    const baseline = periods.find((r) => r.isBaseline === 1);
    const interventionPeriods = periods.filter((r) => r.isBaseline === 0);
    const last = interventionPeriods[interventionPeriods.length - 1];
    // 개입기가 아직 한 구간도 끝나지 않았거나 entropy가 null(예: 그 기간에 시청 기록 없음)이면
    // 변화량을 정의할 수 없어 후보에서 제외한다 — 연구 진행 중에는 당연히 발생할 수 있는 상태다.
    if (
      !baseline ||
      !last ||
      baseline.entropy == null ||
      last.entropy == null
    ) {
      continue;
    }
    // 정렬은 반올림 전 원시 차이(rawEntropyChange)로 한다.
    // round3된 표시값으로 정렬하면 실제 차이가 반올림 단위보다
    // 작은 참여자들의 순서가 값이 아니라 우연한 DB 조회 순서로 정해질 수 있다.
    const rawEntropyChange = last.entropy - baseline.entropy;
    const rawWeightedEntropyChange =
      baseline.weightedEntropy != null && last.weightedEntropy != null
        ? last.weightedEntropy - baseline.weightedEntropy
        : null;
    rows.push({
      anonymousId: p.anonymousId,
      rawEntropyChange,
      entropyChange: round3(rawEntropyChange),
      weightedEntropyChange:
        rawWeightedEntropyChange != null
          ? round3(rawWeightedEntropyChange)
          : null,
      lastInterventionPeriodIndex: last.periodIndex,
    });
  }

  rows.sort((a, b) => b.rawEntropyChange - a.rawEntropyChange);

  // rawEntropyChange는 정렬 전용 내부값이라 최종 출력에는 반올림된 entropyChange만 남긴다.
  const toPublic = ({ rawEntropyChange: _raw, ...rest }) => rest;

  return {
    eligibleCount: rows.length,
    // 표본이 topN*2보다 적으면 상위/하위 구간이 겹칠 수 있다 — 연구자가 직접 확인해야 함.
    topChange: rows.slice(0, topN).map(toPublic),
    bottomChange: rows.slice(-topN).reverse().map(toPublic),
    all: rows.map(toPublic),
  };
}

function main() {
  const topN = Number(process.argv[2]) || 3;
  initializeDB();

  const selectPeriods = db.prepare(
    `SELECT periodIndex, isBaseline, entropy, weightedEntropy FROM period_reviews
     WHERE anonymousId = ? ORDER BY periodIndex ASC`,
  );

  const report = {
    generatedAt: new Date().toISOString(),
    topN,
    note:
      "자동 확정이 아니라 연구자가 최종 판단할 수 있도록 순위와 근거 수치만 제공한다. " +
      "entropyChange(1차 지표, 영상 개수 가중)로 정렬했고, weightedEntropyChange(2차 지표, " +
      "시청시간 가중)도 함께 보고해 두 기준의 상위/하위 순위가 갈리는 참여자가 있는지 " +
      "대조할 수 있게 한다. eligibleCount가 topN*2보다 적은 그룹은 상위/하위 구간이 겹칠 수 있다.",
    EXP: buildGroupCandidates(selectPeriods, GROUPS.EXP, topN),
    CON: buildGroupCandidates(selectPeriods, GROUPS.CON, topN),
  };

  db.close();

  const outDir = path.join(__dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `interview-candidates-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`[interview-candidates] 저장됨: ${outPath}`);
}

main();
