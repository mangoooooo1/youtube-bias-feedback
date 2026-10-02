#!/usr/bin/env node
/**
 * 참여자 활동 간격 분포
 *
 * participant-silence-report.js의 결측 임계값(DEFAULT_THRESHOLD_DAYS)을 정하는 근거를 만든다.
 * 참여자별로 연속된 두 활동(video_events.watchedAt, sessions.createdAt) 사이의 경과 일수를 모아,
 * "정상 참여자가 얼마나 오래 쉬었다가 돌아오는지"를 본다.
 * - 설치일 → 첫 활동 간격은 포함한다(결측 판정도 활동이 없으면 설치일을 기준으로 삼는다).
 * - 마지막 활동 이후 공백은 넣지 않는다. 돌아왔는지 알 수 없어 중도 이탈과 구분되지 않는다.
 * - 연구 기간(installDate + TOTAL_DAYS) 밖의 활동은 뺀다. 결측 판정이 그 기간에만 돌기 때문이다.
 * - 참여자 식별자는 출력하지 않고 집계 수치만 남긴다.
 *
 * 사용:
 *   DB_ENCRYPTION_KEY="..." node server/scripts/activity-gap-distribution.js <DB 경로>
 *   (SOURCE_DB_PATH 환경변수로도 지정 가능. 1차 파일럿 백업 또는 서버의 server/youtube_bias.db)
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { TEST_CODES } = require("../routes/participant-recovery");
const { TOTAL_DAYS } = require("../pipeline/study-constants");

const DAY_MS = 86400000;
const THRESHOLD_CANDIDATES = [1, 2, 3, 4, 5];

/**
 * 한 참여자의 활동 간격(일)을 시간순으로 돌려준다. 순수 함수.
 * @param {number} installDateMs
 * @param {number[]} activityMs - 순서 무관, 중복 허용
 * @param {number} [totalDays]
 * @returns {number[]}
 */
function computeGaps(installDateMs, activityMs, totalDays = TOTAL_DAYS) {
  const studyEndMs = installDateMs + totalDays * DAY_MS;
  const inStudy = activityMs
    .filter((t) => t >= installDateMs && t < studyEndMs)
    .sort((a, b) => a - b);
  const gaps = [];
  let prev = installDateMs;
  for (const t of inStudy) {
    gaps.push((t - prev) / DAY_MS);
    prev = t;
  }
  return gaps;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/**
 * 참여자별 간격 배열로 분포를 요약한다. 식별자는 받지 않는다.
 * @param {number[][]} gapsPerParticipant
 */
function summarizeGaps(gapsPerParticipant, thresholds = THRESHOLD_CANDIDATES) {
  const all = gapsPerParticipant.flat().sort((a, b) => a - b);
  const active = gapsPerParticipant.filter((g) => g.length > 0);
  const maxPerParticipant = active
    .map((g) => Math.max(...g))
    .sort((a, b) => a - b);

  return {
    participantCount: gapsPerParticipant.length,
    noActivityCount: gapsPerParticipant.length - active.length,
    gapCount: all.length,
    allGaps: {
      p50: round2(quantile(all, 0.5)),
      p90: round2(quantile(all, 0.9)),
      p95: round2(quantile(all, 0.95)),
      max: round2(all.length > 0 ? all[all.length - 1] : null),
    },
    maxGapPerParticipant: maxPerParticipant.map(round2),
    // 임계값 T로 정했을 때, 이 데이터에서 결측으로 잡혔을 간격 수·참여자 수
    byThreshold: thresholds.map((t) => ({
      thresholdDays: t,
      gapsAtOrAbove: all.filter((g) => g >= t).length,
      participantsAtOrAbove: maxPerParticipant.filter((g) => g >= t).length,
    })),
  };
}

/**
 * TEST 그룹을 뺀 참여자별 installDate와 활동 시각(유닉스 초) 목록.
 * 시각 형식이 섞여 있어(오프셋 포함 ISO / datetime('now')) strftime으로 정규화한다
 * (participant-silence-report.js와 같은 이유).
 */
function collectActivity(db) {
  const placeholders = [...TEST_CODES].map(() => "?").join(",");
  const participants = db
    .prepare(
      `SELECT anonymousId, installDate FROM participants
        WHERE group_code NOT IN (${placeholders})`,
    )
    .all(...TEST_CODES);
  const selectTimes = db.prepare(`
    SELECT strftime('%s', watchedAt) AS ts FROM video_events WHERE anonymousId = ?
    UNION ALL
    SELECT strftime('%s', createdAt) AS ts FROM sessions WHERE anonymousId = ?
  `);

  const result = [];
  for (const p of participants) {
    const installDateMs = Date.parse(p.installDate);
    if (!Number.isFinite(installDateMs)) continue;
    const activityMs = selectTimes
      .all(p.anonymousId, p.anonymousId)
      .filter((r) => r.ts != null)
      .map((r) => Number(r.ts) * 1000);
    result.push({ installDateMs, activityMs });
  }
  return result;
}

function run(db) {
  const rows = collectActivity(db);
  return summarizeGaps(
    rows.map((r) => computeGaps(r.installDateMs, r.activityMs)),
  );
}

function printSummary(s) {
  console.log(
    `[activity-gap] 참여자 ${s.participantCount}명(연구 기간 중 활동 없음 ${s.noActivityCount}명), 간격 ${s.gapCount}개`,
  );
  console.log(
    `  전체 간격(일): p50=${s.allGaps.p50} p90=${s.allGaps.p90} p95=${s.allGaps.p95} max=${s.allGaps.max}`,
  );
  console.log(
    `  참여자별 최대 간격(일, 오름차순): ${s.maxGapPerParticipant.join(", ")}`,
  );
  console.log("  임계값 후보별 결측 판정 수:");
  for (const b of s.byThreshold) {
    console.log(
      `    ${b.thresholdDays}일: 간격 ${b.gapsAtOrAbove}개 / 참여자 ${b.participantsAtOrAbove}명`,
    );
  }
}

function main() {
  const dbPath = process.env.SOURCE_DB_PATH || process.argv[2];
  const key = process.env.DB_ENCRYPTION_KEY;
  if (!dbPath || !fs.existsSync(dbPath)) {
    console.error(`[activity-gap] DB 경로가 없거나 파일이 없습니다: ${dbPath}`);
    process.exitCode = 1;
    return;
  }
  if (!key) {
    console.error("[activity-gap] DB_ENCRYPTION_KEY 환경변수가 필요합니다.");
    process.exitCode = 1;
    return;
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("cipher = 'sqlcipher'");
    db.key(Buffer.from(key));
    printSummary(run(db));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("[activity-gap] 스크립트 오류:", err.message);
    process.exitCode = 1;
  }
}

module.exports = { computeGaps, summarizeGaps, collectActivity, run };
