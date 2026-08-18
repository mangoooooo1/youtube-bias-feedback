import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isStudyEnded as isStudyEndedShared } from "../../pipeline/study-period.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWLENS_DATA_PATH = path.join(__dirname, "../../popup/viewlens-data.js");

// viewlens-data.js는 classic script(window.VL = {...})라 그냥 import할 수 없다.
// window 스텁 위에서 실제 파일 소스를 그대로 평가(eval)해 VL을 꺼낸다.
// 로직을 다시 옮겨 적으면 실제ㅡ팝업이 로드하는 코드와 몰래 달라질 수 있어, 소스 자체를 실행해서 검증한다.
// totalDaysOverride는 본조사 전환(6→42) 시나리오를 재현하기 위해 파일의 `const TOTAL_DAYS = N;` 선언만 문자열 치환한다.
const TOTAL_DAYS_DECL = /const TOTAL_DAYS = \d+;/;

function loadVL(totalDaysOverride) {
  const raw = readFileSync(VIEWLENS_DATA_PATH, "utf8");
  if (totalDaysOverride != null && !TOTAL_DAYS_DECL.test(raw)) {
    throw new Error(
      "TOTAL_DAYS 상수 선언을 찾지 못했습니다 — viewlens-data.js 구조가 바뀌었을 수 있습니다.",
    );
  }
  const src =
    totalDaysOverride == null
      ? raw
      : raw.replace(
          TOTAL_DAYS_DECL,
          `const TOTAL_DAYS = ${totalDaysOverride};`,
        );
  const sandbox = {};
  sandbox.window = sandbox;
  const evaluate = new Function("window", `${src}\nreturn window.VL;`);
  return evaluate(sandbox);
}

// TOTAL_DAYS=6은 지금 실제 운영 중인 파일럿 값, 42는 본조사 전환 후 예상 값
describe.each([6, 42])(
  "VL.isStudyEnded — TOTAL_DAYS=%i일 때 study-period.js와 동치성",
  (totalDays) => {
    let VL;

    beforeAll(() => {
      VL = loadVL(totalDays);
    });

    it("정확히 TOTAL_DAYS 전/당일/후 경계에서 공유 구현과 동일한 결과를 낸다", () => {
      const install = new Date("2026-01-01T00:00:00Z");
      for (const offsetDays of [-1, 0, 1]) {
        const now = new Date(
          install.getTime() + (totalDays + offsetDays) * 86400000,
        );
        expect(VL.isStudyEnded(install.toISOString(), now)).toBe(
          isStudyEndedShared(install.toISOString(), totalDays, now),
        );
      }
    });

    it("installDate가 없으면 종료되지 않은 것으로 취급한다", () => {
      expect(VL.isStudyEnded(null)).toBe(false);
    });
  },
);
