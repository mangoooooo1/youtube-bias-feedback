import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const serverLists = require("../../server/routes/client-errors-validate.js");

function createChromeMock() {
  let store = {};
  return {
    storage: {
      local: {
        get: (keys) => {
          const list = typeof keys === "string" ? [keys] : keys;
          const out = {};
          for (const k of list) {
            if (store[k] !== undefined) out[k] = structuredClone(store[k]);
          }
          return Promise.resolve(out);
        },
        set: (obj) => {
          store = { ...store, ...structuredClone(obj) };
          return Promise.resolve();
        },
      },
    },
    runtime: { getManifest: () => ({ version: "2.4.1" }) },
    _store: () => store,
  };
}

let mod;
beforeEach(async () => {
  globalThis.chrome = createChromeMock();
  vi.resetModules();
  mod = await import("../error-report.js");
});

const T0 = new Date("2026-09-30T01:00:00.000Z");
const minutesLater = (m) => new Date(T0.getTime() + m * 60 * 1000);

function okSend() {
  return vi.fn().mockResolvedValue({ ok: true, kind: "success", code: null });
}

describe("확장·서버 허용 목록 일치", () => {
  it("code 목록이 서버 검증 목록과 같다", () => {
    expect([...mod.CLIENT_ERROR_CODES].sort()).toEqual(
      [...serverLists.CLIENT_ERROR_CODES].sort(),
    );
  });

  it("where 목록이 서버 검증 목록과 같다", () => {
    expect([...mod.CLIENT_ERROR_WHERE].sort()).toEqual(
      [...serverLists.CLIENT_ERROR_WHERE].sort(),
    );
  });

  it("한 요청 최대 건수가 서버 한도와 같다", () => {
    expect(mod.MAX_ERRORS_PER_REQUEST).toBe(serverLists.MAX_ERRORS_PER_REQUEST);
  });
});

describe("reportClientError — 같은 오류는 묶는다", () => {
  it("같은 (code, where)는 횟수·처음·마지막 시각으로 합친다", async () => {
    await mod.reportClientError("RECORD_FAILED", "content.recordVideo", T0);
    await mod.reportClientError(
      "RECORD_FAILED",
      "content.recordVideo",
      minutesLater(5),
    );

    expect(globalThis.chrome._store().pendingClientErrors).toEqual({
      "RECORD_FAILED|content.recordVideo": {
        code: "RECORD_FAILED",
        where: "content.recordVideo",
        count: 2,
        firstAt: "2026-09-30T01:00:00.000Z",
        lastAt: "2026-09-30T01:05:00.000Z",
      },
    });
  });

  it("동시에 여러 번 보고해도 횟수가 빠지지 않는다", async () => {
    await Promise.all(
      Array.from({ length: 5 }, () =>
        mod.reportClientError("TASK_CRASHED", "background.serverTasks", T0),
      ),
    );

    expect(
      globalThis.chrome._store().pendingClientErrors[
        "TASK_CRASHED|background.serverTasks"
      ].count,
    ).toBe(5);
  });

  it("목록에 없는 code·where는 저장하지 않는다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await mod.reportClientError("영상 제목", "content.recordVideo", T0);
    await mod.reportClientError(
      "RECORD_FAILED",
      "https://www.youtube.com/watch?v=abc",
      T0,
    );

    expect(globalThis.chrome._store().pendingClientErrors).toBeUndefined();
  });

  it("storage가 실패해도 throw하지 않는다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.chrome.storage.local.get = () =>
      Promise.reject(new Error("boom"));

    await expect(
      mod.reportClientError("RECORD_FAILED", "content.recordVideo", T0),
    ).resolves.toBeUndefined();
  });
});

describe("buildClientErrorPayload — 콘텐츠가 본문에 들어가지 않는다", () => {
  it("항목에 제목·URL·메시지가 섞여 있어도 허용 목록 필드만 담는다", () => {
    const payload = mod.buildClientErrorPayload(
      [
        {
          code: "RECORD_FAILED",
          where: "content.recordVideo",
          count: 1,
          firstAt: "2026-09-30T01:00:00.000Z",
          lastAt: "2026-09-30T01:00:00.000Z",
          title: "민감한 영상 제목",
          url: "https://www.youtube.com/watch?v=abc",
          message: "TypeError",
          stack: "at recordVideo",
        },
      ],
      "exp-user",
      "2.4.1",
    );

    expect(Object.keys(payload).sort()).toEqual([
      "anonymousId",
      "errors",
      "version",
    ]);
    expect(Object.keys(payload.errors[0]).sort()).toEqual([
      "code",
      "count",
      "firstAt",
      "lastAt",
      "where",
    ]);
    const body = JSON.stringify(payload);
    expect(body).not.toContain("민감한");
    expect(body).not.toContain("youtube.com");
    expect(body).not.toContain("TypeError");
  });
});

