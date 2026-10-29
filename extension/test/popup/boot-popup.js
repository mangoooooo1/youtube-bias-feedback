/* global document */
import { vi } from "vitest";
import { loadPopup } from "./load-popup.js";

// 가짜 저장소·서버로 실제 팝업(boot)을 실행하는 jsdom 테스트용 도우미
export const DAY = 86400000;
export const SERVER = "https://server.test";

export const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

// failSet(obj)이 true면 그 저장 호출은 저장 용량 초과처럼 거부한다
function fakeChrome(initial, failSet = () => false) {
  const data = structuredClone(initial);
  const listeners = [];
  const pick = (keys) =>
    keys == null
      ? { ...data }
      : Object.fromEntries(
          []
            .concat(keys)
            .filter((k) => k in data)
            .map((k) => [k, data[k]]),
        );
  return {
    data,
    listeners,
    chrome: {
      runtime: {
        id: "fake-extension-id",
        sendMessage: async () => {},
        getURL: (p) => `chrome-extension://fake/${p}`,
      },
      action: { setIcon: vi.fn() },
      storage: {
        local: {
          get: async (keys) => structuredClone(pick(keys)),
          set: async (obj) => {
            if (failSet(obj)) throw new Error("QUOTA_BYTES quota exceeded");
            Object.assign(data, structuredClone(obj));
          },
          remove: async (keys) =>
            [].concat(keys).forEach((k) => delete data[k]),
        },
        onChanged: { addListener: (fn) => listeners.push(fn) },
      },
    },
  };
}

const RESPONSES = {
  "/api/viewing-summary": { data: { days: [], periods: [] } },
  "/api/today-reviews": { data: [] },
  "/api/period-reviews": { data: [] },
  "/api/participants": { data: { participantToken: "new-tok" } },
};

// responses: 경로 → 응답 본문, 또는 (요청 본문) => ({ status, body }) 또는 그 Promise(응답을 늦출 때)
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init?.method ?? "GET", body });
    const r = responses[path] ?? RESPONSES[path] ?? {};
    const res = typeof r === "function" ? await r(body) : { body: r };
    const status = res.status ?? 200;
    return { ok: status < 400, status, json: async () => res.body ?? {} };
  };
  return {
    fn,
    calls,
    paths: () => calls.map((c) => c.path),
    count: (path) => calls.filter((c) => c.path === path).length,
  };
}

// now를 주면 Date도 그 시각으로 고정한다. 가짜 타이머를 다시 설치하면 앞서 고정한 Date가 풀리기 때문이다
export async function bootPopup(stored, { responses = {}, failSet, now } = {}) {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", ...(now == null ? [] : ["Date"])],
  });
  if (now != null) vi.setSystemTime(now);
  // 스크롤 등 다음 프레임 작업은 모아 두었다가 테스트가 runFrames()로 실행한다
  const frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb) => frames.push(cb));
  const runFrames = () => frames.splice(0).forEach((cb) => cb(0));
  const root = document.createElement("div");
  root.id = "vl-popup-root";
  document.body.appendChild(root);
  const { chrome, data, listeners } = fakeChrome(stored, failSet);
  const server = fakeFetch(responses);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  trackListeners(globalThis);
  trackListeners(document);
  await loadPopup({ realDom: true, chrome, fetch: server.fn });
  // 다른 확장 화면이 저장소를 바꾼 것처럼 onChanged 리스너를 부른다
  const emitChange = (changes, area = "local") =>
    Promise.all(listeners.map((fn) => fn(changes, area)));
  return { root, data, server, chrome, emitChange, runFrames };
}

// jsdom의 location.reload는 가로챌 수 없어 window만 바꾼다(나머지는 원래 전역을 그대로 본다)
export function stubReload() {
  const reload = vi.fn();
  vi.stubGlobal(
    "window",
    Object.assign(Object.create(globalThis), { location: { reload } }),
  );
  return reload;
}

// boot가 창·문서에 붙인 리스너는 jsdom이 테스트마다 새로 만들지 않아 다음 테스트로 넘어간다
const added = [];
function trackListeners(target) {
  const original = target.addEventListener;
  vi.spyOn(target, "addEventListener").mockImplementation((...args) => {
    added.push([target, args]);
    return original.apply(target, args);
  });
}

export function cleanupPopup() {
  for (const [target, args] of added.splice(0)) {
    target.removeEventListener(...args);
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
}

export const session = (id, over) => ({
  sessionId: id,
  endTime: new Date().toISOString(),
  categoryDistribution: { 뉴스: 1 },
  syncedToServer: true,
  ...over,
});

export const participant = (over) => ({
  serverUrl: SERVER,
  anonymousId: "anon-1",
  participantToken: "tok-1",
  participantCode: "P-001",
  participantSynced: true,
  studyEndNoticeShown: true,
  ...over,
});

export const hasFeedbackTabs = (c) =>
  c.querySelectorAll("[data-tab]").length > 0;
export const hasHome = (c) => c.textContent.includes("ViewLens와 함께한 지");
