/**
 * 제목 임베딩 → 클러스터링 → 세션별 clusterDistribution/clusterEntropy 계산 (DB 접근 없음)
 *
 * export-gold-standard-titles.js가 만든 rating-sheet-*.json(S01~S28, 라벨 없이 제목만)을
 * 입력으로, 로드맵(Viewlens 제목임베딩 클러스터링 도입 로드맵.md) 1.5절 스펙대로 계산한다.
 *
 *   1. 28개 세션 안의 모든 제목을 한데 모아(고유 텍스트만 캐싱) 전역 임베딩 계산
 *   2. 전역 k-means(코사인 거리)로 클러스터링 — categoryId처럼 "고정된 분류체계" 역할.
 *      이번 1차 파일럿에서는 이 28개 세션의 제목 풀만으로 클러스터링한다(전체 115개
 *      세션 전역 클러스터링은 확증적 재검증 단계에서 다룬다 — 로드맵 Phase 3).
 *   3. 각 세션의 clusterDistribution/clusterEntropy/clusterRichness 계산.
 *      재시청(같은 제목 반복)도 포함해 category-diversity.js의 calculateDistribution/calculateEntropy와
 *      동일한 가중 방식을 쓴다.
 *   4. 시드를 바꿔 재실행했을 때 결과가 얼마나 흔들리는지 비교할 수 있도록, 각 실행의
 *      클러스터 배정(제목 -> clusterId) 원본도 별도 파일로 남긴다(ARI 비교용).
 *
 * 사용:
 *   node server/scripts/compute-embedding-cluster-diversity.js
 *   MODEL=Xenova/multilingual-e5-small K=8 SEED=1 node server/scripts/compute-embedding-cluster-diversity.js
 *   (rating-sheet 파일은 output/ 안의 최신 것을 자동으로 찾는다. RATING_SHEET_PATH로 지정 가능)
 */
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "output");
const MODEL = process.env.MODEL || "Xenova/multilingual-e5-small";
const K = Number(process.env.K || 8);
const SEED = Number(process.env.SEED || 1);
const MAX_ITER = 50;

function fail(message) {
  console.error(`[embed] ${message}`);
  process.exit(1);
}

