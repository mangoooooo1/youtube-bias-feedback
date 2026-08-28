import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKGROUND_PATH = path.join(__dirname, "../background.js");
const VIEWLENS_DATA_PATH = path.join(__dirname, "../popup/viewlens-data.js");

// background.js는 모듈 최상단에서 chrome.alarms.create 등 부작용을 즉시 실행하므로 그대로 import하면 chrome API 전체를 모킹해야 한다.
// isTestGroup은 export되지 않은 비공개 함수라, 정의 텍스트만 추출해 격리 실행한다.
const IS_TEST_GROUP_DECL = /function isTestGroup\(group\) \{[\s\S]*?\n\}/;

function loadIsTestGroupFromBackground() {
  const raw = readFileSync(BACKGROUND_PATH, "utf8");
  const match = raw.match(IS_TEST_GROUP_DECL);
  if (!match) {
    throw new Error(
      "isTestGroup 함수를 찾지 못했습니다 — background.js 구조가 바뀌었을 수 있습니다.",
    );
  }
  return new Function(`${match[0]}\nreturn isTestGroup;`)();
}

// viewlens-data.js는 classic script(window.VL = {...})라 그대로 import할 수 없어
// 소스를 sandbox 위에서 실행해 VL을 꺼낸다(viewlens-data.test.js의 loadVL과 동일 기법).
function loadIsTestGroupFromViewlensData() {
  const raw = readFileSync(VIEWLENS_DATA_PATH, "utf8");
  const sandbox = { window: undefined };
  sandbox.window = sandbox;
  const evaluate = new Function("window", `${raw}\nreturn window.VL;`);
  return evaluate(sandbox).isTestGroup;
}

// isTestGroup은 background.js와 viewlens-data.js에 각각 독립적으로 정의되어 있고,
// 어느 쪽도 "이게 golden"이라 할 근거 소스가 없다 — 두 사본이 실제로 같은 값을
// 내는지 자체를 대조해 고정한다.
describe("background.js isTestGroup ↔ viewlens-data.js VL.isTestGroup 동치성", () => {
  let backgroundIsTestGroup;
  let viewlensDataIsTestGroup;

  beforeAll(() => {
    backgroundIsTestGroup = loadIsTestGroupFromBackground();
    viewlensDataIsTestGroup = loadIsTestGroupFromViewlensData();
  });

  it.each([
    "EXP",
    "CON",
    "TEST-EXP",
    "TEST-CON",
    "TESTING", // "TEST"로 시작하지만 실제 그룹 코드는 아님 — 접두사만 보는 로직의 경계
    " TEST-EXP", // 앞에 공백이 붙으면 startsWith("TEST")가 깨지는 케이스
    "",
    undefined,
    null,
    123,
  ])("%p에 대해 두 구현이 동일한 결과를 낸다", (group) => {
    expect(backgroundIsTestGroup(group)).toBe(viewlensDataIsTestGroup(group));
  });
});
