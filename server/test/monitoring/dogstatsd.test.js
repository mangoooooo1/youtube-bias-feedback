import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDogStatsd, formatMetric } from "../../monitoring/dogstatsd.js";

const ALLOWED = {
  kind: new Set(["today", "period"]),
  status: new Set(["success", "fallback"]),
};

function fakeSocket() {
  const sent = [];
  const callbacks = [];
  return {
    sent,
    callbacks,
    on: vi.fn(),
    unref: vi.fn(),
    close: vi.fn(),
    send: vi.fn((line, port, host, cb) => {
      sent.push({ line, port, host });
      callbacks.push(cb);
    }),
  };
}

let warnSpy;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe("formatMetric", () => {
  it("이름·값·타입·허용 태그로 DogStatsD 한 줄을 만든다", () => {
    expect(
      formatMetric(
        "viewlens.llm.calls",
        1,
        "c",
        { kind: "today", status: "fallback" },
        ALLOWED,
      ),
    ).toBe("viewlens.llm.calls:1|c|#kind:today,status:fallback");
  });

  it("태그가 없으면 # 부분을 붙이지 않는다", () => {
    expect(formatMetric("viewlens.llm.gemini_ms", 812, "d", {}, ALLOWED)).toBe(
      "viewlens.llm.gemini_ms:812|d",
    );
  });

  it.each([
    ["anonymousId", { anonymousId: "3f2b8c1e-1111-4222-8333-444455556666" }],
    ["sessionId", { sessionId: "1759123456789" }],
    ["참여 코드", { participantCode: "VL-ABCD" }],
  ])("허용 목록 밖 키(%s)는 버린다", (_label, extra) => {
    const line = formatMetric(
      "viewlens.llm.calls",
      1,
      "c",
      { kind: "today", ...extra },
      ALLOWED,
    );
    expect(line).toBe("viewlens.llm.calls:1|c|#kind:today");
  });

  it("허용된 키라도 목록 밖 값은 버린다(태그 값으로 식별자를 실어 보내는 실수 방지)", () => {
    const line = formatMetric(
      "viewlens.llm.calls",
      1,
      "c",
      { kind: "3f2b8c1e-1111-4222-8333-444455556666", status: "success" },
      ALLOWED,
    );
    expect(line).toBe("viewlens.llm.calls:1|c|#status:success");
  });

  it("null·undefined 태그 값은 경고 없이 건너뛴다", () => {
    expect(
      formatMetric("viewlens.llm.calls", 1, "c", { status: null }, ALLOWED),
    ).toBe("viewlens.llm.calls:1|c");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["viewlens. 접두사 없음", "llm.calls", 1, "c"],
    ["이름에 구분자 문자", "viewlens.llm|calls", 1, "c"],
    ["지원하지 않는 타입", "viewlens.llm.calls", 1, "h"],
    ["NaN 값", "viewlens.llm.calls", NaN, "c"],
    ["문자열 값", "viewlens.llm.calls", "1", "c"],
  ])("%s이면 null", (_label, name, value, type) => {
    expect(formatMetric(name, value, type, {}, ALLOWED)).toBeNull();
  });
});

describe("createDogStatsd", () => {
  it("production이 아니면(기본값) 소켓을 만들지 않는다", () => {
    const createSocket = vi.fn(fakeSocket);
    const client = createDogStatsd({
      enabled: false,
      allowedTags: ALLOWED,
      createSocket,
    });

    client.send("viewlens.llm.calls", 1, "c", { kind: "today" });

    expect(createSocket).not.toHaveBeenCalled();
  });

  it("켜져 있으면 127.0.0.1:8125로 보내고, 소켓은 프로세스를 붙잡지 않는다", () => {
    const socket = fakeSocket();
    const client = createDogStatsd({
      enabled: true,
      allowedTags: ALLOWED,
      createSocket: () => socket,
    });

    client.send("viewlens.llm.calls", 1, "c", { kind: "today" });

    expect(socket.sent).toEqual([
      {
        line: "viewlens.llm.calls:1|c|#kind:today",
        port: 8125,
        host: "127.0.0.1",
      },
    ]);
    expect(socket.unref).toHaveBeenCalled();
  });

  it("잘못된 메트릭은 보내지 않는다", () => {
    const socket = fakeSocket();
    const client = createDogStatsd({
      enabled: true,
      allowedTags: ALLOWED,
      createSocket: () => socket,
    });

    client.send("bad name", 1, "c");

    expect(socket.sent).toEqual([]);
  });

  it("소켓이 예외를 던져도 throw하지 않는다", () => {
    const client = createDogStatsd({
      enabled: true,
      allowedTags: ALLOWED,
      createSocket: () => {
        throw new Error("EMFILE");
      },
    });

    expect(() => client.send("viewlens.llm.calls", 1, "c")).not.toThrow();
  });

  it("close는 보내는 중인 패킷이 끝난 뒤 소켓을 닫는다", async () => {
    const socket = fakeSocket();
    const client = createDogStatsd({
      enabled: true,
      allowedTags: ALLOWED,
      createSocket: () => socket,
    });
    client.send("viewlens.llm.calls", 1, "c");

    let closed = false;
    const closing = client.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    socket.callbacks[0]();
    await closing;
    expect(socket.close).toHaveBeenCalled();
  });

  it("보낸 적이 없으면 close가 바로 끝난다", async () => {
    const client = createDogStatsd({ enabled: true, allowedTags: ALLOWED });
    await expect(client.close()).resolves.toBeUndefined();
  });
});
