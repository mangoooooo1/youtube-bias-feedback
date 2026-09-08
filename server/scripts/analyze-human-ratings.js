/**
 * Google Form 응답 분석: 평정자 간 일치도 + 계산된 지표와의 상관
 *
 * Google Sheets에서 "파일 > 다운로드 > CSV" 로 내보낸 응답 파일을 읽는다. 컬럼 구성은
 * (타임스탬프, 이름+회차 질문, S01, S02, ..., S28) 형태를 가정한다(format-for-google-form.js
 * 안내대로 질문 제목을 S01~S28로 설정했다면 헤더가 그대로 이 이름이 된다).
 *
 * - SELF_NAME으로 지정한 문자열이 "이름+회차" 칸에 포함된 행은 본인 응답으로 분리한다.
 *   본인 응답은 검사-재검사(test-retest)용이지, 외부 평정자 풀에 섞지 않는다.
 * - 외부 평정자끼리는 세션(S01~S28)별 점수의 평정자 간 일치도(쌍별 Spearman 상관의 평균)를 계산한다.
 * - 외부 평정자 평균 점수를 rating-key-*.json(entropy/gridKey)과
 *   embedding-cluster-diversity-averaged-*.json(clusterEntropy)에 매칭해 상관을 계산한다
 *   — 검증방법론 문서 4.2절의 준거타당도 확인 단계.
 *
 * 사용:
 *   CSV_PATH="C:\...\설문지 응답 시트1.csv" SELF_NAME="박혜린" node server/scripts/analyze-human-ratings.js
 *   (SELF_NAME을 생략하면 전부 외부 평정자로 취급하고 경고를 남긴다)
 */
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "output");
const CSV_PATH = process.env.CSV_PATH;
const SELF_NAME = process.env.SELF_NAME || null;

function fail(message) {
  console.error(`[ratings] ${message}`);
  process.exit(1);
}

