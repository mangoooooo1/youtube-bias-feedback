import { describe, it, expect } from "vitest";
import { buildHealthPayload } from "../../routes/health.js";

describe("buildHealthPayload", () => {
  it("DB 접근이 정상이면 healthy/ok를 반환한다", () => {
    const db = { prepare: () => ({ get: () => ({ 1: 1 }) }) };

    const result = buildHealthPayload(db, () => 123);

    expect(result).toEqual({ status: "healthy", db: "ok", timestamp: 123 });
  });

  it("DB 접근이 실패하면 예외를 던지지 않고 degraded/fail을 반환한다", () => {
    const db = {
      prepare: () => {
        throw new Error("database is locked");
      },
    };

    expect(() => buildHealthPayload(db)).not.toThrow();
    const result = buildHealthPayload(db, () => 456);
    expect(result).toEqual({ status: "degraded", db: "fail", timestamp: 456 });
  });

  it("prepare는 성공하지만 get()이 실패해도 degraded/fail을 반환한다", () => {
    const db = {
      prepare: () => ({
        get: () => {
          throw new Error("disk I/O error");
        },
      }),
    };

    const result = buildHealthPayload(db, () => 789);
    expect(result).toEqual({ status: "degraded", db: "fail", timestamp: 789 });
  });
});
