// @vitest-environment jsdom
/* global document */
import { describe, it, expect, afterEach, vi } from "vitest";
import { loadPopup } from "./load-popup.js";

// 실제 팝업 파일을 불러와 ViewLensPopup을 진짜 DOM(jsdom)에 그리고, 집단·시점별로 어떤 화면이
// 보이는지 확인한다. 대조군에게 피드백 화면이 보이면 연구 설계가 무너진다.
// 시점은 실제 설정(VL.BASELINE_DAYS, VL.TOTAL_DAYS)으로 계산해 연구 기간이 바뀌어도 의미가 유지된다.
const DAY = 86400000;

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

// daysSinceInstall(VL) → 설치 후 경과일. VL._installDate(경과일 계산)와 mount의 installDate(게이트 판정)에
// 같은 값을 넣는다(boot와 같다).
async function mountPopup({
  group,
  daysSinceInstall,
  noticeShown = true,
  codeVerified = false,
}) {
  const g = await loadPopup({ realDom: true });
  const { VL } = g;
  const installDate = new Date(
    Date.now() - daysSinceInstall(VL) * DAY,
  ).toISOString();
  VL._installDate = installDate;
  VL._studyEndNoticeShown = noticeShown;
  VL._studyEndCodeVerified = codeVerified;
  const container = document.createElement("div");
  document.body.appendChild(container);
  new g.ViewLensPopup(container).mount({
    onboarded: true,
    group,
    timelineKey: "w1_mid",
    installDate,
    onChange: () => {},
  });
  return container;
}

const IN_BASELINE = () => 0;
const AFTER_BASELINE = (VL) => VL.BASELINE_DAYS + 1;
const AFTER_STUDY_END = (VL) => VL.TOTAL_DAYS + 2;

const hasFeedbackTabs = (c) => c.querySelectorAll("[data-tab]").length > 0;
const hasHome = (c) => c.textContent.includes("ViewLens와 함께한 지");

describe("ViewLensPopup 화면 선택 — 집단·시점별로 보이는 화면", () => {
  it("실험군은 베이스라인 이후 피드백 탭(오늘·기간)을 본다", async () => {
    const c = await mountPopup({
      group: "EXP",
      daysSinceInstall: AFTER_BASELINE,
    });
    expect(hasFeedbackTabs(c)).toBe(true);
    expect(hasHome(c)).toBe(false);
  });

  it("실험군도 베이스라인 기간에는 피드백 없이 홈 화면을 본다", async () => {
    const c = await mountPopup({ group: "EXP", daysSinceInstall: IN_BASELINE });
    expect(hasFeedbackTabs(c)).toBe(false);
    expect(hasHome(c)).toBe(true);
  });

  it("대조군은 연구 진행 중(베이스라인 이후) 피드백 탭 없이 홈 화면만 본다", async () => {
    const c = await mountPopup({
      group: "CON",
      daysSinceInstall: AFTER_BASELINE,
    });
    expect(hasFeedbackTabs(c)).toBe(false);
    expect(hasHome(c)).toBe(true);
    expect(c.querySelector("#vl-study-end-cta")).toBeNull();
  });

  it("대조군은 연구 종료 후에도 코드 인증 전에는 리뷰 대신 코드 입력 화면을 본다", async () => {
    const c = await mountPopup({
      group: "CON",
      daysSinceInstall: AFTER_STUDY_END,
    });
    expect(hasFeedbackTabs(c)).toBe(false);
    const cta = c.querySelector("#vl-study-end-cta");
    expect(cta).not.toBeNull();

    cta.click();
    expect(c.querySelector("#vl-study-end-code-input")).not.toBeNull();
    expect(hasFeedbackTabs(c)).toBe(false);
  });

  it("대조군은 연구 종료 후 코드 인증을 마친 뒤에만 리뷰 탭을 본다", async () => {
    const c = await mountPopup({
      group: "CON",
      daysSinceInstall: AFTER_STUDY_END,
      codeVerified: true,
    });
    expect(hasFeedbackTabs(c)).toBe(false); // 버튼을 누르기 전에는 홈 화면
    c.querySelector("#vl-study-end-cta").click();
    expect(hasFeedbackTabs(c)).toBe(true);
    expect(c.querySelector("#vl-study-end-code-input")).toBeNull();
  });

  it("연구 종료를 처음 맞은 참여자(안내 안 봄)에게는 종료 안내 모달을 띄우고 리뷰 열람 버튼은 아직 보여 주지 않는다", async () => {
    const c = await mountPopup({
      group: "CON",
      daysSinceInstall: AFTER_STUDY_END,
      noticeShown: false,
    });
    expect(c.textContent).toContain("연구 기간이 종료되었습니다");
    expect(c.querySelector("#vl-study-end-cta")).toBeNull();
  });
});
