import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import crypto from "crypto";
import {
  run,
  evaluateParticipantSilence,
  collectParticipantActivity,
  parseThresholdArg,
  DEFAULT_THRESHOLD_DAYS,
} from "../../scripts/participant-silence-report.js";

const DAY = 24 * 60 * 60 * 1000;
const TOTAL_DAYS = 6; // server/pipeline/study-constants.js의 파일럿 값과 동일

function sha10(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 10);
}

describe("evaluateParticipantSilence — 순수 판정 로직", () => {
  it("연구 기간이 이미 끝난 참여자는 조용해도 정상(study_ended)으로 본다", () => {
    const now = 100 * DAY;
    const installDateMs = now - (TOTAL_DAYS + 1) * DAY; // 이미 연구 종료
    const result = evaluateParticipantSilence({
      now,
      installDateMs,
      lastActivityMs: installDateMs, // 설치일 이후 활동 없음
      totalDays: TOTAL_DAYS,
    });
    expect(result).toMatchObject({ flagged: false, reason: "study_ended" });
  });

  it("최근 활동이 임계값 이내면 정상이다", () => {
    const now = 100 * DAY;
    const installDateMs = now - 1 * DAY;
    const result = evaluateParticipantSilence({
      now,
      installDateMs,
      lastActivityMs: now - 1 * DAY, // 1일 전 활동
      totalDays: TOTAL_DAYS,
      thresholdDays: 3,
    });
    expect(result.flagged).toBe(false);
    expect(result.everActive).toBe(true);
  });

  it("최근 활동이 임계값을 넘으면 결측으로 플래그한다", () => {
    const now = 100 * DAY;
    const installDateMs = now - 1 * DAY;
    const result = evaluateParticipantSilence({
      now,
      installDateMs,
      lastActivityMs: now - 3 * DAY,
      totalDays: TOTAL_DAYS,
      thresholdDays: 3,
    });
    expect(result.flagged).toBe(true);
    expect(result.daysSinceActivity).toBeCloseTo(3, 5);
    expect(result.everActive).toBe(true);
  });

  it("경계값(정확히 임계값 일수)은 결측으로 플래그한다(>=)", () => {
    const now = 100 * DAY;
    const installDateMs = now - 1 * DAY;
    const result = evaluateParticipantSilence({
      now,
      installDateMs,
      lastActivityMs: now - 3 * DAY,
      totalDays: TOTAL_DAYS,
      thresholdDays: 3,
    });
    expect(result.flagged).toBe(true);
  });

  it("활동이 한 번도 없으면 설치일을 기준점으로 삼는다", () => {
    const now = 100 * DAY;
    const installDateMs = now - 4 * DAY; // 아직 연구 기간 중, 설치 후 4일째
    const result = evaluateParticipantSilence({
      now,
      installDateMs,
      lastActivityMs: null,
      totalDays: TOTAL_DAYS,
      thresholdDays: 3,
    });
    expect(result.flagged).toBe(true);
    expect(result.everActive).toBe(false);
    expect(result.daysSinceActivity).toBeCloseTo(4, 5);
  });

  it("기본 임계값은 3일이다", () => {
    expect(DEFAULT_THRESHOLD_DAYS).toBe(3);
  });
});

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL UNIQUE,
      participantCode TEXT,
      group_code TEXT NOT NULL,
      installDate TEXT NOT NULL
    );
    CREATE TABLE video_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      watchedAt TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function insertParticipant(
  db,
  { anonymousId, participantCode = null, groupCode, installDate },
) {
  db.prepare(
    "INSERT INTO participants (anonymousId, participantCode, group_code, installDate) VALUES (?, ?, ?, ?)",
  ).run(anonymousId, participantCode, groupCode, installDate);
}

function insertVideoEvent(db, anonymousId, watchedAt) {
  db.prepare(
    "INSERT INTO video_events (anonymousId, watchedAt) VALUES (?, ?)",
  ).run(anonymousId, watchedAt);
}

function insertSession(db, anonymousId, createdAt) {
  db.prepare("INSERT INTO sessions (anonymousId, createdAt) VALUES (?, ?)").run(
    anonymousId,
    createdAt,
  );
}

describe("collectParticipantActivity — DB 조회", () => {
  let db;
  afterEach(() => db?.close());

  it("TEST 그룹 참여자는 제외한다", () => {
    db = createTestDb();
    insertParticipant(db, {
      anonymousId: "test-user",
      groupCode: "TEST-EXP",
      installDate: "2026-06-01T00:00:00+09:00",
    });
    insertParticipant(db, {
      anonymousId: "real-user",
      groupCode: "EXP",
      installDate: "2026-06-01T00:00:00+09:00",
    });
    const rows = collectParticipantActivity(db);
    expect(rows.map((r) => r.anonymousId)).toEqual(["real-user"]);
  });

  it("video_events.watchedAt(오프셋 포함)과 sessions.createdAt(공백 구분) 중 더 최근인 쪽을 고른다", () => {
    db = createTestDb();
    insertParticipant(db, {
      anonymousId: "u1",
      groupCode: "EXP",
      installDate: "2026-06-01T00:00:00+09:00",
    });
    // video_events가 더 이름(더 늦은 시각) — 오프셋 표기 포함
    insertVideoEvent(db, "u1", "2026-06-05T23:00:00+09:00");
    // sessions.createdAt은 SQLite datetime('now') 형식(UTC, 공백 구분, 오프셋 없음)
    insertSession(db, "u1", "2026-06-05 10:00:00");

    const rows = collectParticipantActivity(db);
    const row = rows[0];
    // video_events(23:00 KST = 14:00 UTC)가 sessions(10:00 UTC)보다 늦다
    expect(Number(row.lastVideoTs)).toBeGreaterThan(Number(row.lastSessionTs));
  });

  it("활동이 전혀 없는 참여자는 두 값 다 null이다", () => {
    db = createTestDb();
    insertParticipant(db, {
      anonymousId: "u1",
      groupCode: "EXP",
      installDate: "2026-06-01T00:00:00+09:00",
    });
    const rows = collectParticipantActivity(db);
    expect(rows[0].lastVideoTs).toBeNull();
    expect(rows[0].lastSessionTs).toBeNull();
  });
});

