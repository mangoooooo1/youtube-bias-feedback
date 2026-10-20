#!/usr/bin/env node
/**
 * 유입 경로 판정 품질 점검
 *
 * 관련영상 유입(referrerType='related') 중 relatedTrigger가 autoplay·click·unknown인 비율과,
 * 전체 영상 중 referrerType이 unknown·NULL인 비율을 센다. 관련영상 유입 중 unknown이
 * 30% 이상이면 판정 로직(video-events-classify.js)을 보정해야 하는 것으로 본다.
 * H2 민감도 분석(compute-h2-referrer-sensitivity.js)이 이 라벨로 영상을 빼므로 그 전제 확인용이다.
 * - NULL(구버전 확장이 신호를 안 보냄)은 분류된 unknown과 따로 센다. 원인이 다르다.
 * - 판정은 전체 합산 기준. 그룹별·참여자별 값은 unknown이 어디에 몰렸는지 보는 참고용이다.
 * - 참여자는 지문으로만 출력한다. DB는 읽기 전용으로 연다.
 *
 * 사용:
 *   node server/scripts/check-referrer-trigger-quality.js <DB 경로> [그룹...]
 *   (DB 경로는 SOURCE_DB_PATH로도 지정 가능, 그룹 기본값 TEST-EXP TEST-CON)
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { fingerprint } = require("./fingerprint");

const KNOWN_GROUPS = ["EXP", "CON", "TEST-EXP", "TEST-CON"];
const DEFAULT_GROUPS = ["TEST-EXP", "TEST-CON"];
// 관련영상 유입 중 unknown 비율이 이 값 이상이면 판정 로직 보정 필요
const RELATED_UNKNOWN_THRESHOLD = 0.3;
const RELATED_TRIGGERS = ["autoplay", "click", "unknown"];

const round3 = (x) => Math.round(x * 1000) / 1000;

/** 개수와 분모로 { count, ratio }. 분모가 0이면 ratio는 null */
function share(count, total) {
  return { count, ratio: total > 0 ? round3(count / total) : null };
}

/**
 * 영상 기록에서 유입 경로·관련영상 트리거 구성을 센다. 순수 함수.
 * @param {{referrerType: string|null, relatedTrigger: string|null}[]} events
 */
function summarizeReferrerTriggers(events) {
  const total = events.length;
  const related = events.filter((e) => e.referrerType === "related");
  const triggerCounts = Object.fromEntries(RELATED_TRIGGERS.map((t) => [t, 0]));
  for (const e of related) {
    // related인데 트리거가 비어 있는 경우는 분류 규칙상 없지만, 생기면 unknown으로 센다
    const key = RELATED_TRIGGERS.includes(e.relatedTrigger)
      ? e.relatedTrigger
      : "unknown";
    triggerCounts[key] += 1;
  }

  return {
    totalEvents: total,
    referrerType: {
      notSent: share(
        events.filter((e) => e.referrerType == null).length,
        total,
      ),
      unknown: share(
        events.filter((e) => e.referrerType === "unknown").length,
        total,
      ),
    },
    related: {
      total: related.length,
      ...Object.fromEntries(
        RELATED_TRIGGERS.map((t) => [
          t,
          share(triggerCounts[t], related.length),
        ]),
      ),
    },
  };
}

/**
 * 관련영상 유입 중 unknown 비율로 보정 필요 여부를 판정한다. 순수 함수.
 * 반올림한 비율이 아니라 개수로 비교한다(29.96%가 30%로 반올림돼 걸리지 않게).
 * 관련영상 유입이 없으면 판정할 수 없어 null.
 */
function judgeTriggerQuality(summary, threshold = RELATED_UNKNOWN_THRESHOLD) {
  const { total, unknown } = summary.related;
  return {
    relatedUnknownRatio: unknown.ratio,
    threshold,
    needsLogicFix: total > 0 ? unknown.count / total >= threshold : null,
  };
}