describe("flushClientErrors — 묶어서 보내기", () => {
  it("버퍼가 비어 있으면 요청하지 않는다", async () => {
    const send = okSend();
    await mod.flushClientErrors(send, "exp-user", T0);
    expect(send).not.toHaveBeenCalled();
  });

  it("모인 오류를 한 요청으로 보내고 성공하면 버퍼를 비운다", async () => {
    await mod.reportClientError("RECORD_FAILED", "content.recordVideo", T0);
    await mod.reportClientError("POPUP_BOOT_FAILED", "popup.boot", T0);
    const send = okSend();

    await mod.flushClientErrors(send, "exp-user", T0);

    expect(send).toHaveBeenCalledTimes(1);
    const [path, method, body] = send.mock.calls[0];
    expect(path).toBe("/api/client-errors");
    expect(method).toBe("POST");
    expect(body.anonymousId).toBe("exp-user");
    expect(body.version).toBe("2.4.1");
    expect(body.errors).toHaveLength(2);
    expect(globalThis.chrome._store().pendingClientErrors).toEqual({});
  });

  it("직전 전송 후 15분이 안 지났으면 보내지 않는다", async () => {
    const send = okSend();
    await mod.reportClientError("RECORD_FAILED", "content.recordVideo", T0);
    await mod.flushClientErrors(send, "exp-user", T0);
    await mod.reportClientError(
      "RECORD_FAILED",
      "content.recordVideo",
      minutesLater(1),
    );

    await mod.flushClientErrors(send, "exp-user", minutesLater(14));
    expect(send).toHaveBeenCalledTimes(1);

    await mod.flushClientErrors(send, "exp-user", minutesLater(15));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("네트워크·서버 오류면 버퍼를 남겨 다음에 다시 보낸다", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await mod.reportClientError("RECORD_FAILED", "content.recordVideo", T0);
    const send = vi
      .fn()
      .mockResolvedValue({ ok: false, kind: "queue", code: "network" });

    await mod.flushClientErrors(send, "exp-user", T0);

    expect(
      globalThis.chrome._store().pendingClientErrors[
        "RECORD_FAILED|content.recordVideo"
      ].count,
    ).toBe(1);
  });

  it("400이면 다시 보내도 거부되므로 버린다", async () => {
    await mod.reportClientError("RECORD_FAILED", "content.recordVideo", T0);
    const send = vi.fn().mockResolvedValue({
      ok: false,
      kind: "item",
      code: "INVALID_FIELD_VALUE",
    });

    await mod.flushClientErrors(send, "exp-user", T0);

    expect(globalThis.chrome._store().pendingClientErrors).toEqual({});
  });

  it("SERVER_URL 미설정이면 간격을 소비하지 않는다", async () => {
    await mod.reportClientError("RECORD_FAILED", "content.recordVideo", T0);
    const noUrl = vi
      .fn()
      .mockResolvedValue({ ok: false, kind: "queue", code: "no_server_url" });
    await mod.flushClientErrors(noUrl, "exp-user", T0);

    const send = okSend();
    await mod.flushClientErrors(send, "exp-user", minutesLater(1));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("한 번에 20건까지만 보내고 나머지는 남긴다", async () => {
    const buffer = {};
    for (let i = 0; i < 25; i += 1) {
      buffer[`k${i}`] = {
        code: "RECORD_FAILED",
        where: "content.recordVideo",
        count: 1,
        firstAt: T0.toISOString(),
        lastAt: T0.toISOString(),
      };
    }
    await globalThis.chrome.storage.local.set({ pendingClientErrors: buffer });
    const send = okSend();

    await mod.flushClientErrors(send, "exp-user", T0);

    expect(send.mock.calls[0][2].errors).toHaveLength(20);
    expect(
      Object.keys(globalThis.chrome._store().pendingClientErrors),
    ).toHaveLength(5);
  });

  it("전송 대기 중에 들어온 보고는 지워지지 않는다", async () => {
    await mod.reportClientError("RECORD_FAILED", "content.recordVideo", T0);
    let release;
    const send = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, kind: "success", code: null });
        }),
    );

    const flushing = mod.flushClientErrors(send, "exp-user", T0);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    const reporting = mod.reportClientError(
      "RECORD_FAILED",
      "content.recordVideo",
      minutesLater(1),
    );
    release();
    await Promise.all([flushing, reporting]);

    expect(
      globalThis.chrome._store().pendingClientErrors[
        "RECORD_FAILED|content.recordVideo"
      ].count,
    ).toBe(1);
  });
});
