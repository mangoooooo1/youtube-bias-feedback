/**
 * 골드스탠다드 평정 시트를 Google Forms에 붙여넣기 좋은 형태로 재구성 (읽기 전용, DB 접근 없음)
 *
 * export-gold-standard-titles.js가 만든 rating-sheet-*.json(라벨 없음)을 읽어,
 * "섹션 제목 / 설명(제목 목록) / 질문 유형" 형태의 텍스트로 바꾼다.
 * Google Forms API가 없어 자동 생성은 못 하므로, 이 파일 내용을 보면서 수동으로
 * 질문 28개를 만들면 된다(각 섹션 = 질문 하나, 유형은 "선형 배율(Linear scale) 1~5").
 *
 * 사용:
 *   node server/scripts/format-for-google-form.js
 *   (output/ 안의 최신 rating-sheet-*.json을 자동으로 찾는다. 다른 파일을 쓰려면
 *    RATING_SHEET_PATH로 지정)
 */
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "output");

function fail(message) {
  console.error(`[format] ${message}`);
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

function main() {
  const sheetPath = resolveSheetPath();
  console.log(`[format] 원본: ${sheetPath}`);
  const sessions = JSON.parse(fs.readFileSync(sheetPath, "utf8"));
  if (!Array.isArray(sessions) || sessions.length === 0) {
    fail("rating-sheet 파일에 항목이 없습니다.");
  }

  const lines = [];
  lines.push("Google Forms 수동 구성 가이드");
  lines.push("=".repeat(60));
  lines.push("");
  lines.push("폼 맨 앞에 다음 질문을 먼저 추가하세요:");
  lines.push('  질문: "평정자 이름 + 회차(예: 홍길동-1차)"');
  lines.push("  유형: 단답형(Short answer), 필수");
  lines.push("");
  lines.push(
    "그 다음 아래 섹션마다 질문을 하나씩 추가하세요(총 " +
      sessions.length +
      "개).",
  );
  lines.push("각 질문 유형: 선형 배율(Linear scale), 1~5, 필수");
  lines.push(
    "공통 라벨: 1 = 사실상 한 가지 주제만 반복, 5 = 서로 확연히 다른 주제 여러 개",
  );
  lines.push("");
  lines.push("=".repeat(60));
  lines.push("");

  sessions.forEach((s) => {
    lines.push(`[질문 제목] ${s.ratingId}`);
    lines.push("[설명(그대로 복사)]");
    s.titles.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
    lines.push("");
    lines.push(
      "[질문 문구] 이 목록은 얼마나 다양한 주제의 영상으로 이루어져 있나요? (1~5)",
    );
    lines.push("-".repeat(60));
    lines.push("");
  });

  const timestamp = Date.now();
  const outPath = path.join(OUTPUT_DIR, `google-form-content-${timestamp}.txt`);
  fs.writeFileSync(outPath, lines.join("\n"));

  console.log(`[format] 저장됨: ${outPath}`);
  console.log(
    `[format] 총 ${sessions.length}개 질문 + 이름/회차 질문 1개 = ${sessions.length + 1}개 질문을 폼에 만드세요.`,
  );
}

main();