/** 대상 그룹 참여자의 영상 기록(유입 경로 컬럼만) */
function collectEvents(db, groups) {
  const placeholders = groups.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT v.anonymousId, p.group_code AS groupCode, v.referrerType, v.relatedTrigger
         FROM video_events v
         JOIN participants p ON p.anonymousId = v.anonymousId
        WHERE p.group_code IN (${placeholders})`,
    )
    .all(...groups);
}

/** 전체·그룹별·참여자별 리포트를 조립한다. 판정은 전체 합산 기준. 순수 함수. */
function buildReport(events, { groups, generatedAt }) {
  const overall = summarizeReferrerTriggers(events);

  const byGroup = {};
  for (const g of groups) {
    byGroup[g] = summarizeReferrerTriggers(
      events.filter((e) => e.groupCode === g),
    );
  }

  const byId = new Map();
  for (const e of events) {
    if (!byId.has(e.anonymousId)) {
      byId.set(e.anonymousId, { groupCode: e.groupCode, events: [] });
    }
    byId.get(e.anonymousId).events.push(e);
  }
  const byParticipant = [...byId.entries()].map(([id, p]) => ({
    participant: fingerprint(id),
    groupCode: p.groupCode,
    ...summarizeReferrerTriggers(p.events),
  }));

  return {
    generatedAt,
    groups,
    overall: { ...overall, judgement: judgeTriggerQuality(overall) },
    byGroup,
    byParticipant,
  };
}

/** 그룹 인자를 검사한다. 없으면 기본값, 모르는 그룹이 있으면 오류 */
function parseGroupsArg(args, defaultGroups = DEFAULT_GROUPS) {
  if (args.length === 0) return defaultGroups;
  const unknown = args.filter((g) => !KNOWN_GROUPS.includes(g));
  if (unknown.length > 0) {
    throw new Error(
      `알 수 없는 그룹: ${unknown.join(", ")} (가능: ${KNOWN_GROUPS.join(", ")})`,
    );
  }
  return args;
}

function formatQualitySummary(report) {
  const { related, judgement } = report.overall;
  if (judgement.needsLogicFix === null) {
    return "관련영상 유입 0건 — 판정할 수 없음";
  }
  // 판정과 같은 개수로 비율을 내고 개수도 함께 보인다(반올림된 표시만으로는 경계 근처 판정 근거가 안 보임)
  const unknownCount = related.unknown.count;
  const percent = ((unknownCount / related.total) * 100).toFixed(2);
  const verdict = judgement.needsLogicFix
    ? `기준 ${judgement.threshold * 100}% 이상 — 판정 로직 보정 필요`
    : `기준 ${judgement.threshold * 100}% 미만`;
  return `관련영상 유입 ${related.total}건 중 unknown ${unknownCount}건(${percent}%) — ${verdict}`;
}

function run(db, { groups, now = new Date() }) {
  return buildReport(collectEvents(db, groups), {
    groups,
    generatedAt: now.toISOString(),
  });
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
      `[trigger-quality] DB 경로가 없거나 파일이 없습니다: ${dbPath}`,
    );
    process.exitCode = 1;
    return null;
  }
  if (!key) {
    console.error("[trigger-quality] DB_ENCRYPTION_KEY 환경변수가 필요합니다.");
    process.exitCode = 1;
    return null;
  }
  const groups = parseGroupsArg(args);

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
    `referrer-trigger-quality-${Date.now()}.json`,
  );
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`[trigger-quality] ${formatQualitySummary(report)}`);
  console.log(`[trigger-quality] 저장됨: ${outPath}`);
  return outPath;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("[trigger-quality] 스크립트 오류:", err.message);
    process.exitCode = 1;
  }
}

module.exports = {
  summarizeReferrerTriggers,
  judgeTriggerQuality,
  collectEvents,
  buildReport,
  parseGroupsArg,
  formatQualitySummary,
  run,
  main,
  DEFAULT_GROUPS,
  RELATED_UNKNOWN_THRESHOLD,
};
