import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit, clientKey } from "../../middleware/rateLimiter.js";

describe("checkRateLimit", () => {
  let state;
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX = 5;

  beforeEach(() => {
    state = new Map();
  });

  it("윈도우 안에서 max회까지는 허용한다", () => {
    let now = 0;
    for (let i = 0; i < MAX; i++) {
      expect(checkRateLimit(state, "1.2.3.4", now, WINDOW_MS, MAX)).toBe(true);
    }
  });

  it("윈도우 안에서 max회를 초과하면 거부한다", () => {
    const now = 0;
    for (let i = 0; i < MAX; i++) {
      checkRateLimit(state, "1.2.3.4", now, WINDOW_MS, MAX);
    }
    expect(checkRateLimit(state, "1.2.3.4", now, WINDOW_MS, MAX)).toBe(false);
  });

  it("윈도우가 지나면 카운트가 리셋된다", () => {
    const now = 0;
    for (let i = 0; i < MAX; i++) {
      checkRateLimit(state, "1.2.3.4", now, WINDOW_MS, MAX);
    }
    expect(checkRateLimit(state, "1.2.3.4", now, WINDOW_MS, MAX)).toBe(false);

    const afterWindow = now + WINDOW_MS;
    expect(checkRateLimit(state, "1.2.3.4", afterWindow, WINDOW_MS, MAX)).toBe(
      true,
    );
  });

  it("서로 다른 키(IP)는 독립적으로 카운트된다", () => {
    const now = 0;
    for (let i = 0; i < MAX; i++) {
      checkRateLimit(state, "1.2.3.4", now, WINDOW_MS, MAX);
    }
    expect(checkRateLimit(state, "1.2.3.4", now, WINDOW_MS, MAX)).toBe(false);
    expect(checkRateLimit(state, "5.6.7.8", now, WINDOW_MS, MAX)).toBe(true);
  });
});

describe("clientKey", () => {
  // 운영 환경의 nginx가 X-Real-IP로 실제 클라이언트 IP를 전달한다.
  // 그 헤더를 req.ip보다 우선해야 서로 다른 참여자가 같은 리버스 프록시 소켓(127.0.0.1)이 아니라 실제 IP 기준으로 개별 카운트된다.
  it("X-Real-IP 헤더가 있으면 req.ip보다 그 값을 우선한다", () => {
    const req = { headers: { "x-real-ip": "203.0.113.9" }, ip: "127.0.0.1" };
    expect(clientKey(req)).toBe("203.0.113.9");
  });

  it("X-Real-IP 헤더가 없으면(로컬 개발·테스트처럼 nginx를 안 거치는 경우) req.ip로 폴백한다", () => {
    const req = { headers: {}, ip: "127.0.0.1" };
    expect(clientKey(req)).toBe("127.0.0.1");
  });
});
