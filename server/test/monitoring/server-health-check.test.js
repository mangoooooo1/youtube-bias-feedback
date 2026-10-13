import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkHealth, main } from "../../monitoring/server-health-check.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("checkHealth", () => {
  it("db:ok 응답이면 정상으로 판정한다", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: { db: "ok" } }));

    const result = await checkHealth({
      healthUrl: "https://example.test/health",
      fetchImpl,
    });

    expect(result).toEqual({ ok: true });
  });

  it("HTTP 상태가 실패면 이유와 함께 실패로 판정한다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, {}));

    const result = await checkHealth({
      healthUrl: "https://example.test/health",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("HTTP 500");
  });

  it("HTTP는 200이지만 db가 fail이면 실패로 판정한다", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: { db: "fail" } }));

    const result = await checkHealth({
      healthUrl: "https://example.test/health",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("db=fail");
  });

  it("네트워크 오류가 나도 예외를 던지지 않고 실패 사유를 반환한다", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await checkHealth({
      healthUrl: "https://example.test/health",
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, reason: "ECONNREFUSED" });
  });

  it("응답 본문에 data가 없어도 크래시하지 않는다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));

    const result = await checkHealth({
      healthUrl: "https://example.test/health",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("db=unknown");
  });
});

describe("main — 헬스 판정과 ping 전송 조합", () => {
  const HEALTH_URL = "https://server.test/health";
  const PING_URL = "https://hc.test/server";
  let fetchMock;
  let prevExitCode;

  // 헬스 URL과 ping URL에 각각 응답하는 fetch. ping이 null이면 네트워크 오류를 낸다
  function stubFetch({ db = "ok", pingStatus = 200 } = {}) {
    fetchMock = vi.fn(async (url) => {
      if (url === HEALTH_URL) return jsonResponse(200, { data: { db } });
      if (pingStatus === null) throw new Error("getaddrinfo ENOTFOUND");
      return { ok: pingStatus < 400, status: pingStatus };
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  beforeEach(() => {
    vi.stubEnv("HEALTH_URL", HEALTH_URL);
    vi.stubEnv("SERVER_HEALTH_PING_URL", PING_URL);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    prevExitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = prevExitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("헬스와 ping이 모두 정상이면 성공 ping을 보내고 exitCode를 바꾸지 않는다", async () => {
    stubFetch();

    await main();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      HEALTH_URL,
      PING_URL,
    ]);
    expect(process.exitCode).toBe(prevExitCode);
  });

  it("db=fail이면 /fail로 사유를 담아 보낸다", async () => {
    stubFetch({ db: "fail" });

    await main();

    const [url, opts] = fetchMock.mock.calls[1];
    expect(url).toBe(`${PING_URL}/fail`);
    expect(opts.method).toBe("POST");
    expect(opts.body).toBe("헬스체크 실패: db=fail");
    expect(process.exitCode).toBe(prevExitCode);
  });

  it("ping 전송 자체가 실패하면 exitCode=1로 끝낸다", async () => {
    stubFetch({ pingStatus: null });

    await main();

    expect(process.exitCode).toBe(1);
  });
});
