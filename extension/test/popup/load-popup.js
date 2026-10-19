import { vi } from "vitest";

export const POPUP_SCRIPTS = [
  "study-schedule.js",
  "popup/viewlens-data.js",
  "popup/viewlens-logo.js",
  "popup/viewlens-ui.js",
  "popup/viewlens-screens.js",
  "popup/viewlens-app.js",
  "popup/viewlens-popup.js",
];

export async function loadPopup() {
  vi.resetModules();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", {
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: () => {},
  });
  vi.stubGlobal("chrome", {
    runtime: { id: "fake-extension-id", sendMessage: async () => {} },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  });
  vi.stubGlobal("fetch", async () => ({ ok: false }));
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const f of POPUP_SCRIPTS) await import(`../../${f}`);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  errorSpy.mockRestore();
  return globalThis;
}
