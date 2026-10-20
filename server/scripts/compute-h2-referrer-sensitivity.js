#!/usr/bin/env node
/**
 * 유입 경로 기준 H2 민감도 분석
 *
 * 참여자 × 완료된 기간마다 weightedEntropy를 세 가지로 계산한다.
 * - 주 분석: 기간 안의 영상 전부
 * - backgroundAutoplay 제외: 탭이 한 번이라도 가려졌고(wasBackgrounded = 1) 앞 영상이 끝나
 *   자동으로 넘어온(relatedTrigger = 'autoplay') 영상을 뺌. 틀어 두고 소리로 들은 시청을 빼도
 *   결론이 같은지 본다. 둘 중 하나만 해당하거나 값을 모르면(NULL) 빼지 않는다.
 * - directSearch 제외: 검색 결과에서 들어온(referrerType = 'direct_search') 영상을 뺌.
 *   효과가 추천 피드 안의 선택 변화인지, 직접 검색한 시청에서만 나온 것인지 구분한다.
 * 세 값 모두 aggregateViewing으로 계산해 유효 시청·시청시간 상한 정의를 주 분석과 맞춘다.
 * 주 분석 값도 저장값(period_reviews)이 아니라 같은 원본에서 다시 계산해, 차이가 제외 조건에서만 생기게 한다.
 * 라벨 품질은 check-referrer-trigger-quality.js로 먼저 확인한다.
 *
 * 참여자는 지문으로만 출력한다. DB는 읽기 전용으로 연다.
 *
 * 사용:
 *   node server/scripts/compute-h2-referrer-sensitivity.js <DB 경로> [그룹...]
 *   (DB 경로는 SOURCE_DB_PATH로도 지정 가능, 그룹 기본값 EXP CON)
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { fingerprint } = require("./fingerprint");
const { parseGroupsArg } = require("./check-referrer-trigger-quality");
const {
  kstDateStr,
  pendingCompletedPeriods,
} = require("../pipeline/period-boundaries");
const { aggregateViewing } = require("../pipeline/viewing-aggregate");
const {
  TOTAL_DAYS,
  DAYS_PER_PERIOD,
  BASELINE_DAYS,
} = require("../pipeline/study-constants");
const {
  getCategoryIdsForVideos,
  getDurationsForVideos,
} = require("../routes/video-metadata-store");

const DEFAULT_GROUPS = ["EXP", "CON"];

const EXCLUSIONS = {
  backgroundAutoplay: (e) =>
    e.wasBackgrounded === 1 && e.relatedTrigger === "autoplay",
  directSearch: (e) => e.referrerType === "direct_search",
};

/**
 * 한 기간의 영상 기록으로 주 분석과 제외 조건별 weightedEntropy를 계산한다. 순수 함수.
 * excludedCount는 제외 조건에 걸린 기록 수(잠깐 본 영상 포함)다.
 */
function computePeriodSensitivity(entries) {
  const main = aggregateViewing(entries);
  const result = {
    validCount: main.validCount,
    weightedEntropy: main.weightedEntropy,
  };
  for (const [name, isExcluded] of Object.entries(EXCLUSIONS)) {
    const kept = entries.filter((e) => !isExcluded(e));
    result[name] = {
      excludedCount: entries.length - kept.length,
      weightedEntropy: aggregateViewing(kept).weightedEntropy,
    };
  }
  return result;
}

/** 오늘(KST) 이전에 끝난 기간. 리뷰 생성과 같은 경계 계산을 쓴다 */
function completedPeriods(installDate, now) {
  return pendingCompletedPeriods({
    installDate,
    existingIndexes: new Set(),
    totalDays: TOTAL_DAYS,
    daysPerPeriod: DAYS_PER_PERIOD,
    baselineDays: BASELINE_DAYS,
    now,
  });
}

/** 참여자의 영상 기록에 카테고리·영상 길이를 붙인다 */
function loadEntries(db, anonymousId) {
  const events = db
    .prepare(
      `SELECT videoId, watchedAt, watchedSeconds, wasBackgrounded, referrerType, relatedTrigger
         FROM video_events WHERE anonymousId = ? ORDER BY watchedAt ASC`,
    )
    .all(anonymousId);
  const videoIds = events.map((e) => e.videoId);
  const categoryIds = getCategoryIdsForVideos(db, videoIds);
  const durations = getDurationsForVideos(db, videoIds);
  return events.map((e, i) => ({
    ...e,
    categoryId: categoryIds[i],
    durationSeconds: durations[i],
  }));
}

/** 참여자 × 완료된 기간 행 목록 */
function run(db, { groups, now = new Date() }) {
  const placeholders = groups.map(() => "?").join(",");
  const participants = db
    .prepare(
      `SELECT anonymousId, group_code AS groupCode, installDate FROM participants
        WHERE group_code IN (${placeholders})`,
    )
    .all(...groups);

  const rows = [];
  for (const p of participants) {
    const entries = loadEntries(db, p.anonymousId);
    for (const period of completedPeriods(p.installDate, now)) {
      const inPeriod = entries.filter((e) => {
        const date = kstDateStr(new Date(e.watchedAt));
        return date >= period.periodStart && date <= period.periodEnd;
      });
      rows.push({
        participant: fingerprint(p.anonymousId),
        groupCode: p.groupCode,
        ...period,
        ...computePeriodSensitivity(inPeriod),
      });
    }
  }

  return {
    generatedAt: now.toISOString(),
    groups,
    totalDays: TOTAL_DAYS,
    daysPerPeriod: DAYS_PER_PERIOD,
    baselineDays: BASELINE_DAYS,
    rows,
  };
}

/** 저장한 파일 경로를 돌려준다. 입력이 잘못되면 exitCode 1로 두고 null */
function main({
  argv = process.argv.slice(2),
  env = process.env,
  outDir = path.join(__dirname, "output"),
} = {}) {
  const args = [...argv];
  // SOURCE_DB_PATH를 쓰면 첫 인자부터 그룹이다
  const dbPath = env.SOURCE_DB_PATH || args.shift();
  const key = env.DB_ENCRYPTION_KEY;
  if (!dbPath || !fs.existsSync(dbPath)) {
    console.error(
      `[h2-sensitivity] DB 경로가 없거나 파일이 없습니다: ${dbPath}`,
    );
    process.exitCode = 1;
    return null;
  }
  if (!key) {
    console.error("[h2-sensitivity] DB_ENCRYPTION_KEY 환경변수가 필요합니다.");
    process.exitCode = 1;
    return null;
  }
  const groups = parseGroupsArg(args, DEFAULT_GROUPS);

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let report;
  try {
    db.pragma("cipher = 'sqlcipher'");
    db.key(Buffer.from(key));
    report = run(db, { groups });
  } finally {
    db.close();
  }

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `h2-referrer-sensitivity-${Date.now()}.json`,
  );
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  const participantCount = new Set(report.rows.map((r) => r.participant)).size;
  console.log(
    `[h2-sensitivity] 참여자 ${participantCount}명, 기간 ${report.rows.length}행 — 저장됨: ${outPath}`,
  );
  return outPath;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("[h2-sensitivity] 스크립트 오류:", err.message);
    process.exitCode = 1;
  }
}

module.exports = {
  EXCLUSIONS,
  computePeriodSensitivity,
  completedPeriods,
  loadEntries,
  run,
  main,
  DEFAULT_GROUPS,
};
