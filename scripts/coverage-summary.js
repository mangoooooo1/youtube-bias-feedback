const fs = require("fs");
const path = require("path");

// CI에서 coverage-summary.json을 마크다운 표로 바꿔 $GITHUB_STEP_SUMMARY에 남긴다.
// 사용: node scripts/coverage-summary.js [coverage-summary.json 경로]
const ROOT = path.join(__dirname, "..");
const summaryPath =
  process.argv[2] || path.join(ROOT, "coverage", "coverage-summary.json");

const METRICS = ["statements", "branches", "functions", "lines"];

if (!fs.existsSync(summaryPath)) {
  // 테스트가 중간에 멈춰 리포트가 없어도 이 단계 때문에 CI가 실패하지 않게 한다
  console.log(`커버리지 요약 파일이 없습니다: ${summaryPath}`);
  process.exit(0);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

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
  ].join("\n"),
);
