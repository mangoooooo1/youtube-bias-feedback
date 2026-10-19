import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { loadPopup } from "./load-popup.js";

async function loadScreens(validateParticipantCode) {
  const g = await loadPopup();
  vi.stubGlobal("validateParticipantCode", validateParticipantCode);
  return {
    parseParticipantCode: g.parseParticipantCode,
    bindOnboarding: g.bindOnboarding,
  };
}

// 실제 팝업 파일을 불러온 뒤 이 테스트의 chrome·fetch를 넣는다(validateParticipantCode는 호출 시점에 전역을 찾는다)
async function loadValidate(chrome, fetch) {
  const { validateParticipantCode } = await loadPopup();
  vi.stubGlobal("chrome", chrome);
  vi.stubGlobal("fetch", fetch);
  return validateParticipantCode;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeEl() {
  const listeners = {};
  return {
    value: "",
    textContent: "",
    disabled: false,
    style: {},
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    fire: (type, e = {}) => listeners[type](e),
  };
}

// 코드를 입력하고 제출한 뒤 onSubmit 인자와 오류 문구를 돌려준다
async function submitCode(code, check) {
  const els = {
    "#vl-onboard-input": fakeEl(),
    "#vl-onboard-err": fakeEl(),
    "#vl-onboard-btn": fakeEl(),
  };
  const root = { querySelector: (sel) => els[sel] };
  const validate = check && vi.fn(async () => check);
  const { bindOnboarding } = await loadScreens(validate);
  const onSubmit = vi.fn();
  bindOnboarding(root, onSubmit);

  els["#vl-onboard-input"].value = code;
  await els["#vl-onboard-btn"].fire("click");
  const err = els["#vl-onboard-err"];
  return {
    submitted: onSubmit.mock.calls[0]?.[0] ?? null,
    error: err.style.display === "block" ? err.textContent : null,
  };
}

describe("parseParticipantCode — 형식만 검사하고 집단은 정하지 않는다", () => {
  let parseParticipantCode;

  beforeAll(async () => {
    ({ parseParticipantCode } = await loadScreens());
  });

  it.each(["VL-K7M2", "QWE-K7M2", "ASD-AB23", " vl-k7m2 "])(
    "%j는 통과하되 group이 없다",
    (raw) => {
      expect(parseParticipantCode(raw)).toEqual({
        group: null,
        code: raw.trim().toUpperCase(),
      });
    },
  );

  it("TEST 코드는 코드 자체가 그룹이다", () => {
    expect(parseParticipantCode("test-exp")).toEqual({
      group: "TEST-EXP",
      code: "TEST-EXP",
    });
  });

  it.each([
    "VL-K7M0",
    "VL-K7M1",
    "V-K7M2",
    "ABCD-K7M2",
    "VL-K7M",
    "VL-K7M2X",
    "",
  ])("%j는 거부한다", (raw) => {
    expect(parseParticipantCode(raw)).toBeNull();
  });
});

describe("온보딩 제출 — 집단은 서버 응답으로만 정한다", () => {
  it("서버가 정한 그룹으로 등록한다", async () => {
    const r = await submitCode("VL-K7M2", { ok: true, group: "CON" });
    expect(r.submitted).toEqual({ group: "CON", code: "VL-K7M2" });
  });

  it("옛 접두사여도 접두사가 아닌 서버 그룹을 쓴다", async () => {
    const r = await submitCode("QWE-K7M2", { ok: true, group: "CON" });
    expect(r.submitted).toEqual({ group: "CON", code: "QWE-K7M2" });
  });

  it("미발급 코드는 등록하지 않고 미발급 안내를 보인다", async () => {
    const r = await submitCode("VL-K7M2", { ok: false });
    expect(r.submitted).toBeNull();
    expect(r.error).toContain("발급되지 않은 코드");
  });

  it.each([
    ["서버 확인 실패", { ok: false, reason: "unavailable" }],
    ["서버가 그룹을 주지 않음", { ok: true, group: null }],
    ["검증 함수 없음", undefined],
  ])("%s이면 등록하지 않고 연결 안내를 보인다", async (_, check) => {
    const r = await submitCode("VL-K7M2", check);
    expect(r.submitted).toBeNull();
    expect(r.error).toContain("지금은 코드를 확인할 수 없어요");
  });

  it("TEST 코드는 서버가 통과시키면 코드 그룹으로 등록한다", async () => {
    const r = await submitCode("TEST-EXP", { ok: true, group: null });
    expect(r.submitted).toEqual({ group: "TEST-EXP", code: "TEST-EXP" });
  });
});

describe("validateParticipantCode — 확인 실패를 통과로 취급하지 않는다", () => {
  const chrome = (serverUrl) => ({
    storage: { local: { get: async () => ({ serverUrl }) } },
  });
  const unavailable = { ok: false, reason: "unavailable" };

  it("서버 미설정이면 unavailable", async () => {
    const validate = await loadValidate(chrome(undefined), vi.fn());
    expect(await validate("VL-K7M2")).toEqual(unavailable);
  });

  it("서버 오류 응답이면 unavailable", async () => {
    const fetch = vi.fn(async () => ({ ok: false }));
    const validate = await loadValidate(chrome("https://x"), fetch);
    expect(await validate("VL-K7M2")).toEqual(unavailable);
  });

  it("네트워크 오류면 unavailable", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    const validate = await loadValidate(chrome("https://x"), fetch);
    expect(await validate("VL-K7M2")).toEqual(unavailable);
  });

  it("미발급이면 reason 없이 ok:false", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { valid: false } }),
    }));
    const validate = await loadValidate(chrome("https://x"), fetch);
    expect(await validate("VL-K7M2")).toEqual({ ok: false });
  });

  it("발급 코드면 서버 그룹을 돌려준다", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: { valid: true, group_code: "EXP", previouslyRegistered: false },
      }),
    }));
    const validate = await loadValidate(chrome("https://x"), fetch);
    expect(await validate("VL-K7M2")).toEqual({
      ok: true,
      group: "EXP",
      previouslyRegistered: false,
    });
  });
});
