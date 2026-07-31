const js = require("@eslint/js");
const globals = require("globals");
const prettier = require("eslint-config-prettier");

// chrome.* 네임스페이스는 extension 전역에서 공유하는 브라우저 API.
// VL은 extension/popup, extension/studio가 <script> 태그로 순차 로드되며
// 공유하는 전역 객체(모듈 시스템이 없어 import 없이 파일 간에 참조된다).
const extensionGlobals = { ...globals.browser, chrome: "readonly" };

module.exports = [
  {
    ignores: [
      "**/node_modules/**",
      "server/youtube_bias.db*",
      "extension/assets/**",
      "*.zip",
    ],
  },
  js.configs.recommended,
  {
    // extension/background.js, extension/storage.js, extension/pipeline/**
    // manifest.json이 background를 "type": "module"로 선언 — import/export 사용
    files: [
      "extension/background.js",
      "extension/storage.js",
      "extension/pipeline/**/*.js",
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: extensionGlobals,
    },
  },
  {
    // extension/content.js — <script src>로 로드되는 단일 클래식 스크립트, 모듈 아님
    files: ["extension/content.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: extensionGlobals,
    },
  },
  {
    // extension/popup/**, extension/studio/** — popup.html/ViewLens.html이 여러 <script>를
    // 번들러 없이 순서대로 로드해 하나의 전역 스코프를 공유한다(각 파일 최상위 함수/클래스
    // 선언이 곧 다른 파일에서 쓰는 전역). no-undef는 파일 단위로만 보기 때문에 이 패턴을
    // 전부 오탐 처리하므로, 이 그룹에서만 no-undef를 끄고 no-unused-vars(죽은 코드 탐지)는
    // 그대로 켜둔다.
    files: ["extension/popup/**/*.js", "extension/studio/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: extensionGlobals,
    },
    rules: {
      "no-undef": "off",
    },
  },
  {
    // server/**, 루트 설정 파일 — Node CommonJS
    files: ["server/**/*.js", "*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: globals.node,
    },
  },
  {
    rules: {
      "no-console": "off",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  prettier,
];
