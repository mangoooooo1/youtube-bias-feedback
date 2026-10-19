import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { POPUP_SCRIPTS, loadPopup } from "./load-popup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.join(__dirname, "../..");

// 다른 팝업 파일이 이름만으로 쓰는 함수 — 테스트는 파일을 따로 불러오므로 window 노출이 있어야 이어진다
const CROSS_FILE_NAMES = [
  "vlEscapeHtml",
  "dateStr",
  "dayFromInstall",
  "_isStudyEndTimeReached",
  "_dayViewForDate",
];

const read = (f) => readFileSync(path.join(EXTENSION_DIR, f), "utf8");

// 팝업 테스트는 모두 POPUP_SCRIPTS 순서로 불러온다. popup.html과 어긋나면 브라우저와 다른 조건이 된다
describe("POPUP_SCRIPTS", () => {
  it("popup.html의 <script> 목록·순서와 같다", () => {
    const srcs = [
      ...read("popup/popup.html").matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g),
    ].map(([, src]) => path.posix.normalize(`popup/${src}`));
    expect(srcs).toEqual(POPUP_SCRIPTS);
  });
});

// 브라우저처럼 하나의 전역(window)을 공유하는 classic script 환경
function createPopupLikeContext() {
  const context = vm.createContext({
    document: {
      getElementById: () => null,
      querySelector: () => null,
      addEventListener: () => {},
    },
    chrome: {
      runtime: { id: "fake-extension-id", sendMessage: async () => {} },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
    fetch: async () => ({ ok: false }),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    crypto: globalThis.crypto,
    URL,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext("var window = globalThis;", context);
  return context;
}

// 브라우저는 팝업 파일을 module이 없는 classic script로 순서대로 실행한다. 테스트를 위해 더한
// window 노출이 그 환경에서 오류를 내거나 동작을 바꾸지 않는지 같은 조건(vm, 모듈 아님)으로 확인한다.
describe("팝업 classic script 실행 — 테스트를 위한 window 노출이 브라우저에 영향을 주지 않는다", () => {
  it.each(POPUP_SCRIPTS)("%s는 모듈이 아닌 스크립트로 파싱된다", (f) => {
    expect(() => new vm.Script(read(f))).not.toThrow();
  });

  it("하나의 전역에서 popup.html 순서대로 실행해도 오류가 없고 module·exports를 만들지 않는다", () => {
    const context = createPopupLikeContext();
    for (const f of POPUP_SCRIPTS) {
      expect(() =>
        vm.runInContext(read(f), context, { filename: f }),
      ).not.toThrow();
    }
    expect(context.module).toBeUndefined();
    expect(context.exports).toBeUndefined();
  });
});

// 테스트(Vitest)는 파일마다 따로 모듈로 불러와 최상위 선언을 공유하지 않는다. 다른 파일이
// 이름만으로 쓰는 함수는 window(=전역 객체)에 노출돼 있어야 이어진다 — 노출이 빠지면 여기서 실패한다.
describe("팝업 파일을 테스트처럼 따로 불러와도 파일 간 이름 참조가 이어진다", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each(CROSS_FILE_NAMES)("%s가 전역에서 보인다", async (name) => {
    await loadPopup();
    expect(typeof globalThis[name]).toBe("function");
  });
});
