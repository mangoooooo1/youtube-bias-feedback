/**
 * 1차 파일럿 백업 DB 실태 프로파일링 (읽기 전용)
 *
 * 제목 임베딩 클러스터링 검증 파일 설계에 필요한 실제 데이터 규모를 확인한다.
 * - 원본 백업 파일은 readonly로 연결해 절대 쓰지 않는다.
 * - 개별 제목·세션 원문은 어디에도 저장·출력하지 않고 집계 수치만 남긴다.
 *
 * 사용:
 *   SOURCE_DB_PATH="C:\viewlens-data\backups\first\youtube_bias-20260908-080002.db" \
 *   DB_ENCRYPTION_KEY="..." \
 *   node server/scripts/profile-first-pilot-data.js
 *
 * 또는 첫 번째 인자로 경로 전달:
 *   DB_ENCRYPTION_KEY="..." node server/scripts/profile-first-pilot-data.js "C:\...\youtube_bias-....db"
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");

// cron·수동 실행 어느 쪽이든 server/.env를 명시적으로 불러온다(backup-db.js와 동일 이유).
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const SOURCE_DB_PATH = process.env.SOURCE_DB_PATH || process.argv[2];
const DB_ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY;

// 골드스탠다드 층화 추출 설계용 최소 영상 수 — 이보다 적으면 다양성을 구조적으로 보여줄 수 없다
// (richness가 1~2로 고정됨). 사용자와 논의 후 확정한 값.
const MIN_VIDEO_COUNT_FOR_SAMPLING = 5;

function fail(message) {
  console.error(`[profile] ${message}`);
  process.exit(1);
}

if (!SOURCE_DB_PATH) {
  fail(
    "SOURCE_DB_PATH 환경변수 또는 첫 번째 인자로 백업 DB 경로를 지정하세요.",
  );
}
if (!fs.existsSync(SOURCE_DB_PATH)) {
  fail(`파일 없음: ${SOURCE_DB_PATH}`);
}
if (!DB_ENCRYPTION_KEY) {
  fail("DB_ENCRYPTION_KEY 환경변수가 필요합니다.");
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

/** 숫자 배열 요약 통계: null/undefined/NaN은 집계에서 제외한다. */
function summarize(numbers) {
  const valid = numbers.filter(
    (n) => typeof n === "number" && !Number.isNaN(n),
  );
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const round3 = (x) => Math.round(x * 1000) / 1000;
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: round3(sum / sorted.length),
    median: round3(quantile(sorted, 0.5)),
    p25: round3(quantile(sorted, 0.25)),
    p75: round3(quantile(sorted, 0.75)),
  };
}

/**
 * 한글/영문/기타 문자 비율만 집계한다. 임베딩 모델 후보(다국어 vs 한국어 특화) 판단 근거용.
 * 원문 제목 자체는 이 함수 밖으로 반환하지 않는다.
 */
function scriptMixRatio(titles) {
  let hangul = 0;
  let latin = 0;
  let other = 0;
  let totalChars = 0;
  for (const t of titles) {
    if (!t) continue;
    for (const ch of t) {
      if (/\s/.test(ch)) continue;
      if (/[\uAC00-\uD7A3]/.test(ch)) hangul++;
      else if (/[A-Za-z]/.test(ch)) latin++;
      else other++;
      totalChars++;
    }
  }
  if (totalChars === 0) return null;
  const round3 = (x) => Math.round(x * 1000) / 1000;
  return {
    sampledTitleCount: titles.length,
    hangulRatio: round3(hangul / totalChars),
    latinRatio: round3(latin / totalChars),
    otherRatio: round3(other / totalChars),
  };
}