describe("run", () => {
  let db;
  let logSpy;

  beforeEach(() => {
    db = createTestDb();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    logSpy.mockRestore();
  });

  function loggedOutput() {
    return logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
  }

  it("결측 참여자가 없으면 통과 메시지만 출력한다", () => {
    const now = Date.now();
    insertParticipant(db, {
      anonymousId: "u1",
      groupCode: "EXP",
      installDate: new Date(now - 1 * DAY).toISOString(),
    });
    insertVideoEvent(db, "u1", new Date(now - 1 * 3600 * 1000).toISOString());

    const result = run(db, { now, thresholdDays: 3 });

    expect(result).toEqual({ flaggedCount: 0, checkedCount: 1 });
    expect(loggedOutput()).toContain("결측 의심 참여자 없음");
  });

  it("임계값을 넘은 참여자를 찾아 지문과 함께 출력한다", () => {
    const now = Date.now();
    insertParticipant(db, {
      anonymousId: "silent-user",
      participantCode: "QWE-K7M2",
      groupCode: "EXP",
      installDate: new Date(now - 1 * DAY).toISOString(),
    });
    insertVideoEvent(db, "silent-user", new Date(now - 4 * DAY).toISOString());

    const result = run(db, { now, thresholdDays: 3 });

    expect(result).toEqual({ flaggedCount: 1, checkedCount: 1 });
    const output = loggedOutput();
    expect(output).toContain("결측 의심 참여자 1명 발견");
    expect(output).toContain(`participantCode(지문)=${sha10("QWE-K7M2")}`);
    expect(output).toContain(sha10("silent-user"));
    expect(output).toContain("마지막 활동으로부터");
  });

  it("연구 기간이 끝난 참여자는 조용해도 목록에서 제외한다", () => {
    const now = Date.now();
    insertParticipant(db, {
      anonymousId: "finished-user",
      groupCode: "EXP",
      installDate: new Date(now - (TOTAL_DAYS + 5) * DAY).toISOString(),
    });
    // 활동 자체가 없음 — 하지만 이미 연구가 끝났으므로 결측으로 잡히면 안 된다

    const result = run(db, { now, thresholdDays: 3 });

    expect(result.flaggedCount).toBe(0);
  });

  it("출력에 원본 anonymousId/participantCode가 그대로 노출되지 않는다", () => {
    const now = Date.now();
    insertParticipant(db, {
      anonymousId: "sensitive-anon-id",
      participantCode: "SECRET-CODE-1",
      groupCode: "CON",
      installDate: new Date(now - 4 * DAY).toISOString(),
    });
    // 활동 없음(설치 후 4일 경과, 임계값 3일) → 결측 플래그

    run(db, { now, thresholdDays: 3 });

    const output = loggedOutput();
    expect(output).toContain(sha10("sensitive-anon-id"));
    expect(output).not.toContain("sensitive-anon-id");
    expect(output).not.toContain("SECRET-CODE-1");
  });

  it("TEST 그룹은 결측이어도 리포트 대상에서 제외한다", () => {
    const now = Date.now();
    insertParticipant(db, {
      anonymousId: "test-user",
      groupCode: "TEST-EXP",
      installDate: new Date(now - 1 * DAY).toISOString(),
    });

    const result = run(db, { now, thresholdDays: 3 });

    expect(result).toEqual({ flaggedCount: 0, checkedCount: 0 });
  });
});

describe("parseThresholdArg — CLI 인수 검증", () => {
  it("인수가 없으면 기본값을 쓴다", () => {
    expect(parseThresholdArg(undefined)).toBe(DEFAULT_THRESHOLD_DAYS);
  });

  it("양의 정수 인수를 그대로 쓴다", () => {
    expect(parseThresholdArg("5")).toBe(5);
  });

  it("빈 문자열은 거부한다(Number('')는 0이라 Number.isFinite만으로는 안 걸러짐)", () => {
    expect(() => parseThresholdArg("")).toThrow();
  });

  it("0은 거부한다(daysSinceActivity >= 0은 거의 항상 참이라 전원 결측 오판정으로 이어짐)", () => {
    expect(() => parseThresholdArg("0")).toThrow();
  });

  it("음수는 거부한다", () => {
    expect(() => parseThresholdArg("-1")).toThrow();
  });

  it("숫자가 아닌 문자열은 거부한다", () => {
    expect(() => parseThresholdArg("abc")).toThrow();
  });
});
