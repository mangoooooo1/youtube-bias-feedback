import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit } from "../../middleware/rateLimiter.js";

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
