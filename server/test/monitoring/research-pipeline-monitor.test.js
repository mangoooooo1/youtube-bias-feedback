import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluatePipelineHealth } from "../../monitoring/research-pipeline-monitor.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("evaluatePipelineHealth — 순수 판정 로직", () => {
  it("등록된 참여자가 없으면 항상 skipped(정상 취급)다", () => {
    const result = evaluatePipelineHealth({
      now: 1000,
      events: [],
      hasParticipants: false,
    });
    expect(result).toEqual({
      status: "skipped",
      reason: "no_participants",
      consecutiveZero: 0,
    });
  });

  it("최근 6시간 안에 이벤트가 있으면 정상이다", () => {
    const now = 10 * DAY;
    const result = evaluatePipelineHealth({
      now,
      events: [now - HOUR],
      hasParticipants: true,
    });
    expect(result.status).toBe("ok");
    expect(result.currentCount).toBe(1);
    expect(result.consecutiveZero).toBe(0);
  });

  it("현재 0건이고 7일 전 같은 시간대엔 활동이 있었으면 alert다(전체 침묵 의심)", () => {
    const now = 10 * DAY;
    const sevenDaysAgoActivity = now - 7 * DAY - 2 * HOUR; // 현재 윈도우(-6h~now)의 7일 전 대응 구간 안
    const result = evaluatePipelineHealth({
      now,
      events: [sevenDaysAgoActivity],
      hasParticipants: true,
      hasWeekOldParticipant: true,
    });
    expect(result.status).toBe("alert");
    expect(result.reason).toBe("flatline_vs_7_days_ago");
    expect(result.compareCount).toBe(1);
  });

  it("현재 0건이지만 7일 전 같은 시간대도 원래 조용했으면 정상으로 간주한다(오탐 방지)", () => {
    const now = 10 * DAY;
    const result = evaluatePipelineHealth({
      now,
      events: [], // 비교 구간에도 이벤트 없음
      hasParticipants: true,
      hasWeekOldParticipant: true, // 비교할 참여자 히스토리는 있음
    });
    expect(result.status).toBe("ok");
    expect(result.consecutiveZero).toBe(0);
  });

  it("비교할 만큼 오래된 참여자가 없을 때(연구 시작 초반) 1회 침묵은 warn_pending일 뿐 알리지 않는다", () => {
    const now = 1 * DAY; // 아직 7일이 안 지난 이른 시점
    const result = evaluatePipelineHealth({
      now,
      events: [],
      hasParticipants: true,
      hasWeekOldParticipant: false,
      consecutiveZero: 0,
    });
    expect(result.status).toBe("warn_pending");
    expect(result.consecutiveZero).toBe(1);
  });

  it("비교할 만큼 오래된 참여자가 없을 때 연속 2회(12시간) 침묵이면 alert다", () => {
    const now = 1 * DAY;
    const result = evaluatePipelineHealth({
      now,
      events: [],
      hasParticipants: true,
      hasWeekOldParticipant: false,
      consecutiveZero: 1, // 직전 실행에서 이미 1회 침묵
    });
    expect(result.status).toBe("alert");
    expect(result.reason).toBe("flatline_consecutive_windows");
    expect(result.consecutiveZero).toBe(2);
  });

  it("침묵 이후 활동이 재개되면 consecutiveZero가 0으로 리셋된다", () => {
    const now = 1 * DAY;
    const result = evaluatePipelineHealth({
      now,
      events: [now - HOUR],
      hasParticipants: true,
      hasWeekOldParticipant: false,
      consecutiveZero: 1,
    });
    expect(result.status).toBe("ok");
    expect(result.consecutiveZero).toBe(0);
  });
});

// collectRecentActivity는 실제 SQL(datetime() 정규화 포함)이 올바르게 동작하는지가
// 핵심이라, db.test.js/sessions.wiring.test.js와 동일하게 실제 better-sqlite3 인스턴스로
// 검증한다(가짜 DB 객체로는 SQL 문법 오류나 포맷 불일치를 잡아낼 수 없음).
describe("collectRecentActivity — 실제 DB 배선", () => {
  const require = createRequire(import.meta.url);
  const TEST_DB_PATH = path.join(
    os.tmpdir(),
    `viewlens-pipeline-monitor-${process.pid}.db`,
  );
  fs.rmSync(TEST_DB_PATH, { force: true });
  process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
  process.env.DB_PATH = TEST_DB_PATH;

  const { db, initializeDB } = require("../../db.js");
  initializeDB();
  const { collectRecentActivity } = require("../../monitoring/research-pipeline-monitor.js");

  afterAll(() => {
    db.close();
    fs.rmSync(TEST_DB_PATH, { force: true });
  });

  beforeEach(() => {
    db.exec("DELETE FROM participants");
    db.exec("DELETE FROM video_events");
    db.exec("DELETE FROM sessions");
  });

  function toSqliteDatetime(ms) {
    return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  }

  it("참여자가 없으면 hasParticipants=false다", () => {
    const { hasParticipants } = collectRecentActivity(db, Date.now(), 7 * DAY);
    expect(hasParticipants).toBe(false);
  });

  it("모든 참여자가 설치한 지 7일이 안 됐으면 hasWeekOldParticipant=false다", () => {
    const now = Date.parse("2026-08-30T12:00:00Z");
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
    ).run("p1", "EXP", new Date(now - 3 * DAY).toISOString());

    const { hasParticipants, hasWeekOldParticipant } = collectRecentActivity(
      db,
      now,
      7 * DAY + 6 * HOUR,
    );

    expect(hasParticipants).toBe(true);
    expect(hasWeekOldParticipant).toBe(false);
  });

  it("설치한 지 7일 이상 된 참여자가 있으면 hasWeekOldParticipant=true다", () => {
    const now = Date.parse("2026-08-30T12:00:00Z");
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
    ).run("p1", "EXP", new Date(now - 8 * DAY).toISOString());

    const { hasWeekOldParticipant } = collectRecentActivity(
      db,
      now,
      7 * DAY + 6 * HOUR,
    );

    expect(hasWeekOldParticipant).toBe(true);
  });

  it("video_events(ISO 문자열)와 sessions(SQLite datetime 문자열)를 모두 epoch ms로 모은다", () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
    ).run("p1", "EXP", "2026-01-01T00:00:00Z");

    const now = Date.parse("2026-08-30T12:00:00Z");
    const withinWindowIso = new Date(now - 2 * HOUR).toISOString();
    const outsideLookbackIso = new Date(now - 10 * DAY).toISOString();

    db.prepare(
      "INSERT INTO video_events (anonymousId, videoId, watchedAt) VALUES (?, ?, ?)",
    ).run("p1", "v1", withinWindowIso);
    db.prepare(
      "INSERT INTO video_events (anonymousId, videoId, watchedAt) VALUES (?, ?, ?)",
    ).run("p1", "v2", outsideLookbackIso);

    db.prepare(
      `INSERT INTO sessions (anonymousId, sessionId, startTime, endTime, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "p1",
      "s1",
      withinWindowIso,
      withinWindowIso,
      toSqliteDatetime(now - 3 * HOUR),
    );

    const lookbackMs = 7 * DAY + 6 * HOUR;
    const { hasParticipants, events } = collectRecentActivity(
      db,
      now,
      lookbackMs,
    );

    expect(hasParticipants).toBe(true);
    // 윈도우 안의 video_events 1건 + sessions 1건만 포함되고, 10일 전 video_events는 제외된다.
    expect(events).toHaveLength(2);
    expect(events.every((ts) => ts >= now - lookbackMs)).toBe(true);
  });
});
