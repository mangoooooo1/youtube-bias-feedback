import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULE_PATH = path.join(__dirname, "../study-schedule.js");
const VIEWLENS_DATA_PATH = path.join(__dirname, "../popup/viewlens-data.js");
const require = createRequire(import.meta.url);
const serverConstants = require("../../server/pipeline/study-constants.js");
const {
  dayFromInstall,
} = require("../../server/pipeline/period-boundaries.js");

const DAY_MS = 86400000;

let ViewLensStudy;
beforeAll(async () => {
  // background.js와 같은 방식(side-effect import)으로 불러와 globalThis에 붙는지 확인한다
  await import("../study-schedule.js");
  ViewLensStudy = globalThis.ViewLensStudy;
});

// 서버의 마지막 기간(TOTAL_DAYS번째 날) 다음 날 00:00 KST
function serverLastPeriodEndsAt(installDate) {
  const lastDay = dayFromInstall(installDate, serverConstants.TOTAL_DAYS - 1);
  return Date.parse(`${lastDay}T00:00:00+09:00`) + DAY_MS;
}

describe("getParticipationState — 참여 상태 경계", () => {
  it.each([
    ["오후 설치(15:00 KST)", "2026-09-01T06:00:00.000Z"],
    ["KST 자정 직전 설치(23:59)", "2026-09-01T14:59:00.000Z"],
    ["KST 자정 직후 설치(00:01)", "2026-09-01T15:01:00.000Z"],
  ])(
    "%s: 수집은 서버 마지막 기간이 끝나는 순간 멈추고, 3일 뒤 완전 종료된다",
    (_label, installDate) => {
      const { getParticipationState } = ViewLensStudy;
      const endsAt = serverLastPeriodEndsAt(installDate);
      const graceEndsAt = endsAt + 3 * DAY_MS;

      expect(getParticipationState(installDate, new Date(endsAt - 1))).toBe(
        "active",
      );
      expect(getParticipationState(installDate, new Date(endsAt))).toBe(
        "grace",
      );
      expect(
        getParticipationState(installDate, new Date(graceEndsAt - 1)),
      ).toBe("grace");
      expect(getParticipationState(installDate, new Date(graceEndsAt))).toBe(
        "ended",
      );
    },
  );

  it("설치 직후는 active다", () => {
    const installDate = "2026-09-01T06:00:00.000Z";
    expect(
      ViewLensStudy.getParticipationState(installDate, new Date(installDate)),
    ).toBe("active");
  });

  it.each(["not-a-date", "2026-13-45", "undefined"])(
    "손상된 installDate(%s)는 수집을 멈추지 않도록 active로 둔다",
    (installDate) => {
      expect(ViewLensStudy.getParticipationState(installDate)).toBe("active");
    },
  );

  it("installDate가 없으면(온보딩 전) active로 둔다", () => {
    expect(ViewLensStudy.getParticipationState(undefined)).toBe("active");
    expect(ViewLensStudy.getParticipationState(null)).toBe("active");
  });
});

// viewlens-data.js는 classic script라 import할 수 없어 소스에서 값을 읽는다
function popupConstant(name) {
  const source = readFileSync(VIEWLENS_DATA_PATH, "utf8");
  const match = source.match(new RegExp(`const ${name} = (\\d+);`));
  expect(match).not.toBeNull();
  return Number(match[1]);
}