function resolveSheetPath() {
  if (process.env.RATING_SHEET_PATH) return process.env.RATING_SHEET_PATH;
  if (!fs.existsSync(OUTPUT_DIR)) {
    fail(
      `${OUTPUT_DIR} 없음 — 먼저 export-gold-standard-titles.js를 실행하세요.`,
    );
  }
  // "-corrected" 등 접미사가 붙은 파일도 인식해야 한다. 접미사 유무로 사전순 정렬이
  // 어긋나면 원본 오염 데이터를 다시 고르는 사고가 날 수 있다(실제로 한 번 발생함).
  // 파일명 안의 타임스탬프 숫자를 뽑아 "숫자 기준"으로 가장 최신 것을 고른다.
  const candidates = fs
    .readdirSync(OUTPUT_DIR)
    .map((f) => {
      const m = /^rating-sheet-(\d+).*\.json$/.exec(f);
      return m ? { file: f, ts: Number(m[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts);
  if (candidates.length === 0) {
    fail(
      "rating-sheet-*.json이 없습니다 — 먼저 export-gold-standard-titles.js를 실행하세요.",
    );
  }
  return path.join(OUTPUT_DIR, candidates[0].file);
}

// mulberry32: 시드 고정 가능한 의사난수 생성기. Math.random()은 시드를 못 주므로,
// "시드를 바꿔가며 안정성을 확인한다"는 로드맵 1.5절 요구사항을 위해 직접 구현한다.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function meanVector(vectors) {
  const dim = vectors[0].length;
  const mean = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) mean[i] += v[i];
  }
  for (let i = 0; i < dim; i++) mean[i] /= vectors.length;
  // 코사인 거리로 다시 비교할 수 있도록 평균도 단위벡터로 정규화한다.
  const norm = Math.sqrt(dot(mean, mean)) || 1;
  return mean.map((x) => x / norm);
}

// 재시작 횟수 — scikit-learn 등 실무 구현의 관행값(n_init=10)을 그대로 따른다.
const N_INIT = 10;

/**
 * k-means++ 초기화(코사인 거리 기준). 기존 중심들로부터 먼 점일수록 다음 중심으로 뽑힐
 * 확률이 높아지도록(거리제곱 가중) 해, 단순 무작위 초기화보다 초기값에 따른 결과 편차를
 * 줄인다 — 실측 결과(같은 k, 다른 시드 사이 ARI=0.279)로 단순 무작위 초기화의 불안정성이
 * 확인되어 도입.
 */
function kmeansPlusPlusInit(vectors, k, rng) {
  const n = vectors.length;
  const chosenIdx = [Math.floor(rng() * n)];

  while (chosenIdx.length < k) {
    const sqDist = vectors.map((v, i) => {
      if (chosenIdx.includes(i)) return 0;
      let maxSim = -Infinity;
      for (const ci of chosenIdx) {
        const sim = dot(v, vectors[ci]);
        if (sim > maxSim) maxSim = sim;
      }
      const d = Math.max(0, 1 - maxSim);
      return d * d;
    });
    const total = sqDist.reduce((a, b) => a + b, 0);
    if (total === 0) {
      // 남은 점들이 이미 선택된 중심과 완전히 동일한 극단적 케이스 — 무작위로 채운다.
      let idx;
      do {
        idx = Math.floor(rng() * n);
      } while (chosenIdx.includes(idx));
      chosenIdx.push(idx);
      continue;
    }
    let r = rng() * total;
    let idx = n - 1; // 부동소수점 오차로 루프 끝까지 못 고르는 경우의 안전장치
    for (let i = 0; i < n; i++) {
      r -= sqDist[i];
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    chosenIdx.push(idx);
  }

  return chosenIdx.map((i) => vectors[i]);
}

/** k-means 한 번 실행(Lloyd's algorithm) — 배정과 함께 응집도(inertia)를 반환한다. */
function kmeansSingleRun(vectors, k, rng, maxIter) {
  const n = vectors.length;
  let centroids = kmeansPlusPlusInit(vectors, k, rng);
  let assignments = new Array(n).fill(-1);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = -1;
      let bestSim = -Infinity;
      for (let c = 0; c < k; c++) {
        const sim = dot(vectors[i], centroids[c]); // 정규화된 벡터라 내적 = 코사인 유사도
        if (sim > bestSim) {
          bestSim = sim;
          best = c;
        }
      }
      if (assignments[i] !== best) changed = true;
      assignments[i] = best;
    }
    if (!changed && iter > 0) break;

    const groups = Array.from({ length: k }, () => []);
    for (let i = 0; i < n; i++) groups[assignments[i]].push(vectors[i]);
    centroids = groups.map((g, c) =>
      g.length > 0 ? meanVector(g) : centroids[c],
    );
  }

  // 응집도: 각 점과 배정된 중심 사이 (1 - 코사인 유사도)의 합 — 낮을수록 잘 뭉친 것.
  let inertia = 0;
  for (let i = 0; i < n; i++) {
    inertia += 1 - dot(vectors[i], centroids[assignments[i]]);
  }

  return { assignments, inertia };
}

/**
 * k-means(코사인 유사도 기준, 입력 벡터는 이미 정규화되어 있다고 가정).
 * k-means++ 초기화 + N_INIT회 재시작 후 응집도가 가장 좋은 결과를 채택한다. 단순
 * 무작위 초기화 1회만으로는 시드에 따라 결과가 크게 흔들리는 것이 실측(ARI=0.279)으로
 * 확인되어, scikit-learn 등 실무 표준 방식(k-means++ + 다중 재시작)으로 교체했다.
 * 이렇게 해도 시드가 바뀌면(=재시작들의 초기값 자체가 바뀌면) 최종 결과가 여전히 크게
 * 다르다면, 그건 구현 문제가 아니라 표본이 작아 데이터 자체에 뚜렷한 군집 구조가 없다는
 * 뜻이므로 로드맵 1.6절의 "확증적 재검증은 표본이 큰 데이터로" 계획으로 넘어갈 근거가 된다.
 */
function kmeans(vectors, k, seed, maxIter = MAX_ITER, nInit = N_INIT) {
  const n = vectors.length;
  if (k > n) {
    throw new Error(`k(${k})가 데이터 수(${n})보다 클 수 없습니다.`);
  }
  const rng = mulberry32(seed);

  let best = null;
  for (let attempt = 0; attempt < nInit; attempt++) {
    const result = kmeansSingleRun(vectors, k, rng, maxIter);
    if (!best || result.inertia < best.inertia) best = result;
  }
  return best.assignments;
}

function categoryStyleDistribution(items) {
  const total = items.length;
  if (total === 0) return {};
  const counts = {};
  for (const c of items) counts[c] = (counts[c] ?? 0) + 1;
  const dist = {};
  for (const [c, count] of Object.entries(counts)) {
    dist[c] = Math.round((count / total) * 1000) / 1000;
  }
  return dist;
}

function entropyOf(distribution) {
  const proportions = Object.values(distribution);
  if (proportions.length === 0) return 0;
  const H = -proportions.reduce(
    (sum, p) => (p > 0 ? sum + p * Math.log2(p) : sum),
    0,
  );
  return Math.round(H * 100) / 100 || 0;
}

