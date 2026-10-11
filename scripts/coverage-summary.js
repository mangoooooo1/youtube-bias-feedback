const fs = require("fs");
const path = require("path");

// CI에서 coverage-summary.json을 마크다운 표로 바꿔 $GITHUB_STEP_SUMMARY에 남긴다.
// 사용: node scripts/coverage-summary.js [coverage-summary.json 경로]
const ROOT = path.join(__dirname, "..");
const summaryPath =
  process.argv[2] || path.join(ROOT, "coverage", "coverage-summary.json");

// 소스 텍스트를 추출해 new Function으로 실행하는 테스트라 테스트가 있어도 0%로 집계되는 파일
const EXTRACTION_TESTED = [/^extension\/content\.js$/, /^extension\/popup\//];
const METRICS = ["statements", "branches", "functions", "lines"];

if (!fs.existsSync(summaryPath)) {
  // 테스트가 중간에 멈춰 리포트가 없어도 이 단계 때문에 CI가 실패하지 않게 한다
  console.log(`커버리지 요약 파일이 없습니다: ${summaryPath}`);
  process.exit(0);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

const measurable = Object.fromEntries(
  METRICS.map((m) => [m, { covered: 0, total: 0 }]),
);
for (const [file, data] of Object.entries(summary)) {
  if (file === "total") continue;
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  if (EXTRACTION_TESTED.some((re) => re.test(rel))) continue;
  for (const m of METRICS) {
    measurable[m].covered += data[m].covered;
    measurable[m].total += data[m].total;
  }
}

// vitest(istanbul) 출력·최소선 판정과 같게 소수 둘째 자리 아래는 버린다
const pct = ({ covered, total }) =>
  total ? `${(Math.floor((covered / total) * 10000) / 100).toFixed(2)}%` : "-";
const row = (label, data) =>
  `| ${label} | ${METRICS.map((m) => pct(data[m])).join(" | ")} |`;

console.log(
  [
    "## 커버리지",
    "",
    "| 범위 | Statements | Branches | Functions | Lines |",
    "|---|---:|---:|---:|---:|",
    row("전체", summary.total),
    row("측정 가능 범위", measurable),
    "",
    "측정 가능 범위: `extension/content.js`, `extension/popup/**` 제외(소스 추출 방식 테스트라 0%로 집계됨)",
  ].join("\n"),
);