function main() {
  let db;
  try {
    db = new Database(SOURCE_DB_PATH, { readonly: true, fileMustExist: true });
    db.pragma("cipher = 'sqlcipher'");
    db.key(Buffer.from(DB_ENCRYPTION_KEY));
    // 키가 틀리면 pragma/key 시점이 아니라 실제 쿼리 시점에 실패한다. 여기서 바로 확인한다.
    db.prepare("SELECT COUNT(*) FROM sqlite_master").get();
  } catch (err) {
    fail(
      `DB 열기 실패 (${err.message}). DB_ENCRYPTION_KEY가 이 백업 파일 생성 당시 값과 ` +
        `일치하는지 확인하세요(키가 이후 로테이션됐다면 그 시점 값이 필요합니다).`,
    );
  }

  const report = {
    sourceFile: path.basename(SOURCE_DB_PATH),
    generatedAt: new Date().toISOString(),
  };

  // 유입경로 컬럼 존재 여부. 이전 논의(referrerType/relatedTrigger 소급 가능 여부)와 연결.
  report.videoEventsColumns = db
    .prepare("PRAGMA table_info(video_events)")
    .all()
    .map((c) => c.name);

  report.participantCount = db
    .prepare("SELECT COUNT(DISTINCT anonymousId) AS n FROM participants")
    .get().n;

  report.sessionCount = db
    .prepare("SELECT COUNT(*) AS n FROM sessions")
    .get().n;

  const sessionRows = db
    .prepare("SELECT videoCount, entropy FROM sessions")
    .all();
  report.sessionVideoCount = summarize(sessionRows.map((r) => r.videoCount));
  report.sessionEntropy = summarize(sessionRows.map((r) => r.entropy));

  const eventStats = db
    .prepare(
      `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN title IS NOT NULL THEN 1 ELSE 0 END) AS withTitle,
        COUNT(DISTINCT videoId) AS uniqueVideoIds,
        COUNT(DISTINCT title) AS uniqueTitles
      FROM video_events
      `,
    )
    .get();
  const round3 = (x) => Math.round(x * 1000) / 1000;
  report.videoEvents = {
    total: eventStats.total,
    titleNullRate:
      eventStats.total > 0
        ? round3(1 - eventStats.withTitle / eventStats.total)
        : null,
    uniqueVideoIds: eventStats.uniqueVideoIds,
    uniqueTitles: eventStats.uniqueTitles,
    // 같은 videoId가 여러 행(재시청 포함)으로 기록된 비율
    repeatViewRate:
      eventStats.total > 0
        ? round3(1 - eventStats.uniqueVideoIds / eventStats.total)
        : null,
  };

  const titles = db
    .prepare("SELECT DISTINCT title FROM video_events WHERE title IS NOT NULL")
    .all()
    .map((r) => r.title);
  report.scriptMix = scriptMixRatio(titles);

  // ── 골드스탠다드 층화 추출 설계 (entropy × 카테고리 수 2차원) ──
  // videoCount가 MIN_VIDEO_COUNT_FOR_SAMPLING 미만인 세션은 richness가 구조적으로 낮아
  // 제외한다(사용자와 논의 후 확정). 참여자 원문(제목 등)은 포함하지 않고 anonymousId·
  // groupCode·집계 수치만 다룬다 — anonymousId는 연구 설계상 이미 가명처리된 식별자다.
  const candidateSessions = db
    .prepare(
      `
      SELECT s.sessionId, s.anonymousId, s.videoCount, s.entropy, s.categoryDistribution,
             p.group_code AS groupCode
      FROM sessions s
      LEFT JOIN participants p ON p.anonymousId = s.anonymousId
      WHERE s.videoCount >= ? AND s.entropy IS NOT NULL
      `,
    )
    .all(MIN_VIDEO_COUNT_FOR_SAMPLING);

  function categoryCountOf(distJson) {
    if (!distJson) return 0;
    try {
      return Object.keys(JSON.parse(distJson)).length;
    } catch {
      return 0;
    }
  }

  const enriched = candidateSessions.map((s) => ({
    sessionId: s.sessionId,
    anonymousId: s.anonymousId,
    groupCode: s.groupCode ?? null,
    isTestAccount: typeof s.groupCode === "string" && s.groupCode.startsWith("TEST"),
    videoCount: s.videoCount,
    entropy: s.entropy,
    categoryCount: categoryCountOf(s.categoryDistribution),
  }));

  const sortedEntropies = enriched.map((s) => s.entropy).sort((a, b) => a - b);
  const p33 = quantile(sortedEntropies, 1 / 3);
  const p66 = quantile(sortedEntropies, 2 / 3);

  // 경계값 자체가 null이면(후보 세션 0개) 전부 "low"로 떨어지지만 grid가 어차피 비어 있어 무해하다.
  function entropyBucket(h) {
    if (p33 === null || p66 === null) return "low";
    if (h <= p33) return "low";
    if (h <= p66) return "mid";
    return "high";
  }
  function categoryBucket(c) {
    if (c <= 1) return "1cat";
    if (c <= 3) return "2-3cat";
    return "4+cat";
  }

  const grid = {};
  const categoryCountHistogram = {};
  for (const s of enriched) {
    const gridKey = `${entropyBucket(s.entropy)}_${categoryBucket(s.categoryCount)}`;
    grid[gridKey] = (grid[gridKey] ?? 0) + 1;
    const histKey = String(s.categoryCount);
    categoryCountHistogram[histKey] = (categoryCountHistogram[histKey] ?? 0) + 1;
  }

  const byParticipant = new Map();
  for (const s of enriched) {
    if (!byParticipant.has(s.anonymousId)) {
      byParticipant.set(s.anonymousId, {
        anonymousId: s.anonymousId,
        groupCode: s.groupCode,
        isTestAccount: s.isTestAccount,
        sessionCount: 0,
      });
    }
    byParticipant.get(s.anonymousId).sessionCount += 1;
  }
  const participantBreakdown = [...byParticipant.values()]
    .map((p) => ({
      ...p,
      shareOfFiltered:
        enriched.length > 0 ? round3(p.sessionCount / enriched.length) : null,
    }))
    .sort((a, b) => b.sessionCount - a.sessionCount);

  report.filteredSessions = {
    minVideoCount: MIN_VIDEO_COUNT_FOR_SAMPLING,
    count: enriched.length,
    entropyThresholds: {
      p33: p33 === null ? null : round3(p33),
      p66: p66 === null ? null : round3(p66),
    },
    categoryCountHistogram,
    grid,
    participantBreakdown,
    maxSingleParticipantShare: participantBreakdown[0]?.shareOfFiltered ?? null,
  };

  db.close();

  const outDir = path.join(__dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `profile-first-pilot-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(JSON.stringify(report, null, 2));
  console.log(`\n[profile] 저장됨: ${outPath}`);
}

main();
