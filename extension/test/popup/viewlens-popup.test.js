import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWLENS_POPUP_PATH = path.join(
  __dirname,
  "../../popup/viewlens-popup.js",
);

// 팝업 사용 기록 큐 — 큐에 들어갈 때의 토큰이 아니라 보낼 때의 토큰을 써야, 토큰 기능 이전(2.2.0)이나
// 등록 전에 쌓인 기록이 403에 막혀 큐 전체가 영원히 멈추지 않는다.
describe("flushPendingPopupEvents — 팝업 사용 기록 큐 전송", () => {
  const POST_DECL =
    /async function postPopupEvent\(serverUrl, event\) \{[\s\S]*?\n\}/;
  const FLUSH_DECL =
    /async function flushPendingPopupEvents\(serverUrl\) \{[\s\S]*?\n\}/;
  const ID = "697236fb-5dd0-420f-aaae-c42128e1950a";

  function load(initialStorage, respond) {
    const raw = readFileSync(VIEWLENS_POPUP_PATH, "utf8");
    const src = [POST_DECL, FLUSH_DECL]
      .map((re) => raw.match(re)[0])
      .join("\n");
    let store = { ...initialStorage };
    const chrome = {
      storage: {
        local: {
          get: async (keys) =>
            Object.fromEntries([].concat(keys).map((k) => [k, store[k]])),
          set: async (obj) => {
            store = { ...store, ...structuredClone(obj) };
          },
        },
      },
    };
    const sent = [];
    const fetch = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      sent.push(body);
      return respond(body);
    });
    const console = { warn: vi.fn(), log: vi.fn() };
    const flush = new Function(
      "chrome",
      "fetch",
      "console",
      `${src}\nreturn flushPendingPopupEvents;`,
    )(chrome, fetch, console);
    return { flush, sent, fetch, console, dump: () => store };
  }

  const ok = () => ({ ok: true, status: 201, json: async () => ({}) });
  const events = (n, extra = {}) =>
    Array.from({ length: n }, (_, i) => ({
      eventId: `e${i}`,
      anonymousId: ID,
      ...extra,
    }));

  it("토큰 없이 쌓인 옛 기록(2.2.0)을 지금 토큰으로 보내 큐를 비운다", async () => {
    const { flush, sent, dump } = load(
      {
        pendingPopupEvents: events(7),
        anonymousId: ID,
        participantToken: "tok",
      },
      ok,
    );

    await flush("https://srv.example");

    expect(sent).toHaveLength(7);
    expect(sent.every((e) => e.participantToken === "tok")).toBe(true);
    expect(dump().pendingPopupEvents).toEqual([]);
  });

  it("다른 anonymousId로 쌓인 기록은 요청 없이 건너뛰고 뒤 기록은 정상 전송한다", async () => {
    const { flush, sent, dump, console } = load(
      {
        pendingPopupEvents: [
          { eventId: "old", anonymousId: "other-id" },
          ...events(2),
        ],
        anonymousId: ID,
        participantToken: "tok",
      },
      ok,
    );

    await flush("https://srv.example");

    expect(sent.map((e) => e.eventId)).toEqual(["e0", "e1"]);
    expect(dump().pendingPopupEvents).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("skip_foreign_identity eventId=old"),
    );
  });

  it("403 INVALID_PARTICIPANT_TOKEN이면 등록 게이트가 토큰을 다시 받도록 되돌리고 큐는 남긴다", async () => {
    const { flush, sent, dump } = load(
      {
        pendingPopupEvents: events(3),
        anonymousId: ID,
        participantSynced: true,
      },
      () => ({
        ok: false,
        status: 403,
        json: async () => ({ code: "INVALID_PARTICIPANT_TOKEN" }),
      }),
    );

    await flush("https://srv.example");

    expect(sent).toHaveLength(1);
    expect(dump().participantSynced).toBe(false);
    expect(dump().pendingPopupEvents).toHaveLength(3);
  });

  it.each([
    [
      "404",
      () => ({
        ok: false,
        status: 404,
        json: async () => ({ code: "NOT_FOUND" }),
      }),
    ],
    [
      "네트워크 오류",
      () => {
        throw new TypeError("network down");
      },
    ],
  ])("%s면 등록 상태는 그대로 두고 큐도 남긴다", async (_label, respond) => {
    const { flush, dump } = load(
      {
        pendingPopupEvents: events(3),
        anonymousId: ID,
        participantToken: "tok",
        participantSynced: true,
      },
      respond,
    );

    await flush("https://srv.example");

    expect(dump().participantSynced).toBe(true);
    expect(dump().pendingPopupEvents).toHaveLength(3);
  });
});

// boot().catch 블록과 보고 함수만 떼어 내고, boot는 인자로 바꿔 끼워 실패를 재현한다
const REPORT_CLIENT_ERROR_DECL =
  /function reportClientError\(code, where\) \{[\s\S]*?\n\}/;
const BOOT_CATCH_DECL = /boot\(\)\.catch\(\(err\) => \{[\s\S]*?\n\}\);/;

function runBootCatch({ chrome, bootError }) {
  const raw = readFileSync(VIEWLENS_POPUP_PATH, "utf8");
  const blocks = [REPORT_CLIENT_ERROR_DECL, BOOT_CATCH_DECL].map((re) => {
    const match = raw.match(re);
    if (!match) {
      throw new Error(
        `${re}에 매칭되는 선언을 찾지 못했습니다 — viewlens-popup.js 구조가 바뀌었을 수 있습니다.`,
      );
    }
    return match[0];
  });
  const consoleMock = { error: vi.fn() };
  new Function("chrome", "console", "boot", blocks.join("\n"))(
    chrome,
    consoleMock,
    () => Promise.reject(bootError),
  );
  return consoleMock;
}

describe("boot 실패 — 빈 팝업을 오류 보고로 넘긴다", () => {
  it("POPUP_BOOT_FAILED를 코드·위치만 담아 background에 보낸다", async () => {
    const sendMessage = vi.fn(() => Promise.resolve());
    const chrome = { storage: { local: {} }, runtime: { sendMessage } };

    runBootCatch({
      chrome,
      bootError: new Error("render failed: 참여코드 VL-ABCD 민감한 영상 제목"),
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    expect(sendMessage.mock.calls[0][0]).toEqual({
      type: "client-error",
      code: "POPUP_BOOT_FAILED",
      where: "popup.boot",
    });
    const sent = JSON.stringify(sendMessage.mock.calls);
    expect(sent).not.toContain("VL-ABCD");
    expect(sent).not.toContain("민감한");
  });

  it("메시지 전송이 실패해도 예외가 새어 나가지 않는다", async () => {
    const sendMessage = vi.fn(() => {
      throw new Error("Could not establish connection");
    });
    const chrome = { storage: { local: {} }, runtime: { sendMessage } };

    const consoleMock = runBootCatch({ chrome, bootError: new Error("x") });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());

    expect(consoleMock.error).toHaveBeenCalledTimes(1);
  });
});
