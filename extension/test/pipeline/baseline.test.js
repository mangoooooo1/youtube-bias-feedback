import { describe, it, expect } from "vitest";
import { BASELINE_DAYS, isBaselinePeriod } from "../../pipeline/baseline.js";

describe("isBaselinePeriod", () => {
  it("installDate가 없으면 베이스라인으로 취급한다", () => {
    expect(isBaselinePeriod(null)).toBe(true);
    expect(isBaselinePeriod(undefined)).toBe(true);
  });

  it("설치 당일(경과 0일)은 베이스라인이다", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    expect(isBaselinePeriod("2026-01-15T00:00:00Z", now)).toBe(true);
  });

  it(`경과 ${BASELINE_DAYS - 1}일은 베이스라인이다`, () => {
    const install = new Date("2026-01-01T00:00:00Z");
    const now = new Date(install.getTime() + (BASELINE_DAYS - 1) * 86400000);
    expect(isBaselinePeriod(install.toISOString(), now)).toBe(true);
  });

  it(`경과 정확히 ${BASELINE_DAYS}일이면 베이스라인이 종료된다(경계값)`, () => {
    const install = new Date("2026-01-01T00:00:00Z");
    const now = new Date(install.getTime() + BASELINE_DAYS * 86400000);
    expect(isBaselinePeriod(install.toISOString(), now)).toBe(false);
  });

  it(`경과 ${BASELINE_DAYS + 7}일은 베이스라인이 아니다`, () => {
    const install = new Date("2026-01-01T00:00:00Z");
    const now = new Date(install.getTime() + (BASELINE_DAYS + 7) * 86400000);
    expect(isBaselinePeriod(install.toISOString(), now)).toBe(false);
  });
});
