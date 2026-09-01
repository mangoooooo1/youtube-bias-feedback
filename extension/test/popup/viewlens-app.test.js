import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isConGroup } from "../../pipeline/study-period.js";
import { isBaselinePeriod, BASELINE_DAYS } from "../../pipeline/baseline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWLENS_APP_PATH = path.join(__dirname, "../../popup/viewlens-app.js");
const VIEWLENS_POPUP_PATH = path.join(
  __dirname,
  "../../popup/viewlens-popup.js",
);
const VIEWLENS_DATA_PATH = path.join(__dirname, "../../popup/viewlens-data.js");

// viewlens-app.js는 DOM(this.container)에 의존하는 classic script라 전체를 그대로
// 실행할 수 없다. 대조군에게 실수로 피드백 화면(screenToday/screenFeedback)이 노출되는지를
// 가르는 실제 결정 로직만(render()가 어떤 화면을 고를지 판정하는 boolean 함수 3개) 정의
// 텍스트 그대로 추출해 격리 실행한다(운영 코드 변경 없음, background.test.js와 동일 기법).
function extract(raw, re, label) {
  const match = raw.match(re);
  if (!match) {
    throw new Error(
      `${label} 선언을 찾지 못했습니다 — 소스 구조가 바뀌었을 수 있습니다.`,
    );
  }
  return match[0];
}

// isTestGroup의 golden 소스는 viewlens-data.js — background.test.js와 동일하게
// classic script를 window 스텁 위에서 그대로 실행해 VL.isTestGroup을 꺼낸다.
function loadIsTestGroupFromViewlensData() {
  const raw = readFileSync(VIEWLENS_DATA_PATH, "utf8");
  const sandbox = { window: undefined };
  sandbox.window = sandbox;
  const evaluate = new Function("window", `${raw}\nreturn window.VL;`);
  return evaluate(sandbox).isTestGroup;
}

