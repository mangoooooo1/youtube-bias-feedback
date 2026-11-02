// @vitest-environment jsdom
/* global document, DOMParser */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadPopup } from "./load-popup.js";
import { bootPopup, cleanupPopup } from "./boot-popup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POPUP_HTML = readFileSync(
  path.join(__dirname, "../../popup/popup.html"),
  "utf8",
);

// 실제 popup.html의 body를 올린다. 스크립트는 loadPopup이 따로 불러온다
function mountPopupHtml() {
  const doc = new DOMParser().parseFromString(POPUP_HTML, "text/html");
  doc.querySelectorAll("script").forEach((s) => s.remove());
  document.body.innerHTML = doc.body.innerHTML;
}

const fallback = () => document.getElementById("vl-boot-fallback");
const root = () => document.getElementById("vl-popup-root");

beforeEach(mountPopupHtml);

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("부팅 실패 안내 — popup.html 정적 블록", () => {
  it("처음에는 숨겨져 있고, 모듈 없이 보일 문구를 담고 있다", () => {
    expect(fallback().hidden).toBe(true);
    expect(fallback().textContent).toContain(
      "화면을 불러오지 못했어요. 잠시 후 다시 열어 주세요.",
    );
    expect(fallback().textContent).toContain(
      "문제가 계속되면 연구자에게 연락해 주세요.",
    );
  });

  it("부팅이 실패하면 루트를 숨기고 안내를 보이며, 보고는 그대로 간다", async () => {
    const sendMessage = vi.fn(() => Promise.resolve());
    await loadPopup({
      realDom: true,
      chrome: {
        runtime: { sendMessage },
        storage: {
          local: { get: () => Promise.reject(new Error("read failed")) },
        },
      },
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    expect(fallback().hidden).toBe(false);
    expect(root().hidden).toBe(true);
    expect(sendMessage.mock.calls[0][0]).toEqual({
      type: "client-error",
      code: "POPUP_BOOT_FAILED",
      where: "popup.boot",
    });
  });

  it("정상 부팅에서는 안내가 숨겨진 채로 화면이 그려진다", async () => {
    // bootPopup이 루트를 직접 붙이므로 popup.html의 루트는 뺀다
    root().remove();
    try {
      await bootPopup({});

      expect(fallback().hidden).toBe(true);
      expect(root().hidden).toBe(false);
      expect(root().innerHTML).not.toBe("");
    } finally {
      cleanupPopup();
    }
  });
});
