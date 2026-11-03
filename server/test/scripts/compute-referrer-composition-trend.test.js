import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 스크립트가 불러오는 db.js가 운영 DB 파일을 열지 않게 임시 파일로 돌린다(다른 연결 테스트와 같은 방식)
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `viewlens-referrer-trend-${process.pid}.db`,
);
let compositionByPeriod;
let db;
beforeAll(async () => {
  fs.rmSync(TEST_DB_PATH, { force: true });
  process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
  process.env.DB_PATH = TEST_DB_PATH;
  ({ compositionByPeriod } =
    await import("../../scripts/compute-referrer-composition-trend.js"));
  ({ db } = await import("../../db.js"));
});
afterAll(() => {
  db?.close();
  fs.rmSync(TEST_DB_PATH, { force: true });
});

const INSTALL = "2026-09-01T00:00:00+09:00";

describe("compositionByPeriod — 기간별 유입 경로 구성", () => {
  it("멈췄다 이어 본 기록은 맨 앞 기록의 유입 경로로 한 번만 센다", () => {
    const events = [
      {
        eventId: "e1",
        referrerType: "home_feed",
        watchedAt: "2026-09-01T10:00:00+09:00",
      },
      {
        eventId: "e2",
        resumedFromEventId: "e1",
        referrerType: "unknown",
        watchedAt: "2026-09-01T10:30:00+09:00",
      },
      {
        eventId: "e3",
        referrerType: "related",
        watchedAt: "2026-09-01T11:00:00+09:00",
      },
    ];

    expect(compositionByPeriod(events, INSTALL)[1]).toMatchObject({
      total: 2,
      home_feed: 0.5,
      related: 0.5,
      unknown: 0,
    });
  });

  it("연결 없는 기록은 지금처럼 하나씩 세고, 기록이 없는 기간은 null이다", () => {
    const events = [
      {
        eventId: "e1",
        referrerType: "home_feed",
        watchedAt: "2026-09-01T10:00:00+09:00",
      },
      {
        eventId: "e2",
        referrerType: null,
        watchedAt: "2026-09-01T10:30:00+09:00",
      },
    ];
    const byPeriod = compositionByPeriod(events, INSTALL);

    expect(byPeriod[1]).toMatchObject({
      total: 2,
      home_feed: 0.5,
      unknown: 0.5,
    });
    expect(byPeriod[2]).toBeNull();
  });
});
