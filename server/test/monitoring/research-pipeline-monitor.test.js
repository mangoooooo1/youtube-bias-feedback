import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluatePipelineHealth } from "../../monitoring/research-pipeline-monitor.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
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
      lastEvaluatedAt: 1000,
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

  it("비교할 만큼 오래된 참여자가 없을 때, 직전 평가로부터 충분히(윈도우 절반 이상) 지난 연속 2회째 침묵이면 alert다", () => {
    const now = 1 * DAY;
    const result = evaluatePipelineHealth({
      now,
      events: [],
      hasParticipants: true,
      hasWeekOldParticipant: false,
      consecutiveZero: 1, // 직전 실행에서 이미 1회 침묵
      lastEvaluatedAt: now - 6 * HOUR, // 정상적인 6시간 간격 재실행
    });
    expect(result.status).toBe("alert");
    expect(result.reason).toBe("flatline_consecutive_windows");
    expect(result.consecutiveZero).toBe(2);
  });

  it("직전 평가로부터 너무 짧은 간격(예: 수동 재실행)으로 다시 실행되면 카운터를 증가시키지 않는다(허위 경보 방지)", () => {
    const now = 1 * DAY;
    const result = evaluatePipelineHealth({
      now,
      events: [],
      hasParticipants: true,
      hasWeekOldParticipant: false,
      consecutiveZero: 1, // 직전 실행에서 이미 1회 침묵로 카운트됨
      lastEvaluatedAt: now - 5 * MINUTE, // 몇 분 전에 막 실행됐음(같은 창 안 재실행)
    });
    expect(result.status).toBe("warn_pending");
    expect(result.consecutiveZero).toBe(1); // 증가하지 않고 그대로
  });

  it("직전 평가 시각이 없으면(최초 실행) 첫 침묵을 정상적으로 1로 센다", () => {
    const now = 1 * DAY;
    const result = evaluatePipelineHealth({
      now,
      events: [],
      hasParticipants: true,
      hasWeekOldParticipant: false,
      consecutiveZero: 0,
      lastEvaluatedAt: null,
    });
    expect(result.status).toBe("warn_pending");
    expect(result.consecutiveZero).toBe(1);
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

  it("video_events.watchedAt에 타임존 오프셋이 섞여도 절대 시각 기준으로 비교한다(문자열 비교 시 오탐 방지)", () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
    ).run("p1", "EXP", "2026-01-01T00:00:00Z");

    const now = Date.parse("2026-08-30T12:00:00Z");
    const lookbackMs = 6 * HOUR; // cutoff = 2026-08-30T06:00:00.000Z

    // 절대 시각으로는 cutoff보다 1시간 이른(윈도우 밖) 이벤트지만, +09:00 오프셋 때문에
    // 원본 문자열의 시(時) 자릿수가 커서("14" > "06") 단순 문자열 비교로는 윈도우 안으로
    // 잘못 걸린다 — julianday() 정규화 비교가 아니면 이 테스트는 실패한다.
    db.prepare(
      "INSERT INTO video_events (anonymousId, videoId, watchedAt) VALUES (?, ?, ?)",
    ).run("p1", "v-offset", "2026-08-30T14:00:00+09:00"); // = 2026-08-30T05:00:00Z

    const { events } = collectRecentActivity(db, now, lookbackMs);

    expect(events).toHaveLength(0);
  });
});
