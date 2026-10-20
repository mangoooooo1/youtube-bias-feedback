import { defineConfig, coverageConfigDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["extension/test/**/*.test.js", "server/test/**/*.test.js"],
    // 서버 CJS를 import(vite 변환)와 require(Node)로 섞어 불러오면 커버리지 병합이 깨져 Node 경로로 통일한다.
    // 한계: Node 경로는 일부 파일(dogstatsd, llm-metrics)에서 줄·분기 매핑이 몇 줄 밀린다.
    server: { deps: { external: [/[\\/]server[\\/](?!test[\\/])/] } },
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
        // 배포 zip에서 빠지는 개발용 디자인 도구(release-extension.yml의 --exclude "studio/*")
        "extension/studio/**",
        // 연구자가 필요할 때 수동으로 한 번씩 돌리는 임베딩 검증·평정 분석 스크립트
        // 프로덕션 파이프라인(cron)에서 호출되지 않아 자동 테스트 대상이 아니다.
        "server/scripts/analyze-human-ratings.js",
        "server/scripts/average-embedding-seeds.js",
        "server/scripts/compare-cluster-stability.js",
        "server/scripts/compare-diversity-metrics.js",
        "server/scripts/compute-embedding-cluster-diversity.js",
        "server/scripts/compute-referrer-composition-trend.js",
        "server/scripts/compute-feedback-engagement-correlation.js",
        "server/scripts/select-interview-candidates.js",
        "server/scripts/export-gold-standard-titles.js",
        "server/scripts/format-for-google-form.js",
        "server/scripts/profile-first-pilot-data.js",
        "server/scripts/sample-embedding-validation-sessions.js",
      ],
      reporter: ["text", "json-summary", "html"],
      // 실측치보다 2%p 낮게(소수점 버림) 잡은 회귀 방지용 바닥선. 전역은 2026-10-19 실측(88.67/86.92/89.23/89.35) 기준.
      // 로컬·CI 수치는 .gitattributes(eol=lf) 적용 후 같다. 폴더·파일별 값은 그 범위 파일들을 합친 수치로 검사한다.
      // "이 정도는 유지하자"는 최소선이지 목표치가 아니다. 값을 낮추는 수정은 지양.
      thresholds: {
        statements: 86,
        branches: 84,
        functions: 87,
        lines: 87,
        "server/routes/**": {
          statements: 91,
          branches: 89,
          functions: 96,
          lines: 91,
        },
        "server/pipeline/**": {
          statements: 94,
          branches: 91,
          functions: 96,
          lines: 96,
        },
        // server 바로 아래 파일 — app.js는 자식 프로세스로 기동만 검증해 0%로 잡힌다. 2026-10-20 실측 83.64/80.85/84.21/82.69
        "server/*.js": {
          statements: 81,
          branches: 78,
          functions: 82,
          lines: 80,
        },
        // 운영 CLI — main()·인자 처리는 로컬 실행으로 확인한다. 2026-10-20 실측 81.25/84.12/91.07/80.06
        "server/scripts/**": {
          statements: 79,
          branches: 82,
          functions: 89,
          lines: 78,
        },
        "extension/popup/**": {
          statements: 84,
          branches: 79,
          functions: 79,
          lines: 86,
        },
        "extension/content.js": {
          statements: 92,
          branches: 85,
          functions: 92,
          lines: 95,
        },
      },
    },
  },
});