describe("isBaselinePeriod — 베이스라인 경계", () => {
  it("installDate가 없으면 베이스라인으로 취급한다", () => {
    expect(ViewLensStudy.isBaselinePeriod(null)).toBe(true);
    expect(ViewLensStudy.isBaselinePeriod(undefined)).toBe(true);
  });

  it("설치 당일(경과 0일)은 베이스라인이다", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    expect(ViewLensStudy.isBaselinePeriod("2026-01-15T00:00:00Z", now)).toBe(
      true,
    );
  });

  it("BASELINE_DAYS번째 날(설치일 포함)은 베이스라인이다", () => {
    const { BASELINE_DAYS, isBaselinePeriod } = ViewLensStudy;
    const install = new Date("2026-01-01T00:00:00Z");
    const now = new Date(install.getTime() + (BASELINE_DAYS - 1) * DAY_MS);
    expect(isBaselinePeriod(install.toISOString(), now)).toBe(true);
  });

  it("BASELINE_DAYS + 1번째 날이면 베이스라인이 종료된다", () => {
    const { BASELINE_DAYS, isBaselinePeriod } = ViewLensStudy;
    const install = new Date("2026-01-01T00:00:00Z");
    const now = new Date(install.getTime() + BASELINE_DAYS * DAY_MS);
    expect(isBaselinePeriod(install.toISOString(), now)).toBe(false);
  });

  it.each([
    ["KST 자정 직전 설치(23:00)", "2026-01-01T14:00:00.000Z"],
    ["KST 자정 직후 설치(00:01)", "2026-01-01T15:01:00.000Z"],
  ])(
    "%s: 설치 시각과 관계없이 1구간 다음 날 00:00 KST에 끝난다",
    (_label, installDate) => {
      const { BASELINE_DAYS, isBaselinePeriod } = ViewLensStudy;
      const endsAt = Date.parse(
        `${dayFromInstall(installDate, BASELINE_DAYS)}T00:00:00+09:00`,
      );
      expect(isBaselinePeriod(installDate, new Date(endsAt - 1))).toBe(true);
      expect(isBaselinePeriod(installDate, new Date(endsAt))).toBe(false);
    },
  );

  it.each(["UTC", "America/Los_Angeles"])(
    "실행 환경 시간대가 %s여도 KST 기준으로 판정한다",
    (tz) => {
      const { isBaselinePeriod } = ViewLensStudy;
      const original = process.env.TZ;
      process.env.TZ = tz;
      try {
        const install = "2026-01-01T14:00:00.000Z"; // 23:00 KST
        expect(
          isBaselinePeriod(install, new Date("2026-01-04T14:59:59.999Z")),
        ).toBe(true);
        expect(
          isBaselinePeriod(install, new Date("2026-01-04T15:00:00.000Z")),
        ).toBe(false);
      } finally {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
      }
    },
  );

  it("손상된 installDate는 예외 없이 베이스라인이 아닌 것으로 본다", () => {
    expect(ViewLensStudy.isBaselinePeriod("not-a-date")).toBe(false);
  });

  it("BASELINE_DAYS + 7번째 날은 베이스라인이 아니다", () => {
    const { BASELINE_DAYS, isBaselinePeriod } = ViewLensStudy;
    const install = new Date("2026-01-01T00:00:00Z");
    const now = new Date(install.getTime() + (BASELINE_DAYS + 7) * DAY_MS);
    expect(isBaselinePeriod(install.toISOString(), now)).toBe(false);
  });
});

describe("연구 기간 상수 — 서버·팝업과 같은 값", () => {
  it("TOTAL_DAYS가 server/pipeline/study-constants.js와 같다", () => {
    expect(ViewLensStudy.TOTAL_DAYS).toBe(serverConstants.TOTAL_DAYS);
  });

  it("TOTAL_DAYS가 popup/viewlens-data.js와 같다", () => {
    const source = readFileSync(VIEWLENS_DATA_PATH, "utf8");
    const match = source.match(/const TOTAL_DAYS = (\d+);/);
    expect(match).not.toBeNull();
    expect(ViewLensStudy.TOTAL_DAYS).toBe(Number(match[1]));
  });

  it("DAYS_PER_PERIOD가 서버와 popup/viewlens-data.js에서 같다", () => {
    expect(popupConstant("DAYS_PER_PERIOD")).toBe(
      serverConstants.DAYS_PER_PERIOD,
    );
  });

  it("BASELINE_DAYS가 server/pipeline/study-constants.js와 같다", () => {
    expect(ViewLensStudy.BASELINE_DAYS).toBe(serverConstants.BASELINE_DAYS);
  });

  it("FALLBACK_RETRY_WINDOW_DAYS가 서버와 popup/viewlens-data.js에서 같다", () => {
    expect(popupConstant("FALLBACK_RETRY_WINDOW_DAYS")).toBe(
      serverConstants.FALLBACK_RETRY_WINDOW_DAYS,
    );
  });

  it("END_GRACE_DAYS는 3일이다", () => {
    expect(ViewLensStudy.END_GRACE_DAYS).toBe(3);
  });
});

describe("study-schedule.js — classic script로 불러올 때", () => {
  it("전역에는 ViewLensStudy만 추가하고 내부 상수를 흘리지 않는다", () => {
    const context = vm.createContext({});
    vm.runInContext(readFileSync(SCHEDULE_PATH, "utf8"), context);

    expect(Object.keys(context)).toEqual(["ViewLensStudy"]);
    expect(Object.isFrozen(context.ViewLensStudy)).toBe(true);
  });
});

describe("ENDED_NOTICE — 종료 안내 문구", () => {
  it("설문을 기다리라고 안내하고, 삭제·제거는 안내하지 않는다", () => {
    const { title, body } = ViewLensStudy.ENDED_NOTICE;
    const text = `${title} ${body}`;
    expect(text).toContain("종료");
    expect(text).toContain("설문");
    // 대조군은 종료 후 리뷰를 봐야 설문을 마칠 수 있고, 실험군도 설문 중 리뷰를 다시 볼 수 있어야 한다
    expect(text).not.toMatch(/삭제|제거/);
  });
});