if (!CSV_PATH) {
  fail(
    "CSV_PATH 환경변수로 Google Sheets에서 내보낸 CSV 파일 경로를 지정하세요.",
  );
}
if (!fs.existsSync(CSV_PATH)) {
  fail(`파일 없음: ${CSV_PATH}`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function rank(values) {
  const sorted = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1][0] === sorted[i][0]) j++;
    const avgRank = (i + j) / 2 + 1;
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

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdev(values) {
  const m = mean(values);
  return Math.sqrt(
    values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length,
  );
}

function latestByTrailingTimestamp(prefix, ext = "json") {
  if (!fs.existsSync(OUTPUT_DIR)) return null;
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

function main() {
  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const rows = parseCsv(raw).filter(
    (r) => r.length > 1 || (r.length === 1 && r[0] !== ""),
  );
  if (rows.length < 2) fail("CSV에 헤더 외 데이터 행이 없습니다.");

  const header = rows[0];
  const sessionCols = header
    .map((h, idx) => ({ h: h.trim(), idx }))
    .filter((c) => /^S\d{2}$/.test(c.h));
  if (sessionCols.length === 0) {
    fail(
      "S01~S28 형태의 컬럼을 찾지 못했습니다 — Google Form 질문 제목이 S01~S28로 되어 있는지 확인하세요.",
    );
  }
  // 이름 칸: 타임스탬프(보통 0번)와 S0x 컬럼을 뺀 나머지 중 첫 번째.
  const sessionColSet = new Set(sessionCols.map((c) => c.idx));
  const nameColIdx = header.findIndex(
    (h, idx) => idx !== 0 && !sessionColSet.has(idx),
  );
  if (nameColIdx === -1) {
    console.warn(
      "[ratings] 경고: 이름 칸을 못 찾았습니다 — 전부 이름 없이 처리합니다.",
    );
  }

  const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
  const responses = dataRows.map((r) => {
    const name = nameColIdx >= 0 ? (r[nameColIdx] || "").trim() : "";
    const scores = {};
    for (const { h, idx } of sessionCols) {
      const v = Number((r[idx] || "").trim());
      scores[h] = Number.isFinite(v) ? v : null;
    }
    return { name, scores };
  });

  const selfResponses = SELF_NAME
    ? responses.filter((r) => r.name.includes(SELF_NAME))
    : [];
  const externalResponses = SELF_NAME
    ? responses.filter((r) => !r.name.includes(SELF_NAME))
    : responses;

  if (!SELF_NAME) {
    console.warn(
      "[ratings] 경고: SELF_NAME이 지정되지 않아 모든 응답을 외부 평정자로 취급합니다.",
    );
  }
  console.log(
    `[ratings] 총 응답 ${responses.length}개 (본인 ${selfResponses.length}개, 외부 ${externalResponses.length}개)`,
  );
  for (const r of responses) {
    console.log(
      `  - "${r.name}"${SELF_NAME && r.name.includes(SELF_NAME) ? " [본인]" : ""}`,
    );
  }

  if (externalResponses.length < 2) {
    fail(
      `외부 평정자가 ${externalResponses.length}명뿐입니다 — 평정자 간 일치도 계산에는 최소 2명이 필요합니다.`,
    );
  }

  const ratingIds = sessionCols.map((c) => c.h).sort();

  // 평정자 간 쌍별 Spearman 상관(외부 평정자만)
  const pairwise = [];
  for (let i = 0; i < externalResponses.length; i++) {
    for (let j = i + 1; j < externalResponses.length; j++) {
      const a = ratingIds.map((id) => externalResponses[i].scores[id]);
      const b = ratingIds.map((id) => externalResponses[j].scores[id]);
      if (a.some((v) => v === null) || b.some((v) => v === null)) continue;
      const rho = spearman(a, b);
      pairwise.push({
        raterA: externalResponses[i].name,
        raterB: externalResponses[j].name,
        rho,
      });
    }
  }
  const meanPairwiseRho =
    pairwise.length > 0 ? mean(pairwise.map((p) => p.rho)) : null;

  // 세션별 외부 평정자 평균/표준편차("합의 인간 점수")
  const consensus = ratingIds.map((id) => {
    const vals = externalResponses
      .map((r) => r.scores[id])
      .filter((v) => v !== null);
    return {
      ratingId: id,
      meanScore: vals.length > 0 ? mean(vals) : null,
      sd: vals.length > 0 ? stdev(vals) : null,
      n: vals.length,
    };
  });

  // rating-key / 임베딩 결과와 매칭해 준거타당도 확인
  const ratingKeyPath = latestByTrailingTimestamp("rating-key-");
  const embeddingPath = latestByTrailingTimestamp(
    "embedding-cluster-diversity-",
  );
  let criterionResult = null;
  if (ratingKeyPath && embeddingPath) {
    const ratingKey = JSON.parse(fs.readFileSync(ratingKeyPath, "utf8"));
    const embedding = JSON.parse(fs.readFileSync(embeddingPath, "utf8"));
    const keyByRatingId = new Map(ratingKey.map((k) => [k.ratingId, k]));
    const clusterByRatingId = new Map(
      embedding.sessions.map((s) => [s.ratingId, s]),
    );

    const triples = consensus
      .filter((c) => c.meanScore !== null)
      .map((c) => ({
        ratingId: c.ratingId,
        humanScore: c.meanScore,
        categoryEntropy: keyByRatingId.get(c.ratingId)?.entropy ?? null,
        clusterEntropy:
          clusterByRatingId.get(c.ratingId)?.clusterEntropy ?? null,
      }))
      .filter((t) => t.categoryEntropy !== null && t.clusterEntropy !== null);

    if (triples.length >= 3) {
      criterionResult = {
        n: triples.length,
        rhoHumanVsCategoryEntropy: spearman(
          triples.map((t) => t.humanScore),
          triples.map((t) => t.categoryEntropy),
        ),
        rhoHumanVsClusterEntropy: spearman(
          triples.map((t) => t.humanScore),
          triples.map((t) => t.clusterEntropy),
        ),
        triples,
      };
    }
  } else {
    console.warn(
      "[ratings] rating-key 또는 embedding-cluster-diversity 파일을 못 찾아 준거타당도 비교는 건너뜁니다.",
    );
  }

  console.log(
    `\n[ratings] 외부 평정자 쌍별 Spearman 상관 (${pairwise.length}쌍):`,
  );
  for (const p of pairwise) {
    console.log(`  ${p.raterA} vs ${p.raterB}: ρ=${p.rho?.toFixed(3)}`);
  }
  console.log(`[ratings] 평균 쌍별 상관 = ${meanPairwiseRho?.toFixed(3)}`);

  if (criterionResult) {
    console.log(
      `\n[ratings] 사람 평정(외부 평균) vs 카테고리 엔트로피: ρ=${criterionResult.rhoHumanVsCategoryEntropy?.toFixed(3)} (n=${criterionResult.n})`,
    );
    console.log(
      `[ratings] 사람 평정(외부 평균) vs 클러스터 엔트로피: ρ=${criterionResult.rhoHumanVsClusterEntropy?.toFixed(3)} (n=${criterionResult.n})`,
    );
  }

  if (selfResponses.length > 0) {
    console.log(
      `\n[ratings] 본인 응답 ${selfResponses.length}개는 검사-재검사용으로 별도 보관됩니다` +
        "(2차 회차가 모이면 비교). 외부 평정자 계산에는 포함하지 않았습니다.",
    );
  }

  const outPath = path.join(
    OUTPUT_DIR,
    `human-rating-analysis-${Date.now()}.json`,
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        csvPath: CSV_PATH,
        externalRaterCount: externalResponses.length,
        selfResponses,
        pairwise,
        meanPairwiseRho,
        consensus,
        criterionResult,
      },
      null,
      2,
    ),
  );
  console.log(`\n[ratings] 저장됨: ${outPath}`);
}

main();
