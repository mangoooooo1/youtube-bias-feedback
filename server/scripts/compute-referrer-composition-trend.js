/**
 * 유입 경로(referrerType) 구성 변화 — 탐색적 분석
 *
 * 개입 효과는 "유입 경로 자체의 전환"(예: 추천 위주 → 검색 위주)보다는
 * 추천 피드 안에서의 미세한 선택 변화로 나타날 가능성이 높다고 보고, 유입 경로 구성 변화는
 * 1차/2차 가설이 아니라 탐색적 분석으로 내렸다. 이 스크립트는 그 탐색적 분석을 위해
 * video_events.referrerType(이미 수집 중, video-events-classify.js가 분류)을 참여자·기간
 * 단위로 집계한다.
 *
 * 새 데이터 수집이나 본실험 코드(server/pipeline, server/routes, extension) 변경 없이,
 * 이미 저장된 값만 읽어 JSON 리포트를 만든다. compute-baseline-divergence.js(설계 문서
 * "Viewlens 기준분포 이탈도·시간적 자기유사도 지표 명세서.md")와 동일한 원칙 —
 * 연구자 내부 분석 전용, 참여자 화면에 노출하지 않는다(트랙 A).
 *
 * 사용: node server/scripts/compute-referrer-composition-trend.js
 */
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { db, initializeDB } = require("../db");
const { dayFromInstall, kstDateStr } = require("../pipeline/period-boundaries");
const {
  TOTAL_DAYS,
  DAYS_PER_PERIOD,
  BASELINE_DAYS,
} = require("../pipeline/study-constants");

const ELIGIBLE_GROUPS = ["EXP", "TEST-EXP", "CON", "TEST-CON"];
const REFERRER_TYPES = [
  "direct_search",
  "home_feed",
  "related",
  "external",
  "unknown",
];
const round3 = (x) => Math.round(x * 1000) / 1000;

/** 기간 인덱스(1부터)별 [periodStart, periodEnd, isBaseline] 경계를 만든다. */
function buildPeriodBoundaries(installDate) {
  const totalPeriods = Math.ceil(TOTAL_DAYS / DAYS_PER_PERIOD);
  const periods = [];
  for (let p = 1; p <= totalPeriods; p++) {
    const startOffset = (p - 1) * DAYS_PER_PERIOD;
    const endOffset = p * DAYS_PER_PERIOD - 1;
    periods.push({
      periodIndex: p,
      periodStart: dayFromInstall(installDate, startOffset),
      periodEnd: dayFromInstall(installDate, endOffset),
      isBaseline: startOffset < BASELINE_DAYS,
    });
  }
  return periods;
}

/** referrerType 값이 없거나(구버전 확장) 미분류(unknown)인 이벤트도 unknown 버킷으로 합산한다. */
function composition(events) {
  if (events.length === 0) return null;
  const counts = Object.fromEntries(REFERRER_TYPES.map((t) => [t, 0]));
  for (const e of events) {
    const key = REFERRER_TYPES.includes(e.referrerType)
      ? e.referrerType
      : "unknown";
    counts[key] += 1;
  }
  const ratios = {};
  for (const t of REFERRER_TYPES) ratios[t] = round3(counts[t] / events.length);
  return { total: events.length, ...ratios };
}

/** 참여자별 비율을 동일 가중(참여자 1명 = 1표)으로 단순 평균한다 — 시청량이 많은 참여자가
 * 그룹 평균을 지배하지 않도록 하기 위함(mergeSessionDistributions의 videoCount 가중과는
 * 다른 목적: 여기서는 "그룹 내 개인들이 평균적으로 어떻게 달라졌는가"를 보려는 것이라
 * 참여자 단위 평균이 더 적합하다). */
function groupAverage(participantRows, totalPeriods) {
  const out = {};
  for (let idx = 1; idx <= totalPeriods; idx++) {
    const valid = participantRows
      .map((r) => r.byPeriod[idx])
      .filter((c) => c !== null);
    if (valid.length === 0) {
      out[idx] = null;
      continue;
    }
    const avg = { participantCount: valid.length };
    for (const t of REFERRER_TYPES) {
      avg[t] = round3(valid.reduce((s, v) => s + v[t], 0) / valid.length);
    }
    out[idx] = avg;
  }
  return out;
}

function main() {
  initializeDB();

  const participants = db
    .prepare(
      `SELECT anonymousId, group_code AS groupCode, installDate FROM participants
       WHERE group_code IN (${ELIGIBLE_GROUPS.map(() => "?").join(",")})`,
    )
    .all(...ELIGIBLE_GROUPS);
  const selectEvents = db.prepare(
    `SELECT referrerType, watchedAt FROM video_events WHERE anonymousId = ?`,
  );

  const totalPeriods = Math.ceil(TOTAL_DAYS / DAYS_PER_PERIOD);
  const byParticipant = participants.map((p) => {
    const events = selectEvents.all(p.anonymousId);
    const periods = buildPeriodBoundaries(p.installDate);
    const byPeriod = {};
    for (const period of periods) {
      const inRange = events.filter((e) => {
        const d = kstDateStr(new Date(e.watchedAt));
        return d >= period.periodStart && d <= period.periodEnd;
      });
      byPeriod[period.periodIndex] = composition(inRange);
    }
    return {
      anonymousId: p.anonymousId,
      groupCode: p.groupCode,
      byPeriod,
    };
  });

  const isTest = (g) => g === "TEST-EXP" || g === "TEST-CON";
  const report = {
    generatedAt: new Date().toISOString(),
    totalPeriods,
    baselineDays: BASELINE_DAYS,
    daysPerPeriod: DAYS_PER_PERIOD,
    note:
      "totalPeriods/daysPerPeriod는 server/pipeline/study-constants.js 현재값(2차 테스트 기간 " +
      "기준)을 그대로 따른다 — 본실험용 설정으로 바뀌면 이 스크립트를 다시 실행해야 한다.",
    groupAverage: {
      EXP: groupAverage(
        byParticipant.filter(
          (r) => r.groupCode === "EXP" && !isTest(r.groupCode),
        ),
        totalPeriods,
      ),
      CON: groupAverage(
        byParticipant.filter(
          (r) => r.groupCode === "CON" && !isTest(r.groupCode),
        ),
        totalPeriods,
      ),
    },
    byParticipant,
  };

  db.close();

  const outDir = path.join(__dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `referrer-composition-trend-${Date.now()}.json`,
  );
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(
    `[referrer-trend] 참여자 ${byParticipant.length}명 처리 완료 — 저장됨: ${outPath}`,
  );
}

main();
