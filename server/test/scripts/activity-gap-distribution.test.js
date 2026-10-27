import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  computeGaps,
  summarizeGaps,
  run,
  printSummary,
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

  it("늦은 시각에 설치해도 확장이 수집을 멈춘 뒤(마지막 날 다음 날 00:00 KST)의 활동은 뺀다", () => {
    const install = Date.parse("2026-09-01T22:00:00+09:00");
    const collectionEndsAt = Date.parse("2026-09-13T00:00:00+09:00");
    const gaps = computeGaps(
      install,
      [install + 1 * DAY, collectionEndsAt + 60 * 60 * 1000],
      12,
    );
    expect(gaps).toEqual([1]);
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

// 결측 임계값을 정할 때 보는 터미널 요약
describe("printSummary — 터미널 요약", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("참여자·간격 수, 분위수, 참여자별 최대 간격, 임계값 후보별 판정 수를 순서대로 출력한다", () => {
    const logs = [];
    vi.spyOn(console, "log").mockImplementation((line) => logs.push(line));

    printSummary(summarizeGaps([[0.5, 2.5], [1, 4], []], [3, 5]));

    expect(logs).toEqual([
      "[activity-gap] 참여자 3명(연구 기간 중 활동 없음 1명), 간격 4개",
      expect.stringMatching(
        /^ {2}전체 간격\(일\): p50=\S+ p90=\S+ p95=\S+ max=4$/,
      ),
      "  참여자별 최대 간격(일, 오름차순): 2.5, 4",
      "  임계값 후보별 결측 판정 수:",
      "    3일: 간격 1개 / 참여자 1명",
      "    5일: 간격 0개 / 참여자 0명",
    ]);
  });
});
