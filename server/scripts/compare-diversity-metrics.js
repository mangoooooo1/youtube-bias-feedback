/**
 * 임베딩 클러스터 다양성 vs 기존 카테고리 엔트로피. 1차 상관 확인 (DB 접근 없음)
 *
 * compute-embedding-cluster-diversity.js의 결과(clusterEntropy)와
 * export-gold-standard-titles.js가 만든 rating-key-*.json의 기존 entropy를
 * ratingId(S01~S28)로 매칭해 Spearman 순위상관을 계산한다.
 *
 * 사람 평정을 기다리지 않고도 지금 바로 확인할 수 있는 수렴/판별타당도 신호다 —
 * 다만 검증방법론 문서 4절대로 이 결과는 "방향성 확인"이지 확정 근거가 아니다.
 *
 * 사용:
 *   node server/scripts/compare-diversity-metrics.js
 *   EMBEDDING_PATH=... RATING_KEY_PATH=... node server/scripts/compare-diversity-metrics.js
 */
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "output");

function fail(message) {
  console.error(`[compare] ${message}`);
  process.exit(1);
}

function latestByTrailingTimestamp(prefix, ext = "json") {
  if (!fs.existsSync(OUTPUT_DIR)) fail(`${OUTPUT_DIR} 없음.`);
  // 접두사 바로 뒤에 타임스탬프가 오는 경우(rating-key-<숫자>.json)와, 모델명·k·seed
  // 등이 중간에 낀 뒤 타임스탬프가 오는 경우(embedding-cluster-diversity-...-<숫자>.json)
  // 둘 다 잡아야 하므로 숫자 앞에 하이픈이 반드시 있어야 한다고 요구하지 않는다.
  // 중간 부분은 반드시 게으른(lazy) `.*?`로 매칭해야 한다 — 탐욕적 `.*`를 쓰면 뒤에서부터
  // 역추적하다 \d{10,}의 "10개 이상"이라는 최소 조건만 채우는 지점에서 멈춰버려,
  // 실제로는 13자리인 타임스탬프의 앞자리가 잘려나간 값을 캡처하는 문제가 있었다
  // (예: "1788833078109" 대신 "8833078109"만 잡힘. 다른 값이 되어버려 위험함).
  const re = new RegExp(`^${prefix}.*?(\\d{10,})\\.${ext}$`);
  const candidates = fs
    .readdirSync(OUTPUT_DIR)
    .map((f) => {
      const m = re.exec(f);
      return m ? { file: f, ts: Number(m[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts);
  return candidates.length > 0
    ? path.join(OUTPUT_DIR, candidates[0].file)
    : null;
}

function rank(values) {
  const sorted = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1][0] === sorted[i][0]) j++;
    const avgRank = (i + j) / 2 + 1; // 동점은 평균 순위(표준적인 tie correction)
    for (let k = i; k <= j; k++) ranks[sorted[k][1]] = avgRank;
    i = j + 1;
  }
  return ranks;
}

function pearson(x, y) {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? null : num / denom;
}

function spearman(x, y) {
  return pearson(rank(x), rank(y));
}

function main() {
  const embeddingPath =
    process.env.EMBEDDING_PATH ||
    latestByTrailingTimestamp("embedding-cluster-diversity-");
  const ratingKeyPath =
    process.env.RATING_KEY_PATH || latestByTrailingTimestamp("rating-key-");

  if (!embeddingPath)
    fail("embedding-cluster-diversity-*.json을 찾지 못했습니다.");
  if (!ratingKeyPath) fail("rating-key-*.json을 찾지 못했습니다.");

  console.log(`[compare] 임베딩 결과: ${embeddingPath}`);
  console.log(`[compare] 기존 엔트로피 키 파일: ${ratingKeyPath}`);

  const embedding = JSON.parse(fs.readFileSync(embeddingPath, "utf8"));
  const ratingKey = JSON.parse(fs.readFileSync(ratingKeyPath, "utf8"));

  const clusterByRatingId = new Map(
    embedding.sessions.map((s) => [s.ratingId, s]),
  );
  const keyByRatingId = new Map(ratingKey.map((k) => [k.ratingId, k]));

  const paired = [];
  for (const [ratingId, keyRow] of keyByRatingId) {
    const clusterRow = clusterByRatingId.get(ratingId);
    if (!clusterRow) continue;
    if (typeof keyRow.entropy !== "number") continue;
    paired.push({
      ratingId,
      categoryEntropy: keyRow.entropy,
      categoryCount: keyRow.categoryCount,
      clusterEntropy: clusterRow.clusterEntropy,
      clusterRichness: clusterRow.clusterRichness,
      gridKey: keyRow.gridKey,
    });
  }

  if (paired.length < 3) {
    fail(`매칭된 세션이 ${paired.length}개뿐입니다 — 상관 계산에 부족합니다.`);
  }

  const categoryEntropies = paired.map((p) => p.categoryEntropy);
  const clusterEntropies = paired.map((p) => p.clusterEntropy);
  const categoryCounts = paired.map((p) => p.categoryCount);
  const clusterRichnesses = paired.map((p) => p.clusterRichness);

  const rhoEntropy = spearman(categoryEntropies, clusterEntropies);
  const rhoRichness = spearman(categoryCounts, clusterRichnesses);

  console.log(`\n[compare] 매칭된 세션 수: ${paired.length}`);
  console.log(
    `[compare] Spearman ρ(카테고리 엔트로피, 임베딩 클러스터 엔트로피) = ${rhoEntropy?.toFixed(3)}`,
  );
  console.log(
    `[compare] Spearman ρ(카테고리 수, 클러스터 richness)          = ${rhoRichness?.toFixed(3)}`,
  );
  console.log(
    "\n[compare] 참고: 이건 방향성 확인용 1차 신호입니다(로드맵 1.6절) — 표본 28개로 나온",
  );
  console.log(
    "  상관계수를 확정 근거로 쓰지 말고, 표본이 큰 확증적 재검증으로 재확인하세요.",
  );

  console.log("\n[compare] 세션별 상세:");
  for (const p of paired.sort(
    (a, b) => a.categoryEntropy - b.categoryEntropy,
  )) {
    console.log(
      `  ${p.ratingId} (${p.gridKey}): 카테고리 H=${p.categoryEntropy.toFixed(2)}(cat=${p.categoryCount})  ` +
        `클러스터 H=${p.clusterEntropy.toFixed(2)}(cat=${p.clusterRichness})`,
    );
  }

  const outPath = path.join(OUTPUT_DIR, `metric-comparison-${Date.now()}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { rhoEntropy, rhoRichness, pairedCount: paired.length, paired },
      null,
      2,
    ),
  );
  console.log(`\n[compare] 저장됨: ${outPath}`);
}

main();
