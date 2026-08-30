import { describe, it, expect, vi } from "vitest";
import { checkHealth } from "../../monitoring/server-health-check.js";

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
