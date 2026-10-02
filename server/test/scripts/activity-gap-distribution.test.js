import { describe, it, expect, afterEach, beforeEach } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  computeGaps,
  summarizeGaps,
  run,
} from "../../scripts/activity-gap-distribution.js";

const DAY = 24 * 60 * 60 * 1000;
const INSTALL = Date.parse("2026-09-01T00:00:00Z");

describe("computeGaps — 한 참여자의 활동 간격", () => {
  it("설치일 → 첫 활동, 이후 연속 활동 사이 간격을 시간순으로 돌려준다", () => {
    const gaps = computeGaps(INSTALL, [
      INSTALL + 3 * DAY,
      INSTALL + 0.5 * DAY,
      INSTALL + 1 * DAY,
    ]);
    expect(gaps).toEqual([0.5, 0.5, 2]);
  });

  it("마지막 활동 이후 공백은 넣지 않는다", () => {
    expect(computeGaps(INSTALL, [INSTALL + 1 * DAY])).toEqual([1]);
  });

  it("활동이 없으면 빈 배열이다", () => {
    expect(computeGaps(INSTALL, [])).toEqual([]);
  });

  it("연구 기간 밖(설치 전·종료 후) 활동은 뺀다", () => {
    const gaps = computeGaps(
      INSTALL,
      [INSTALL - 1 * DAY, INSTALL + 2 * DAY, INSTALL + 12 * DAY],
      12,
    );
    expect(gaps).toEqual([2]);
  });
});

describe("summarizeGaps — 분포 요약", () => {
  it("참여자별 최대 간격과 임계값 후보별 판정 수를 센다", () => {
    const s = summarizeGaps([[0.5, 2.5], [1, 4], []], [3]);
    expect(s.participantCount).toBe(3);
    expect(s.noActivityCount).toBe(1);
    expect(s.gapCount).toBe(4);
    expect(s.allGaps.max).toBe(4);
    expect(s.maxGapPerParticipant).toEqual([2.5, 4]);
    expect(s.byThreshold).toEqual([
      { thresholdDays: 3, gapsAtOrAbove: 1, participantsAtOrAbove: 1 },
    ]);
  });

  it("간격이 하나도 없으면 분위수는 null이다", () => {
    const s = summarizeGaps([[]], [3]);
    expect(s.allGaps).toEqual({ p50: null, p90: null, p95: null, max: null });
  });
});

describe("run — DB 조회", () => {
  let db;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE participants (anonymousId TEXT, participantCode TEXT, group_code TEXT, installDate TEXT);
      CREATE TABLE video_events (anonymousId TEXT, watchedAt TEXT);
      CREATE TABLE sessions (anonymousId TEXT, createdAt TEXT);
    `);
  });
  afterEach(() => db.close());

  it("ISO·공백 구분 형식을 섞어도 간격을 계산하고 TEST 그룹은 뺀다", () => {
    db.prepare("INSERT INTO participants VALUES (?,?,?,?)").run(
      "anon-1",
      "ABC-1234",
      "EXP",
      "2026-09-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO participants VALUES (?,?,?,?)").run(
      "anon-test",
      "TEST-EXP",
      "TEST-EXP",
      "2026-09-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO video_events VALUES (?,?)").run(
      "anon-1",
      "2026-09-02T09:00:00+09:00", // = 09-02 00:00 UTC
    );
    db.prepare("INSERT INTO sessions VALUES (?,?)").run(
      "anon-1",
      "2026-09-04 00:00:00",
    );
    db.prepare("INSERT INTO video_events VALUES (?,?)").run(
      "anon-test",
      "2026-09-10T00:00:00Z",
    );

    const s = run(db);
    expect(s.participantCount).toBe(1);
    expect(s.maxGapPerParticipant).toEqual([2]);
    expect(s.gapCount).toBe(2);
  });

  it("요약 결과에 참여자 식별자가 들어가지 않는다", () => {
    db.prepare("INSERT INTO participants VALUES (?,?,?,?)").run(
      "anon-secret",
      "SEC-9999",
      "EXP",
      "2026-09-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO video_events VALUES (?,?)").run(
      "anon-secret",
      "2026-09-02T00:00:00Z",
    );
    const text = JSON.stringify(run(db));
    expect(text).not.toContain("anon-secret");
    expect(text).not.toContain("SEC-9999");
  });
});
