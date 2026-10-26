#!/usr/bin/env node
/**
 * 측정 정의 기준 H2 민감도 분석
 *
 * 참여자 × 완료된 기간마다 weightedEntropy를 측정 정의만 바꿔 다시 계산한다.
 * - 주 분석: 시청 시간을 영상 길이로 자르고, 유효 시청 상대 기준 25%
 * - noWatchCap: 시청 시간 상한 없이. 방치·잠자기 등으로 부푼 시청 시간을 자르는 처리가 결론을 바꾸는지 본다
 * - relativeCutoff10 / relativeCutoff50: 유효 시청 상대 기준을 10%·50%로. 절대 기준 30초는 그대로다
 * 유효 시청 기준이 바뀌면 유효 영상 수도 달라지므로 조건마다 validCount를 함께 남긴다.
 * 기간·영상 기록·출력 형식은 유입 경로 기준 민감도 분석(compute-h2-referrer-sensitivity.js)과 같다.
 *
 * 참여자는 지문으로만 출력한다. DB는 읽기 전용으로 연다.
 *
 * 사용:
 *   node server/scripts/compute-h2-measurement-sensitivity.js <DB 경로> [그룹...]
 *   (DB 경로는 SOURCE_DB_PATH로도 지정 가능, 그룹 기본값 EXP CON)
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { parseGroupsArg } = require("./check-referrer-trigger-quality");
const {
  buildPeriodReport,
  DEFAULT_GROUPS,
} = require("./compute-h2-referrer-sensitivity");
const { aggregateViewing } = require("../pipeline/viewing-aggregate");

// aggregateViewing에 넘기는 측정 정의. 넘기지 않은 값은 주 분석 정의 그대로다
const VARIANTS = {
  noWatchCap: { capWatchSeconds: false },
  relativeCutoff10: { minRelativeRatio: 0.1 },
  relativeCutoff50: { minRelativeRatio: 0.5 },
};

/** 한 기간의 영상 기록으로 주 분석과 측정 정의별 weightedEntropy를 계산한다. 순수 함수. */
function computePeriodMeasurementSensitivity(entries) {
  const main = aggregateViewing(entries);
  const result = {
    validCount: main.validCount,
    weightedEntropy: main.weightedEntropy,
  };
  for (const [name, options] of Object.entries(VARIANTS)) {
    const variant = aggregateViewing(entries, options);
    result[name] = {
      validCount: variant.validCount,
      weightedEntropy: variant.weightedEntropy,
    };
  }
  return result;
}

function run(db, options) {
  return buildPeriodReport(db, options, computePeriodMeasurementSensitivity);
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
      `[h2-measurement] DB 경로가 없거나 파일이 없습니다: ${dbPath}`,
    );
    process.exitCode = 1;
    return null;
  }
  if (!key) {
    console.error("[h2-measurement] DB_ENCRYPTION_KEY 환경변수가 필요합니다.");
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
    `h2-measurement-sensitivity-${Date.now()}.json`,
  );
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  const participantCount = new Set(report.rows.map((r) => r.participant)).size;
  console.log(
    `[h2-measurement] 참여자 ${participantCount}명, 기간 ${report.rows.length}행 — 저장됨: ${outPath}`,
  );
  return outPath;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("[h2-measurement] 스크립트 오류:", err.message);
    process.exitCode = 1;
  }
}

module.exports = {
  VARIANTS,
  computePeriodMeasurementSensitivity,
  run,
  main,
};
