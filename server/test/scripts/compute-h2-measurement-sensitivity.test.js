import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3-multiple-ciphers";
import {
  VARIANTS,
  computePeriodMeasurementSensitivity,
  run,
  main,
} from "../../scripts/compute-h2-measurement-sensitivity.js";
import { aggregateViewing } from "../../pipeline/viewing-aggregate.js";
import { TOTAL_PERIODS, periodDay } from "../study-schedule-fixtures.js";

const entry = (categoryId, watchedSeconds, durationSeconds = 100) => ({
  categoryId,
  watchedSeconds,
  durationSeconds,
});

const SCHEMA = `
  CREATE TABLE participants (anonymousId TEXT, group_code TEXT, installDate TEXT);
  CREATE TABLE video_events (
    anonymousId TEXT, videoId TEXT, watchedAt TEXT, watchedSeconds REAL,
    wasBackgrounded INTEGER, referrerType TEXT, relatedTrigger TEXT,
    eventId TEXT, resumedFromEventId TEXT
  );
  CREATE TABLE video_metadata (videoId TEXT PRIMARY KEY, categoryId TEXT, durationSeconds INTEGER);
`;

describe("computePeriodMeasurementSensitivity — 기간 하나의 계산", () => {
  const entries = [
    entry("10", 400), // 길이보다 오래 봄 → 상한 여부에 따라 가중치가 다름
    entry("17", 100, 600),
    entry("20", 20), // 20% → 10% 기준에서만 유효
  ];

  it("주 분석은 옵션 없는 aggregateViewing, 각 조건은 그 옵션을 넘긴 값과 같다", () => {
    const r = computePeriodMeasurementSensitivity(entries);
    expect(r.weightedEntropy).toBe(aggregateViewing(entries).weightedEntropy);
    for (const [name, options] of Object.entries(VARIANTS)) {
      const expected = aggregateViewing(entries, options);
      expect(r[name]).toEqual({
        validCount: expected.validCount,
        weightedEntropy: expected.weightedEntropy,
      });
    }
  });

  it("상대 기준이 바뀌면 조건마다 유효 영상 수가 달라진다", () => {
    const r = computePeriodMeasurementSensitivity(entries);
    expect(r.validCount).toBe(2);
    expect(r.noWatchCap.validCount).toBe(2);
    expect(r.relativeCutoff10.validCount).toBe(3);
    expect(r.relativeCutoff50.validCount).toBe(2);
    expect(r.noWatchCap.weightedEntropy).not.toBe(r.weightedEntropy);
  });

  it("영상이 없으면 모든 조건의 weightedEntropy가 null이다", () => {
    const r = computePeriodMeasurementSensitivity([]);
    expect(r.weightedEntropy).toBeNull();
    for (const name of Object.keys(VARIANTS)) {
      expect(r[name]).toEqual({ validCount: 0, weightedEntropy: null });
    }
  });
});

describe("computePeriodMeasurementSensitivity — 백그라운드 전환 기록 상한 조건", () => {
  const HOUR = 3600;
  // 백그라운드 게임 5시간(길이 6시간) + 화면 음악 1시간
  const entries = [
    {
      categoryId: "20",
      watchedSeconds: 5 * HOUR,
      durationSeconds: 6 * HOUR,
      wasBackgrounded: 1,
    },
    {
      categoryId: "10",
      watchedSeconds: 1 * HOUR,
      durationSeconds: 2 * HOUR,
      wasBackgrounded: 0,
    },
  ];

  it("조건 이름은 사전등록한 민감도 분석 목록과 같다", () => {
    expect(Object.keys(VARIANTS)).toEqual([
      "noWatchCap",
      "relativeCutoff10",
      "relativeCutoff50",
      "backgroundCap1h",
      "backgroundCap2h",
      "backgroundCap4h",
      "backgroundZero",
    ]);
  });

  it("각 조건은 그 옵션을 넘긴 aggregateViewing 값과 같고, 유효 영상 수는 모두 같다", () => {
    const r = computePeriodMeasurementSensitivity(entries);
    for (const [name, options] of Object.entries(VARIANTS)) {
      const expected = aggregateViewing(entries, options);
      expect(r[name]).toEqual({
        validCount: expected.validCount,
        weightedEntropy: expected.weightedEntropy,
      });
      expect(r[name].validCount).toBe(2);
    }
  });

  it("백그라운드 상한이 낮을수록 시간 가중치가 고르고, 시간 기여 0은 그 기록을 뺀 값과 같다", () => {
    const r = computePeriodMeasurementSensitivity(entries);
    // 게임 비중: 1시간 50% · 2시간 67% · 3시간(주 분석) 75% · 4시간 80% · 상한 없음 83%
    expect(r.backgroundCap1h.weightedEntropy).toBeGreaterThan(
      r.backgroundCap2h.weightedEntropy,
    );
    expect(r.backgroundCap2h.weightedEntropy).toBeGreaterThan(
      r.weightedEntropy,
    );
    expect(r.weightedEntropy).toBeGreaterThan(
      r.backgroundCap4h.weightedEntropy,
    );
    expect(r.backgroundCap4h.weightedEntropy).toBeGreaterThan(
      r.noWatchCap.weightedEntropy,
    );
    expect(r.backgroundZero.weightedEntropy).toBe(
      aggregateViewing(entries.filter((e) => e.wasBackgrounded !== 1))
        .weightedEntropy,
    );
    expect(r.backgroundZero.weightedEntropy).toBe(0);
  });
});