async function main() {
  let pipeline;
  try {
    ({ pipeline } = require("@huggingface/transformers"));
  } catch (err) {
    fail(
      "'@huggingface/transformers' 패키지가 없습니다. server 디렉터리에서 " +
        "'npm install @huggingface/transformers'를 실행한 뒤 다시 시도하세요.",
    );
  }

  const sheetPath = resolveSheetPath();
  console.log(`[embed] 평정 시트: ${sheetPath}`);
  console.log(`[embed] 모델: ${MODEL}, k: ${K}, seed: ${SEED}`);

  const sessions = JSON.parse(fs.readFileSync(sheetPath, "utf8"));
  if (!Array.isArray(sessions) || sessions.length === 0) {
    fail("rating-sheet 파일에 항목이 없습니다.");
  }

  console.log(
    "[embed] 임베딩 모델 로딩 중(최초 실행 시 다운로드로 시간이 걸릴 수 있습니다)...",
  );
  const embedder = await pipeline("feature-extraction", MODEL);

  // 고유 텍스트만 임베딩(같은 세션 내 재시청·다른 세션 간 동일 영상 중복 계산 방지).
  const uniqueTitles = [...new Set(sessions.flatMap((s) => s.titles))];
  console.log(`[embed] 고유 제목 ${uniqueTitles.length}개 임베딩 중...`);

  const vectorByTitle = new Map();
  for (let i = 0; i < uniqueTitles.length; i++) {
    const title = uniqueTitles[i];
    // e5 계열은 입력에 접두사가 필요하다 — 제목-제목 유사도 비교이므로 양쪽 다 "passage: "로 통일.
    const output = await embedder(`passage: ${title}`, {
      pooling: "mean",
      normalize: true,
    });
    vectorByTitle.set(title, Array.from(output.data));
    if ((i + 1) % 20 === 0 || i === uniqueTitles.length - 1) {
      console.log(`[embed]   ${i + 1}/${uniqueTitles.length}`);
    }
  }

  const vectors = uniqueTitles.map((t) => vectorByTitle.get(t));
  console.log("[embed] 클러스터링 중...");
  const assignments = kmeans(vectors, K, SEED);
  const clusterIdByTitle = new Map(
    uniqueTitles.map((t, i) => [t, assignments[i]]),
  );

  // 클러스터 크기 + 해석용 대표 제목(중심에 가장 가까운 순으로 최대 3개)
  // 내용타당도 점검(word/topic intrusion task 응용, 검증방법론 문서 2절)에 쓴다.
  const clusters = Array.from({ length: K }, (_, clusterId) => {
    const memberIdx = assignments
      .map((c, i) => (c === clusterId ? i : -1))
      .filter((i) => i !== -1);
    const centroid =
      memberIdx.length > 0
        ? meanVector(memberIdx.map((i) => vectors[i]))
        : null;
    const sorted = centroid
      ? [...memberIdx].sort(
          (a, b) => dot(vectors[b], centroid) - dot(vectors[a], centroid),
        )
      : memberIdx;
    return {
      clusterId,
      size: memberIdx.length,
      representativeTitles: sorted.slice(0, 3).map((i) => uniqueTitles[i]),
    };
  });

  const sessionResults = sessions.map((s) => {
    const clusterIds = s.titles.map((t) => clusterIdByTitle.get(t));
    const distribution = categoryStyleDistribution(clusterIds);
    return {
      ratingId: s.ratingId,
      videoCount: s.titles.length,
      clusterDistribution: distribution,
      clusterEntropy: entropyOf(distribution),
      clusterRichness: Object.keys(distribution).length,
    };
  });

  const output = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    k: K,
    seed: SEED,
    uniqueTitleCount: uniqueTitles.length,
    clusters,
    sessions: sessionResults,
    // ARI(재현성) 비교용 원본 — 다른 시드/모델로 재실행한 결과와 이 매핑을 비교한다.
    titleClusterAssignment: Object.fromEntries(clusterIdByTitle),
  };

  const timestamp = Date.now();
  const outPath = path.join(
    OUTPUT_DIR,
    `embedding-cluster-diversity-${MODEL.replace(/[^a-zA-Z0-9]/g, "_")}-k${K}-seed${SEED}-${timestamp}.json`,
  );
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log("\n[embed] 세션별 clusterEntropy:");
  for (const s of sessionResults) {
    console.log(
      `  ${s.ratingId}: videoCount=${s.videoCount}, clusterEntropy=${s.clusterEntropy}, clusterRichness=${s.clusterRichness}`,
    );
  }
  console.log(`\n[embed] 저장됨: ${outPath}`);
}

main().catch((err) => {
  fail(err.stack || err.message);
});
