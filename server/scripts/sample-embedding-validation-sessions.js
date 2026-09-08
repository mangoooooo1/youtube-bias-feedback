/**
 * 1차 파일럿 골드스탠다드 세션 추출 (읽기 전용)
 *
 * profile-first-pilot-data.js로 확인한 실태(후보 40개, 참여자 1명이 65% 차지)를 바탕으로,
 * 사용자와 합의한 규칙으로 최종 골드스탠다드 세션 목록을 뽑는다.
 *
 * 규칙:
 *   1. videoCount>=MIN_VIDEO_COUNT_FOR_SAMPLING, entropy IS NOT NULL인 세션만 후보로 삼는다
 *      (구조적으로 다양성을 보일 수 없는 소규모 세션 제외).
 *   2. entropy 33/66 백분위수로 낮음/중간/높음, 카테고리 수로 1개/2~3개/4개+를 나눠
 *      2차원 그리드(entropy×카테고리 수)를 만든다.
 *   3. 가장 많은 후보를 가진 참여자(지배적 참여자)의 선택 개수를 나머지 참여자 전체 합계
 *      이하로 제한한다(= 최종 표본의 50%를 넘지 않음). 상한 배정은 세션 수가 적은(희귀한)
 *      그리드 셀부터 먼저 처리해, 그 참여자만 있는 셀이 상한 소진 때문에 통째로 비는 것을
 *      방지한다.
 *   4. 다른 참여자의 후보 세션은 전부 포함한다(표본 자체가 작아 일부러 뺄 이유가 없음).
 *   5. TEST 계정(TEST-EXP/TEST-CON) 세션은 제외하지 않되 isTestAccount로 표시만 한다.
 *   6. 출력에는 세션 ID·참여자 ID(가명)·그리드 셀·videoCount·entropy·categoryCount만 담고
 *      영상 제목 등 원문은 포함하지 않는다.
 *
 * 사용:
 *   SOURCE_DB_PATH="C:\viewlens-data\backups\first\youtube_bias-20260908-080002.db" \
 *   DB_ENCRYPTION_KEY="..." \
 *   node server/scripts/sample-embedding-validation-sessions.js
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const SOURCE_DB_PATH = process.env.SOURCE_DB_PATH || process.argv[2];
const DB_ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY;

// profile-first-pilot-data.js와 반드시 같은 값을 유지해야 한다.
// 어긋나면 그때 확인한 "후보 40개" 전제가 깨진다.
const MIN_VIDEO_COUNT_FOR_SAMPLING = 5;

function fail(message) {
  console.error(`[sample] ${message}`);
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

const round3 = (x) => (x === null ? null : Math.round(x * 1000) / 1000);

function categoryCountOf(distJson) {
  if (!distJson) return 0;
  try {
    return Object.keys(JSON.parse(distJson)).length;
  } catch {
    return 0;
  }
}

function categoryBucket(c) {
  if (c <= 1) return "1cat";
  if (c <= 3) return "2-3cat";
  return "4+cat";
}

// Fisher-Yates: 표본 순서를 무작위화할 목적이며 암호학적 용도가 아니다.
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function main() {
  let db;
  try {
    db = new Database(SOURCE_DB_PATH, { readonly: true, fileMustExist: true });
    db.pragma("cipher = 'sqlcipher'");
    db.key(Buffer.from(DB_ENCRYPTION_KEY));
    db.prepare("SELECT COUNT(*) FROM sqlite_master").get();
  } catch (err) {
    fail(
      `DB 열기 실패 (${err.message}). DB_ENCRYPTION_KEY가 이 백업 파일 생성 당시 값과 ` +
        `일치하는지 확인하세요.`,
    );
  }

  const rows = db
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
  db.close();

  if (rows.length === 0) {
    fail(
      "조건을 만족하는 세션이 없습니다(MIN_VIDEO_COUNT_FOR_SAMPLING 확인 필요).",
    );
  }

  const candidates = rows.map((s) => ({
    sessionId: s.sessionId,
    anonymousId: s.anonymousId,
    groupCode: s.groupCode ?? null,
    isTestAccount:
      typeof s.groupCode === "string" && s.groupCode.startsWith("TEST"),
    videoCount: s.videoCount,
    entropy: s.entropy,
    categoryCount: categoryCountOf(s.categoryDistribution),
  }));

  const sortedEntropies = candidates
    .map((c) => c.entropy)
    .sort((a, b) => a - b);
  const p33 = quantile(sortedEntropies, 1 / 3);
  const p66 = quantile(sortedEntropies, 2 / 3);
  function entropyBucket(h) {
    if (p33 === null || p66 === null) return "low";
    if (h <= p33) return "low";
    if (h <= p66) return "mid";
    return "high";
  }

  const enriched = candidates.map((c) => {
    const eBucket = entropyBucket(c.entropy);
    const cBucket = categoryBucket(c.categoryCount);
    return { ...c, gridKey: `${eBucket}_${cBucket}` };
  });

  // 참여자별 총 후보 수 → 지배적 참여자·상한(= 나머지 전체 합) 결정
  const totalsByParticipant = new Map();
  for (const c of enriched) {
    totalsByParticipant.set(
      c.anonymousId,
      (totalsByParticipant.get(c.anonymousId) ?? 0) + 1,
    );
  }
  const [dominantId, dominantTotal] = [...totalsByParticipant.entries()].sort(
    (a, b) => b[1] - a[1],
  )[0];
  const otherTotal = enriched.length - dominantTotal;
  const cap = otherTotal; // 지배적 참여자 선택 수 <= 나머지 전체 합 → 표본의 50% 이하 보장

  // 그리드 셀을 세션 수가 적은(희귀한) 순으로 정렬. 지배적 참여자만 있는 희귀 셀이
  // 상한 소진 전에 먼저 처리되도록 한다.
  const byCell = new Map();
  for (const c of enriched) {
    if (!byCell.has(c.gridKey)) byCell.set(c.gridKey, []);
    byCell.get(c.gridKey).push(c);
  }
  const cellsAscBySize = [...byCell.entries()].sort(
    (a, b) => a[1].length - b[1].length,
  );

  const selected = [];
  let dominantSelectedCount = 0;
  const droppedDominantByCell = {};

  for (const [gridKey, sessionsInCell] of cellsAscBySize) {
    const others = sessionsInCell.filter((s) => s.anonymousId !== dominantId);
    const dominantShuffled = shuffle(
      sessionsInCell.filter((s) => s.anonymousId === dominantId),
    );

    selected.push(...others);

    let droppedHere = 0;
    for (const s of dominantShuffled) {
      if (dominantSelectedCount < cap) {
        selected.push(s);
        dominantSelectedCount++;
      } else {
        droppedHere++;
      }
    }
    if (droppedHere > 0) droppedDominantByCell[gridKey] = droppedHere;
  }

  const gridCounts = {};
  const participantCounts = {};
  for (const s of selected) {
    gridCounts[s.gridKey] = (gridCounts[s.gridKey] ?? 0) + 1;
    participantCounts[s.anonymousId] =
      (participantCounts[s.anonymousId] ?? 0) + 1;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    rule: {
      minVideoCount: MIN_VIDEO_COUNT_FOR_SAMPLING,
      entropyThresholds: { p33: round3(p33), p66: round3(p66) },
      candidateTotal: enriched.length,
      dominantParticipant: dominantId,
      dominantCandidateTotal: dominantTotal,
      dominantSelectedCap: cap,
      dominantSelectedCount,
      droppedDominantByCell,
    },
    totalSelected: selected.length,
    gridCounts,
    participantCounts,
    sessions: selected.map((s) => ({
      sessionId: s.sessionId,
      anonymousId: s.anonymousId,
      groupCode: s.groupCode,
      isTestAccount: s.isTestAccount,
      videoCount: s.videoCount,
      entropy: s.entropy,
      categoryCount: s.categoryCount,
      gridKey: s.gridKey,
    })),
  };

  const outDir = path.join(__dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `gold-standard-sample-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(
    `[sample] 총 ${output.totalSelected}개 세션 선택 (지배적 참여자 ${dominantSelectedCount}/${cap} 사용, ` +
      `상한으로 제외된 세션 ${Object.values(droppedDominantByCell).reduce((a, b) => a + b, 0)}개)`,
  );
  console.log("[sample] 그리드별 개수:", gridCounts);
  console.log("[sample] 참여자별 개수:", participantCounts);
  console.log(`\n[sample] 저장됨: ${outPath}`);
}

main();
