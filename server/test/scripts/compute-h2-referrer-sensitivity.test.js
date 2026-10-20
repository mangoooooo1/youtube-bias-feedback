import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3-multiple-ciphers";
import {
  EXCLUSIONS,
  computePeriodSensitivity,
  completedPeriods,
  run,
  main,
  DEFAULT_GROUPS,
} from "../../scripts/compute-h2-referrer-sensitivity.js";
import { aggregateViewing } from "../../pipeline/viewing-aggregate.js";

// 유효 시청(30초 이상), 카테고리·길이 있음
const entry = (categoryId, extra = {}) => ({
  categoryId,
  durationSeconds: 600,
  watchedSeconds: 100,
  wasBackgrounded: 0,
  referrerType: "home_feed",
  relatedTrigger: null,
  ...extra,
});
const bgAutoplay = {
  wasBackgrounded: 1,
  referrerType: "related",
  relatedTrigger: "autoplay",
};

describe("EXCLUSIONS — 제외 조건", () => {
  it("backgroundAutoplay는 백그라운드 그리고 자동재생일 때만 뺀다", () => {
    const { backgroundAutoplay } = EXCLUSIONS;
    expect(backgroundAutoplay(entry("10", bgAutoplay))).toBe(true);
    expect(
      backgroundAutoplay(entry("10", { ...bgAutoplay, wasBackgrounded: 0 })),
    ).toBe(false);
    expect(
      backgroundAutoplay(
        entry("10", { ...bgAutoplay, relatedTrigger: "click" }),
      ),
    ).toBe(false);
    // 값을 모르면 빼지 않는다
    expect(
      backgroundAutoplay(entry("10", { ...bgAutoplay, wasBackgrounded: null })),
    ).toBe(false);
  });

  it("directSearch는 검색 유입만 뺀다", () => {
    expect(
      EXCLUSIONS.directSearch(entry("10", { referrerType: "direct_search" })),
    ).toBe(true);
    expect(
      EXCLUSIONS.directSearch(entry("10", { referrerType: "related" })),
    ).toBe(false);
    expect(EXCLUSIONS.directSearch(entry("10", { referrerType: null }))).toBe(
      false,
    );
  });
});

describe("computePeriodSensitivity — 기간 하나의 계산", () => {
  it("주 분석 값은 같은 영상으로 aggregateViewing을 돌린 값과 같다", () => {
    const entries = [entry("10"), entry("20"), entry("20", bgAutoplay)];
    const r = computePeriodSensitivity(entries);
    expect(r.weightedEntropy).toBe(aggregateViewing(entries).weightedEntropy);
    expect(r.validCount).toBe(3);
  });

  it("제외 조건에 걸린 영상만 빼고 다시 계산한다", () => {
    // 두 분야 같은 시간 → 제외하면 한 분야만 남아 entropy 0
    const entries = [
      entry("10"),
      entry("20", bgAutoplay),
      entry("20", { referrerType: "direct_search" }),
    ];
    const r = computePeriodSensitivity(entries);
    expect(r.weightedEntropy).toBeGreaterThan(0);
    expect(r.backgroundAutoplay.excludedCount).toBe(1);
    expect(r.backgroundAutoplay.weightedEntropy).toBe(
      aggregateViewing([entries[0], entries[2]]).weightedEntropy,
    );
    expect(r.directSearch.excludedCount).toBe(1);
    expect(r.directSearch.weightedEntropy).toBe(
      aggregateViewing([entries[0], entries[1]]).weightedEntropy,
    );
  });

  it("excludedCount는 잠깐 본 영상도 센다", () => {
    const r = computePeriodSensitivity([
      entry("10"),
      entry("20", { ...bgAutoplay, watchedSeconds: 5 }),
    ]);
    expect(r.validCount).toBe(1);
    expect(r.backgroundAutoplay.excludedCount).toBe(1);
  });

  it("영상이 없으면 weightedEntropy는 null이다", () => {
    expect(computePeriodSensitivity([])).toEqual({
      validCount: 0,
      weightedEntropy: null,
      backgroundAutoplay: { excludedCount: 0, weightedEntropy: null },
      directSearch: { excludedCount: 0, weightedEntropy: null },
    });
  });
});

describe("completedPeriods", () => {
  it("오늘(KST) 이전에 끝난 기간만 돌려준다", () => {
    // KST 09-01 설치, 4일 단위 → 1구간 09-01~09-04, 2구간 09-05~09-08
    const periods = completedPeriods(
      "2026-08-31T15:00:00.000Z",
      new Date("2026-09-10T00:00:00+09:00"),
    );
    expect(periods).toEqual([
      {
        periodIndex: 1,
        periodStart: "2026-09-01",
        periodEnd: "2026-09-04",
        isBaseline: 1,
      },
      {
        periodIndex: 2,
        periodStart: "2026-09-05",
        periodEnd: "2026-09-08",
        isBaseline: 0,
      },
    ]);
  });
});

