/**
 * 여러 시드로 실행한 임베딩 클러스터링 결과를 세션별로 평균 내어, 한 번의 운(어느 지역
 * 최적해에 도달했는가)에 좌우되지 않는 대표값을 만든다.
 *
 * k-means++로도 시드 간 재현성이 크게 개선되지 않음을 실측으로 확인했다(ARI 0.279→0.308).
 * 이는 표본(277개 고유 제목)이 작아 생기는 근본적 한계로 보이며, 알고리즘을 더 붙잡기보다
 * 여러 시드의 clusterEntropy를 평균 내 노이즈를 줄이는 실용적 보완을 택한다.
 *
 * 같은 k로 실행한 결과끼리만 평균 낼 수 있다(k가 다르면 애초에 분할 단위가 달라 비교 대상이
 * 아님). 출력은 기존 embedding-cluster-diversity-*.json과 같은 sessions[] 구조라
 * compare-diversity-metrics.js가 수정 없이 그대로 이 파일을 읽을 수 있다(파일명이 같은
 * 접두사 + 가장 최신 타임스탬프이므로 자동 탐색에도 잡힘).
 *
 * 사용:
 *   K=8 node server/scripts/average-embedding-seeds.js
 *   (output/ 안에서 embedding-cluster-diversity-*-k8-seed*-*.json 전부를 찾아 평균)
 *   또는 특정 파일만 지정:
 *   FILES=path1.json,path2.json,... node server/scripts/average-embedding-seeds.js
 */
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "output");
const K = process.env.K;

function fail(message) {
  console.error(`[average] ${message}`);
  process.exit(1);
}

function resolveFiles() {
  if (process.env.FILES) {
    return process.env.FILES.split(",").map((f) => f.trim());
  }
  if (!K) {
    fail(
      "K 환경변수(평균 낼 클러스터 수) 또는 FILES(콤마로 구분된 파일 경로 목록)를 지정하세요.",
    );
  }
  const re = new RegExp(`^embedding-cluster-diversity-.*-k${K}-seed\\d+-\\d+\\.json$`);
  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => re.test(f))
    .map((f) => path.join(OUTPUT_DIR, f));
  if (files.length === 0) {
    fail(`k=${K}로 실행된 embedding-cluster-diversity-*.json을 찾지 못했습니다.`);
  }
  return files;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function main() {
  const files = resolveFiles();
  if (files.length < 3) {
    console.warn(`[average] 경고: 시드 ${files.length}개로 평균 — 3개 이상을 권장합니다.`);
  }
  console.log(`[average] 평균 낼 파일 ${files.length}개:`);
  for (const f of files) console.log(`  - ${f}`);

  const runs = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));

  const ks = new Set(runs.map((r) => r.k));
  if (ks.size > 1) {
    fail(`서로 다른 k가 섞여 있습니다: ${[...ks].join(", ")} — 같은 k끼리만 평균 낼 수 있습니다.`);
  }
  const models = new Set(runs.map((r) => r.model));
  if (models.size > 1) {
    console.warn(`[average] 경고: 서로 다른 모델이 섞여 있습니다: ${[...models].join(", ")}`);
  }

  const byRatingId = new Map();
  for (const run of runs) {
    for (const s of run.sessions) {
      if (!byRatingId.has(s.ratingId)) byRatingId.set(s.ratingId, []);
      byRatingId.get(s.ratingId).push(s);
    }
  }

  const sessions = [...byRatingId.entries()].map(([ratingId, list]) => {
    const entropies = list.map((s) => s.clusterEntropy);
    const meanEntropy = entropies.reduce((a, b) => a + b, 0) / list.length;
    const meanRichness =
      list.reduce((a, b) => a + b.clusterRichness, 0) / list.length;
    const sd = Math.sqrt(
      entropies.reduce((a, b) => a + (b - meanEntropy) ** 2, 0) / entropies.length,
    );
    return {
      ratingId,
      videoCount: list[0].videoCount,
      runCount: list.length,
      clusterEntropy: round3(meanEntropy),
      clusterEntropySd: round3(sd),
      clusterRichness: round3(meanRichness),
    };
  });

  const output = {
    generatedAt: new Date().toISOString(),
    model: [...models][0],
    k: [...ks][0],
    averagedOverSeeds: runs.map((r) => r.seed),
    sessions,
  };

  const outPath = path.join(
    OUTPUT_DIR,
    `embedding-cluster-diversity-averaged-k${output.k}-${Date.now()}.json`,
  );
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log("\n[average] 세션별 평균 clusterEntropy(표준편차, n=시드 수):");
  for (const s of [...sessions].sort((a, b) => a.ratingId.localeCompare(b.ratingId))) {
    console.log(
      `  ${s.ratingId}: mean=${s.clusterEntropy} (sd=${s.clusterEntropySd}, n=${s.runCount})`,
    );
  }
  console.log(`\n[average] 저장됨: ${outPath}`);
}

main();
