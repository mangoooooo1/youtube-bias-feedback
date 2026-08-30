import { describe, it, expect, vi } from "vitest";
import { pingSuccess, pingFail } from "../../monitoring/healthchecks-ping.js";

describe("pingSuccess/pingFail — 환경변수 누락", () => {
  it("환경변수가 없으면 네트워크 호출 없이 안전하게 건너뛴다", async () => {
    const fetchImpl = vi.fn();
    const result = await pingSuccess("MISSING_PING_URL", {
      env: {},
      fetchImpl,
    });

    expect(result).toEqual({ skipped: true, ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("pingFail도 환경변수가 없으면 건너뛴다", async () => {
    const fetchImpl = vi.fn();
    const result = await pingFail("MISSING_PING_URL", "에러 상세", {
      env: {},
      fetchImpl,
    });

    expect(result).toEqual({ skipped: true, ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("pingSuccess — 정상 ping", () => {
  it("GET으로 ping URL을 그대로 호출한다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const env = { PING_URL: "https://hc-ping.com/abc-123" };

    const result = await pingSuccess("PING_URL", { env, fetchImpl });

    expect(result).toEqual({ skipped: false, ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hc-ping.com/abc-123",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("URL 끝의 슬래시는 제거하고 호출한다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const env = { PING_URL: "https://hc-ping.com/abc-123/" };

    await pingSuccess("PING_URL", { env, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hc-ping.com/abc-123",
      expect.anything(),
    );
  });
});

describe("pingFail — 실패 ping", () => {
  it("/fail 경로로 POST하고 detail을 본문에 담는다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const env = { PING_URL: "https://hc-ping.com/abc-123" };

    await pingFail("PING_URL", "DB 연결 실패", { env, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hc-ping.com/abc-123/fail",
      expect.objectContaining({ method: "POST", body: "DB 연결 실패" }),
    );
  });

  it("detail이 10000자를 넘으면 잘라서 보낸다(Healthchecks.io 본문 상한)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const env = { PING_URL: "https://hc-ping.com/abc-123" };
    const longDetail = "x".repeat(20000);

    await pingFail("PING_URL", longDetail, { env, fetchImpl });

    const [, options] = fetchImpl.mock.calls[0];
    expect(options.body).toHaveLength(10000);
  });

  it("detail 없이 호출해도 예외 없이 빈 본문으로 POST한다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const env = { PING_URL: "https://hc-ping.com/abc-123" };

    const result = await pingFail("PING_URL", undefined, { env, fetchImpl });

    expect(result.ok).toBe(true);
    const [, options] = fetchImpl.mock.calls[0];
    expect(options.body).toBe("");
  });
});

describe("네트워크 오류 처리", () => {
  it("fetch가 실패해도 예외를 던지지 않고 ok:false를 반환한다", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const env = { PING_URL: "https://hc-ping.com/abc-123" };

    const result = await pingSuccess("PING_URL", { env, fetchImpl });

    expect(result).toEqual({
      skipped: false,
      ok: false,
      error: "network down",
    });
  });

  it("타임아웃 시에도 예외를 던지지 않는다(AbortError 흡수)", async () => {
    const fetchImpl = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new Error("The operation was aborted")),
          );
        }),
    );
    const env = { PING_URL: "https://hc-ping.com/abc-123" };

    const result = await pingSuccess("PING_URL", {
      env,
      fetchImpl,
      timeoutMs: 5,
    });

    expect(result.ok).toBe(false);
  });
});