describe("run — DB 조회", () => {
  let db;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE participants (anonymousId TEXT, group_code TEXT, installDate TEXT);
      CREATE TABLE video_events (
        anonymousId TEXT, videoId TEXT, watchedAt TEXT, watchedSeconds REAL,
        wasBackgrounded INTEGER, referrerType TEXT, relatedTrigger TEXT
      );
      CREATE TABLE video_metadata (videoId TEXT PRIMARY KEY, categoryId TEXT, durationSeconds INTEGER);
    `);
    const addP = db.prepare("INSERT INTO participants VALUES (?,?,?)");
    addP.run("anon-exp", "EXP", "2026-08-31T15:00:00.000Z");
    addP.run("anon-test", "TEST-EXP", "2026-08-31T15:00:00.000Z");
    const addM = db.prepare("INSERT INTO video_metadata VALUES (?,?,?)");
    addM.run("v10", "10", 600);
    addM.run("v20", "20", 600);
    const addE = db.prepare("INSERT INTO video_events VALUES (?,?,?,?,?,?,?)");
    // 1구간: 두 분야 + 백그라운드 자동재생 1건
    addE.run(
      "anon-exp",
      "v10",
      "2026-09-02T10:00:00+09:00",
      100,
      0,
      "home_feed",
      null,
    );
    addE.run(
      "anon-exp",
      "v20",
      "2026-09-03T10:00:00+09:00",
      100,
      1,
      "related",
      "autoplay",
    );
    // KST로는 09-05(2구간). UTC 날짜만 보면 09-04로 잘못 들어간다
    addE.run(
      "anon-exp",
      "v10",
      "2026-09-04T16:00:00Z",
      100,
      0,
      "direct_search",
      null,
    );
    // 아직 안 끝난 3구간
    addE.run(
      "anon-exp",
      "v20",
      "2026-09-10T10:00:00+09:00",
      100,
      0,
      "home_feed",
      null,
    );
    addE.run(
      "anon-test",
      "v10",
      "2026-09-02T10:00:00+09:00",
      100,
      0,
      "home_feed",
      null,
    );
  });
  afterEach(() => db.close());

  const report = () =>
    run(db, {
      groups: DEFAULT_GROUPS,
      now: new Date("2026-09-10T12:00:00+09:00"),
    });

  it("대상 그룹 참여자의 완료된 기간만 행으로 만든다", () => {
    const { rows, groups } = report();
    expect(groups).toEqual(["EXP", "CON"]);
    expect(rows.map((r) => r.periodIndex)).toEqual([1, 2]);
    expect(rows.every((r) => r.groupCode === "EXP")).toBe(true);
  });

  it("영상을 KST 날짜 기준으로 기간에 넣고 카테고리를 붙여 계산한다", () => {
    const [p1, p2] = report().rows;
    expect(p1.validCount).toBe(2);
    expect(p1.weightedEntropy).toBeGreaterThan(0);
    expect(p1.backgroundAutoplay).toEqual({
      excludedCount: 1,
      weightedEntropy: 0,
    });
    expect(p2.validCount).toBe(1);
    expect(p2.directSearch).toEqual({
      excludedCount: 1,
      weightedEntropy: null,
    });
  });

  it("참여자는 지문으로만 나온다", () => {
    const r = report();
    expect(r.rows[0].participant).toMatch(/^[0-9a-f]{10}$/);
    expect(JSON.stringify(r)).not.toContain("anon-exp");
  });
});

describe("main — 암호화 DB 파일로 실행", () => {
  const KEY = "test-key";
  let dir;
  let dbPath;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "h2-sensitivity-"));
    dbPath = path.join(dir, "test.db");
    const db = new Database(dbPath);
    db.pragma("cipher = 'sqlcipher'");
    db.key(Buffer.from(KEY));
    db.exec(`
      CREATE TABLE participants (anonymousId TEXT, group_code TEXT, installDate TEXT);
      CREATE TABLE video_events (
        anonymousId TEXT, videoId TEXT, watchedAt TEXT, watchedSeconds REAL,
        wasBackgrounded INTEGER, referrerType TEXT, relatedTrigger TEXT
      );
      CREATE TABLE video_metadata (videoId TEXT PRIMARY KEY, categoryId TEXT, durationSeconds INTEGER);
      INSERT INTO participants VALUES ('anon-1', 'CON', '2026-01-01T00:00:00.000Z');
    `);
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
    // 설치일이 오래전이라 모든 구간이 완료됨
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
