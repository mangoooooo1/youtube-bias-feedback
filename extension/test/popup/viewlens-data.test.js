import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isConGroup as isConGroupShared } from "../../pipeline/study-period.js";
import { isBaselinePeriod as isBaselinePeriodShared } from "../../pipeline/baseline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWLENS_DATA_PATH = path.join(__dirname, "../../popup/viewlens-data.js");

// viewlens-data.js는 classic script(window.VL = {...})라 그냥 import할 수 없다.
// window 스텁 위에서 실제 파일 소스를 그대로 평가(eval)해 VL을 꺼낸다.
// 로직을 다시 옮겨 적으면 실제ㅡ팝업이 로드하는 코드와 몰래 달라질 수 있어, 소스 자체를 실행해서 검증한다.
function loadVL() {
  const src = readFileSync(VIEWLENS_DATA_PATH, "utf8");
  const sandbox = {};
  sandbox.window = sandbox;
  const evaluate = new Function("window", `${src}\nreturn window.VL;`);
  return evaluate(sandbox);
}

// viewlens-data.js는 모듈 경계(classic script) 때문에 pipeline/baseline.js의
// isBaselinePeriod를 그대로 import하지 못하고 동일 로직을 다시 정의한다 — 두 사본이
// 갈라져도 아무 테스트도 실패하지 않던 사각지대라, 소스를 실행해 직접 대조한다.
describe("VL.isBaselinePeriod — pipeline/baseline.js와 동치성", () => {
  let VL;

  beforeAll(() => {
    VL = loadVL();
  });

  it("경과일이 BASELINE_DAYS 경계 전/당일/후에서 공유 구현과 동일한 결과를 낸다", () => {
    const install = new Date("2026-01-01T00:00:00Z");
    for (const elapsedDays of [
      0,
      VL.BASELINE_DAYS - 1,
      VL.BASELINE_DAYS,
      VL.BASELINE_DAYS + 7,
    ]) {
      const now = new Date(install.getTime() + elapsedDays * 86400000);
      expect(VL.isBaselinePeriod(install.toISOString(), now)).toBe(
        isBaselinePeriodShared(install.toISOString(), now),
      );
    }
  });

  it("installDate가 없으면 두 구현 모두 베이스라인으로 취급한다", () => {
    expect(VL.isBaselinePeriod(null)).toBe(isBaselinePeriodShared(null));
    expect(VL.isBaselinePeriod(undefined)).toBe(
      isBaselinePeriodShared(undefined),
    );
  });
});

// isConGroup도 isBaselinePeriod와 동일한 이유(모듈 경계)로 viewlens-data.js에
// 중복 정의되어 있다 — pipeline/study-period.js와 동치성을 대조한다.
describe("VL.isConGroup — pipeline/study-period.js와 동치성", () => {
  let VL;

  beforeAll(() => {
    VL = loadVL();
  });

  it.each(["CON", "TEST-CON", "EXP", "TEST-EXP", undefined, null, ""])(
    "%s에 대해 공유 구현과 동일한 결과를 낸다",
    (code) => {
      expect(VL.isConGroup(code)).toBe(isConGroupShared(code));
    },
  );
});
