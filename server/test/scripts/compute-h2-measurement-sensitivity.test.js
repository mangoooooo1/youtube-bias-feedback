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

const entry = (categoryId, watchedSeconds, durationSeconds = 100) => ({
  categoryId,
  watchedSeconds,
  durationSeconds,
});

const SCHEMA = `
  CREATE TABLE participants (anonymousId TEXT, group_code TEXT, installDate TEXT);
  CREATE TABLE video_events (
    anonymousId TEXT, videoId TEXT, watchedAt TEXT, watchedSeconds REAL,
    wasBackgrounded INTEGER, referrerType TEXT, relatedTrigger TEXT
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
    db.prepare("INSERT INTO video_events VALUES (?,?,?,?,?,?,?)").run(
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
      now: new Date("2026-09-10T12:00:00+09:00"),
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
    expect(report.rows).toHaveLength(3);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("참여자 1명, 기간 3행"),
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
