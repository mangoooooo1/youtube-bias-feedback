const fs = require("fs");
const path = require("path");

// pnpm의 pre/post 스크립트 자동 실행 여부(enable-pre-post-scripts)에 기대지 않도록
// test/test:watch 스크립트에서 직접 호출한다 — 새로 클론한 환경에는 gitignore된
// extension/config.js가 없어, 이 파일이 없으면 llm.js/youtube.js의 import부터 깨진다.
const configPath = path.join(__dirname, "..", "extension", "config.js");
const examplePath = path.join(__dirname, "..", "extension", "config.example.js");

if (!fs.existsSync(configPath)) {
  fs.copyFileSync(examplePath, configPath);
}