// render()가 참조하는 VL.TOTAL_DAYS/isConGroup/isTestGroup/isBaselinePeriod를 흉내 낸
// 스텁 위에서 _isFeedbackActive(클래스 메서드)/_isStudyEndTimeReached/_isStudyEndReviewReady
// (모듈 함수)를 원본 텍스트 그대로 추출해 실행한다.
function loadStudyGates(totalDays = 6) {
  const appRaw = readFileSync(VIEWLENS_APP_PATH, "utf8");
  const popupRaw = readFileSync(VIEWLENS_POPUP_PATH, "utf8");

  const dateStrDecl = extract(
    popupRaw,
    /function dateStr\(d\) \{[\s\S]*?\n\}/,
    "dateStr",
  );
  const dayFromInstallDecl = extract(
    popupRaw,
    /function dayFromInstall\(installDate, offset\) \{[\s\S]*?\n\}/,
    "dayFromInstall",
  );
  const studyEndTimeDecl = extract(
    appRaw,
    /function _isStudyEndTimeReached\(installDate\) \{[\s\S]*?\n\}/,
    "_isStudyEndTimeReached",
  );
  const studyEndReviewReadyDecl = extract(
    appRaw,
    /function _isStudyEndReviewReady\(groupCfg, installDate\) \{[\s\S]*?\n\}/,
    "_isStudyEndReviewReady",
  );
  // 클래스 메서드라 "  _isFeedbackActive(groupCfg) {"로 시작 — 앞부분만 "function "으로
  // 바꿔 독립 함수로 만든다(본문은 원본 그대로, this._installDate는 .call()로 주입).
  const feedbackActiveMethodDecl = extract(
    appRaw,
    /^ {2}_isFeedbackActive\(groupCfg\) \{[\s\S]*?\n {2}\}/m,
    "_isFeedbackActive",
  );
  const feedbackActiveDecl = feedbackActiveMethodDecl.replace(
    /^ {2}_isFeedbackActive/,
    "function _isFeedbackActive",
  );

  const src = `
    ${dateStrDecl}
    ${dayFromInstallDecl}
    ${studyEndTimeDecl}
    ${studyEndReviewReadyDecl}
    ${feedbackActiveDecl}
    return { _isStudyEndTimeReached, _isStudyEndReviewReady, _isFeedbackActive };
  `;
  return new Function("VL", src)({
    TOTAL_DAYS: totalDays,
    isConGroup,
    isTestGroup: loadIsTestGroupFromViewlensData(),
    isBaselinePeriod,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("_isFeedbackActive — 실험군(EXP)에게만, 베이스라인 이후에만 피드백을 켠다", () => {
  let gates;
  beforeAll(() => {
    gates = loadStudyGates();
  });

  function isFeedbackActive(groupCfg, installDate) {
    return gates._isFeedbackActive.call(
      { _installDate: installDate },
      groupCfg,
    );
  }

  it("EXP + 베이스라인 기간(설치 직후)이면 꺼져 있다", () => {
    const installDate = new Date().toISOString();
    expect(isFeedbackActive({ feedback: true, code: "EXP" }, installDate)).toBe(
      false,
    );
  });

  it(`EXP + 베이스라인(${BASELINE_DAYS}일) 이후면 켜진다`, () => {
    const installDate = new Date(
      Date.now() - (BASELINE_DAYS + 1) * 86400000,
    ).toISOString();
    expect(isFeedbackActive({ feedback: true, code: "EXP" }, installDate)).toBe(
      true,
    );
  });

  it("CON(feedback:false)은 베이스라인 이후여도 항상 꺼져 있다", () => {
    const installDate = new Date(
      Date.now() - (BASELINE_DAYS + 10) * 86400000,
    ).toISOString();
    expect(
      isFeedbackActive({ feedback: false, code: "CON" }, installDate),
    ).toBe(false);
  });

  it("TEST-EXP(연구자 모드)는 베이스라인 기간에도 켜진다", () => {
    const installDate = new Date().toISOString();
    expect(
      isFeedbackActive({ feedback: true, code: "TEST-EXP" }, installDate),
    ).toBe(true);
  });

  it("TEST-CON(연구자 모드)은 feedback:false라 베이스라인 예외와 무관하게 꺼져 있다", () => {
    const installDate = new Date().toISOString();
    expect(
      isFeedbackActive({ feedback: false, code: "TEST-CON" }, installDate),
    ).toBe(false);
  });
});

describe("_isStudyEndReviewReady — 대조군(CON)에게만, 연구 종료 후에만 열람을 켠다", () => {
  const TOTAL_DAYS = 6;
  let gates;
  beforeAll(() => {
    gates = loadStudyGates(TOTAL_DAYS);
  });

  it("EXP는 연구가 종료되어도 이 경로로는 절대 켜지지 않는다(isConGroup이 false)", () => {
    const installDate = new Date(
      Date.now() - (TOTAL_DAYS + 5) * 86400000,
    ).toISOString();
    expect(gates._isStudyEndReviewReady({ code: "EXP" }, installDate)).toBe(
      false,
    );
  });

  it("CON은 연구 종료 전에는 꺼져 있다", () => {
    const installDate = new Date().toISOString();
    expect(gates._isStudyEndReviewReady({ code: "CON" }, installDate)).toBe(
      false,
    );
  });

  it("CON은 연구 종료(TOTAL_DAYS 경과 + 09:00 KST) 후에 켜진다", () => {
    const installDate = new Date(
      Date.now() - (TOTAL_DAYS + 5) * 86400000,
    ).toISOString();
    expect(gates._isStudyEndReviewReady({ code: "CON" }, installDate)).toBe(
      true,
    );
  });

  it("TEST-CON도 CON과 동일하게 동작한다", () => {
    const installDate = new Date(
      Date.now() - (TOTAL_DAYS + 5) * 86400000,
    ).toISOString();
    expect(
      gates._isStudyEndReviewReady({ code: "TEST-CON" }, installDate),
    ).toBe(true);
  });

  it("경계값: 종료일 09:00 KST 정각 이전에는 꺼져 있다가, 그 직후 켜진다", () => {
    // installDate를 KST 자정으로 고정 — TOTAL_DAYS일 뒤 09:00 KST가 정확히 판정 경계다.
    const installDate = new Date("2026-01-01T00:00:00+09:00");
    const cutoff = new Date(
      installDate.getTime() + TOTAL_DAYS * 86400000 + 9 * 3600000,
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date(cutoff.getTime() - 1000));
    expect(
      gates._isStudyEndReviewReady({ code: "CON" }, installDate.toISOString()),
    ).toBe(false);

    vi.setSystemTime(cutoff);
    expect(
      gates._isStudyEndReviewReady({ code: "CON" }, installDate.toISOString()),
    ).toBe(true);
  });
});