describe("run — DB 조회", () => {
  let db;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(SCHEMA);
    db.prepare("INSERT INTO participants VALUES (?,?,?)").run(
      "anon-exp",
      "EXP",
      "2026-08-31T15:00:00.000Z",
    );
    db.prepare("INSERT INTO video_metadata VALUES (?,?,?)").run(
      "v1",
      "10",
      100,
    );
    db.prepare(
      "INSERT INTO video_events (anonymousId, videoId, watchedAt, watchedSeconds, wasBackgrounded, referrerType, relatedTrigger) VALUES (?,?,?,?,?,?,?)",
    ).run(
      "anon-exp",
      "v1",
      "2026-09-02T10:00:00+09:00",
      20,
      0,
      "home_feed",
      null,
    );
  });
  afterEach(() => db.close());

  it("완료된 기간마다 행을 만들고 영상에 길이를 붙여 판정한다", () => {
    const { rows } = run(db, {
      groups: ["EXP", "CON"],
      // 3구간 둘째 날이면 1·2구간만 끝났다
      now: new Date(
        `${periodDay("2026-08-31T15:00:00.000Z", 3, 1)}T12:00:00+09:00`,
      ),
    });
    expect(rows.map((r) => r.periodIndex)).toEqual([1, 2]);
    // 길이 100초 중 20초 → 25% 기준은 무효, 10% 기준은 유효
    expect(rows[0].validCount).toBe(0);
    expect(rows[0].relativeCutoff10.validCount).toBe(1);
    expect(rows[0].participant).toMatch(/^[0-9a-f]{10}$/);
    expect(JSON.stringify(rows)).not.toContain("anon-exp");
  });
});

describe("main — 암호화 DB 파일로 실행", () => {
  const KEY = "test-key";
  let dir;
  let dbPath;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "h2-measurement-"));
    dbPath = path.join(dir, "test.db");
    const db = new Database(dbPath);
    db.pragma("cipher = 'sqlcipher'");
    db.key(Buffer.from(KEY));
    db.exec(SCHEMA);
    db.exec(
      "INSERT INTO participants VALUES ('anon-1', 'CON', '2026-01-01T00:00:00.000Z')",
    );
    db.close();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("기본 그룹(EXP·CON)으로 계산해 JSON으로 저장한다", () => {
    const outPath = main({
      argv: [dbPath],
      env: { DB_ENCRYPTION_KEY: KEY },
      outDir: path.join(dir, "out"),
    });
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(report.groups).toEqual(["EXP", "CON"]);
    expect(report.rows).toHaveLength(TOTAL_PERIODS);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(`참여자 1명, 기간 ${TOTAL_PERIODS}행`),
    );
  });

  it("DB 파일이 없거나 키가 없으면 저장하지 않고 실패로 끝난다", () => {
    expect(
      main({
        argv: [path.join(dir, "none.db")],
        env: { DB_ENCRYPTION_KEY: KEY },
      }),
    ).toBeNull();
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    expect(main({ argv: [], env: { SOURCE_DB_PATH: dbPath } })).toBeNull();
    expect(process.exitCode).toBe(1);
  });
});

describe("run — 멈췄다 이어 본 기록", () => {
  it("DB에서 연결 칸을 읽어 이어진 두 조각(각 20초)을 한 시청으로 합쳐 유효 영상 1건으로 센다", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    db.prepare("INSERT INTO participants VALUES (?,?,?)").run(
      "anon-exp",
      "EXP",
      "2026-08-31T15:00:00.000Z",
    );
    db.prepare("INSERT INTO video_metadata VALUES (?,?,?)").run(
      "v1",
      "10",
      600,
    );
    const insert = db.prepare(
      "INSERT INTO video_events (eventId, resumedFromEventId, anonymousId, videoId, watchedAt, watchedSeconds) VALUES (?,?,?,?,?,?)",
    );
    insert.run("e1", null, "anon-exp", "v1", "2026-09-02T10:00:00+09:00", 20);
    insert.run("e2", "e1", "anon-exp", "v1", "2026-09-02T10:30:00+09:00", 20);

    const { rows } = run(db, {
      groups: ["EXP"],
      now: new Date("2026-09-10T12:00:00+09:00"),
    });
    db.close();

    // 조각마다는 20초(600초의 3%)라 잠깐 본 영상이지만, 합치면 40초라 유효하다
    expect(rows[0].validCount).toBe(1);
    for (const name of Object.keys(VARIANTS)) {
      expect(rows[0][name].validCount).toBe(1);
    }
  });
});

describe("run — 백그라운드 전환 기록", () => {
  it("DB의 백그라운드 전환 여부를 읽어 상한 조건마다 값이 갈린다", () => {
    const HOUR = 3600;
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    db.prepare("INSERT INTO participants VALUES (?,?,?)").run(
      "anon-exp",
      "EXP",
      "2026-08-31T15:00:00.000Z",
    );
    db.prepare("INSERT INTO video_metadata VALUES (?,?,?)").run(
      "game",
      "20",
      6 * HOUR,
    );
    db.prepare("INSERT INTO video_metadata VALUES (?,?,?)").run(
      "music",
      "10",
      2 * HOUR,
    );
    const insert = db.prepare(
      "INSERT INTO video_events (anonymousId, videoId, watchedAt, watchedSeconds, wasBackgrounded) VALUES (?,?,?,?,?)",
    );
    insert.run("anon-exp", "game", "2026-09-02T01:00:00+09:00", 5 * HOUR, 1);
    insert.run("anon-exp", "music", "2026-09-02T12:00:00+09:00", 1 * HOUR, 0);

    const { rows } = run(db, {
      groups: ["EXP"],
      now: new Date("2026-09-10T12:00:00+09:00"),
    });
    db.close();

    expect(rows[0].backgroundCap1h.weightedEntropy).toBeGreaterThan(
      rows[0].weightedEntropy,
    );
    expect(rows[0].backgroundZero.weightedEntropy).toBe(0);
  });
});
