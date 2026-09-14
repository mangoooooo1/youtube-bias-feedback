import { defineConfig, coverageConfigDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["extension/test/**/*.test.js", "server/test/**/*.test.js"],
    coverage: {
      provider: "v8",
      all: true,
      include: ["extension/**/*.js", "server/**/*.js"],
      exclude: [
        ...coverageConfigDefaults.exclude,
        "extension/test/**",
        "server/test/**",
        "extension/config.js",
        "extension/config.example.js",
        // 연구자가 필요할 때 수동으로 한 번씩 돌리는 임베딩 검증·평정 분석 스크립트
        // 프로덕션 파이프라인(cron)에서 호출되지 않아 자동 테스트 대상이 아니다.
        "server/scripts/analyze-human-ratings.js",
        "server/scripts/average-embedding-seeds.js",
        "server/scripts/compare-cluster-stability.js",
        "server/scripts/compare-diversity-metrics.js",
        "server/scripts/compute-embedding-cluster-diversity.js",
        "server/scripts/export-gold-standard-titles.js",
        "server/scripts/format-for-google-form.js",
        "server/scripts/profile-first-pilot-data.js",
        "server/scripts/sample-embedding-validation-sessions.js",
      ],
      reporter: ["text", "json-summary", "html"],
      // 현재 실측치(2026-09, statements 40.21%)보다 낮게 잡은 회귀 방지용 바닥선.
      // "이 정도는 유지하자"는 최소선이지 목표치가 아니다 — 값을 낮추는 수정은 지양.
      thresholds: {
        statements: 38,
        branches: 34,
        functions: 35,
        lines: 38,
      },
    },
  },
});
