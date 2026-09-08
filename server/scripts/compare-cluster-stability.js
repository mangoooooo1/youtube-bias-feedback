/**
 * 두 번의 클러스터링 실행(다른 모델/k/시드) 사이의 재현성(안정성) 비교. Adjusted Rand Index
 *
 * compute-embedding-cluster-diversity.js를 다른 K/SEED로 두 번 실행하면 각각
 * embedding-cluster-diversity-*.json이 남는다. 그 두 결과의 titleClusterAssignment
 * (제목 -> clusterId)를 ARI(Hubert & Arabie, 1985)로 비교해, 클러스터 번호가 실행마다
 * 뒤바뀌어도(라벨 순서 무관) 실제 묶임이 얼마나 같은지를 정량화한다.
 *
 * 사용:
 *   FILE_A=server/scripts/output/embedding-...-k8-seed1-....json \
 *   FILE_B=server/scripts/output/embedding-...-k8-seed2-....json \
 *   node server/scripts/compare-cluster-stability.js
 */
const fs = require("fs");

function fail(message) {
  console.error(`[stability] ${message}`);
  process.exit(1);
}

const FILE_A = process.env.FILE_A;
const FILE_B = process.env.FILE_B;

if (!FILE_A || !FILE_B) {
  fail(
    "FILE_A, FILE_B 환경변수로 비교할 embedding-cluster-diversity-*.json 두 개의 경로를 지정하세요.",
  );
}
if (!fs.existsSync(FILE_A)) fail(`파일 없음: ${FILE_A}`);
if (!fs.existsSync(FILE_B)) fail(`파일 없음: ${FILE_B}`);

function choose2(n) {
  return (n * (n - 1)) / 2;
}

/** Hubert & Arabie(1985) Adjusted Rand Index. labelsA/labelsB는 같은 순서(같은 항목)의 배열. */
function adjustedRandIndex(labelsA, labelsB) {
  const n = labelsA.length;
  const contingency = new Map();
  const aCounts = new Map();
  const bCounts = new Map();

  for (let i = 0; i < n; i++) {
    const a = labelsA[i];
    const b = labelsB[i];
    const key = `${a}|${b}`;
    contingency.set(key, (contingency.get(key) ?? 0) + 1);
    aCounts.set(a, (aCounts.get(a) ?? 0) + 1);
    bCounts.set(b, (bCounts.get(b) ?? 0) + 1);
  }

  let sumNij = 0;
  for (const v of contingency.values()) sumNij += choose2(v);
  let sumA = 0;
  for (const v of aCounts.values()) sumA += choose2(v);
  let sumB = 0;
  for (const v of bCounts.values()) sumB += choose2(v);

  const totalPairs = choose2(n);
  const expectedIndex = (sumA * sumB) / totalPairs;
  const maxIndex = 0.5 * (sumA + sumB);

  if (maxIndex === expectedIndex) return 1; // 두 클러스터링이 사실상 동일한 퇴화 케이스
  return (sumNij - expectedIndex) / (maxIndex - expectedIndex);
}

function main() {
  const a = JSON.parse(fs.readFileSync(FILE_A, "utf8"));
  const b = JSON.parse(fs.readFileSync(FILE_B, "utf8"));

  const titlesA = Object.keys(a.titleClusterAssignment);
  const titlesB = new Set(Object.keys(b.titleClusterAssignment));
  const sharedTitles = titlesA.filter((t) => titlesB.has(t));

  if (sharedTitles.length === 0) {
    fail(
      "두 파일에 공통된 제목이 없습니다 — 같은 rating-sheet에서 나온 결과인지 확인하세요.",
    );
  }
  if (
    sharedTitles.length < titlesA.length ||
    sharedTitles.length < titlesB.size
  ) {
    console.warn(
      `[stability] 경고: 두 파일의 고유 제목 집합이 완전히 같지 않습니다 ` +
        `(A=${titlesA.length}, B=${titlesB.size}, 공통=${sharedTitles.length}). ` +
        `같은 rating-sheet(같은 min videoCount 필터)에서 나온 결과인지 확인하세요.`,
    );
  }

  const labelsA = sharedTitles.map((t) => a.titleClusterAssignment[t]);
  const labelsB = sharedTitles.map((t) => b.titleClusterAssignment[t]);
  const ari = adjustedRandIndex(labelsA, labelsB);

  console.log(`[stability] A: ${FILE_A}`);
  console.log(`[stability]    model=${a.model}, k=${a.k}, seed=${a.seed}`);
  console.log(`[stability] B: ${FILE_B}`);
  console.log(`[stability]    model=${b.model}, k=${b.k}, seed=${b.seed}`);
  console.log(`[stability] 비교한 고유 제목 수: ${sharedTitles.length}`);
  console.log(`[stability] Adjusted Rand Index = ${ari.toFixed(3)}`);
  console.log(
    "\n[stability] 참고: 1.0에 가까울수록 두 실행의 클러스터 배정이 거의 동일(안정적).",
  );
  console.log(
    "  0에 가까우면 무작위 수준으로 다름 — 이 모델/k 조합은 재현성이 낮다는 뜻이므로 채택을 재검토해야 함.",
  );
}

main();
