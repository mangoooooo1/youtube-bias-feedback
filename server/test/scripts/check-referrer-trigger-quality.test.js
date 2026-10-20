import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3-multiple-ciphers";
import {
  summarizeReferrerTriggers,
  judgeTriggerQuality,
  buildReport,
  parseGroupsArg,
  formatQualitySummary,
  run,
  main,
  DEFAULT_GROUPS,
} from "../../scripts/check-referrer-trigger-quality.js";

const ev = (referrerType, relatedTrigger = null, extra = {}) => ({
  referrerType,
  relatedTrigger,
  ...extra,
});

/** related 영상 total건 중 unknown이 unknownCount건인 기록 */
function relatedEvents(total, unknownCount) {
  return Array.from({ length: total }, (_, i) =>
    ev("related", i < unknownCount ? "unknown" : "click"),
  );
}

describe("summarizeReferrerTriggers — 유입 경로·트리거 구성", () => {
  it("관련영상 유입 중 autoplay·click·unknown 개수와 비율을 센다", () => {
    const s = summarizeReferrerTriggers([
      ev("related", "autoplay"),
      ev("related", "autoplay"),
      ev("related", "click"),
      ev("related", "unknown"),
      ev("home_feed"),
    ]);
    expect(s.totalEvents).toBe(5);
    expect(s.related).toEqual({
      total: 4,
      autoplay: { count: 2, ratio: 0.5 },
      click: { count: 1, ratio: 0.25 },
      unknown: { count: 1, ratio: 0.25 },
    });
  });

  it("referrerType NULL(신호 미전송)은 분류된 unknown과 따로 센다", () => {
    const s = summarizeReferrerTriggers([
      ev(null),
      ev("unknown"),
      ev("unknown"),
      ev("direct_search"),
    ]);
    expect(s.referrerType).toEqual({
      notSent: { count: 1, ratio: 0.25 },
      unknown: { count: 2, ratio: 0.5 },
    });
  });

  it("related인데 트리거가 비어 있으면 unknown으로 센다", () => {
    const s = summarizeReferrerTriggers([ev("related", null)]);
    expect(s.related.unknown).toEqual({ count: 1, ratio: 1 });
  });

  it("영상이 없으면 비율은 0이 아니라 null이다", () => {
    const s = summarizeReferrerTriggers([]);
    expect(s.referrerType.unknown).toEqual({ count: 0, ratio: null });
    expect(s.related.autoplay).toEqual({ count: 0, ratio: null });
  });
});

describe("judgeTriggerQuality — 30% 기준 판정", () => {
  it("관련영상 유입 중 unknown이 정확히 30%면 보정 필요로 본다(이상)", () => {
    const j = judgeTriggerQuality(
      summarizeReferrerTriggers(relatedEvents(10, 3)),
    );
    expect(j).toEqual({
      relatedUnknownRatio: 0.3,
      threshold: 0.3,
      needsLogicFix: true,
    });
  });

  it("30%보다 조금이라도 낮으면 보정 필요가 아니다", () => {
    const j = judgeTriggerQuality(
      summarizeReferrerTriggers(relatedEvents(10, 2)),
    );
    expect(j.needsLogicFix).toBe(false);
  });

  it("반올림하면 30%가 되는 29.96%도 기준 미만으로 판정한다", () => {
    const j = judgeTriggerQuality(
      summarizeReferrerTriggers(relatedEvents(2500, 749)),
    );
    expect(j.relatedUnknownRatio).toBe(0.3);
    expect(j.needsLogicFix).toBe(false);
  });

  it("관련영상 유입이 없으면 판정하지 않는다(null)", () => {
    const j = judgeTriggerQuality(summarizeReferrerTriggers([ev("home_feed")]));
    expect(j.needsLogicFix).toBeNull();
  });

  it("다른 임계값을 넘길 수 있다", () => {
    const j = judgeTriggerQuality(
      summarizeReferrerTriggers(relatedEvents(10, 2)),
      0.2,
    );
    expect(j.needsLogicFix).toBe(true);
  });
});

describe("buildReport — 전체·그룹별·참여자별", () => {
  const events = [
    ev("related", "unknown", { anonymousId: "anon-a", groupCode: "TEST-EXP" }),
    ev("related", "click", { anonymousId: "anon-a", groupCode: "TEST-EXP" }),
    ev("related", "autoplay", { anonymousId: "anon-b", groupCode: "TEST-CON" }),
    ev(null, null, { anonymousId: "anon-b", groupCode: "TEST-CON" }),
  ];
  const report = buildReport(events, {
    groups: ["TEST-EXP", "TEST-CON"],
    generatedAt: "2026-10-20T00:00:00.000Z",
  });

  it("판정은 전체 합산 기준이고 그룹별 개수의 합이 전체와 같다", () => {
    expect(report.overall.related.total).toBe(3);
    expect(report.overall.judgement.needsLogicFix).toBe(true); // 1/3
    const groupRelated = Object.values(report.byGroup).map(
      (g) => g.related.total,
    );
    expect(groupRelated.reduce((a, b) => a + b, 0)).toBe(3);
    expect(report.byGroup["TEST-CON"].referrerType.notSent.count).toBe(1);
  });

  it("참여자는 지문으로만 나오고 원래 ID는 리포트 어디에도 없다", () => {
    expect(report.byParticipant).toHaveLength(2);
    expect(report.byParticipant[0].participant).toMatch(/^[0-9a-f]{10}$/);
    expect(report.byParticipant[0].groupCode).toBe("TEST-EXP");
    const json = JSON.stringify(report);
    expect(json).not.toContain("anon-a");
    expect(json).not.toContain("anon-b");
  });
});

describe("run — DB 조회", () => {
  let db;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE participants (anonymousId TEXT, group_code TEXT);
      CREATE TABLE video_events (anonymousId TEXT, referrerType TEXT, relatedTrigger TEXT);
    `);
    const addP = db.prepare("INSERT INTO participants VALUES (?,?)");
    addP.run("anon-test", "TEST-EXP");
    addP.run("anon-main", "EXP");
    const addE = db.prepare("INSERT INTO video_events VALUES (?,?,?)");
    addE.run("anon-test", "related", "autoplay");
    addE.run("anon-test", "related", "unknown");
    addE.run("anon-main", "related", "unknown");
    addE.run("anon-unregistered", "related", "unknown");
  });
  afterEach(() => db.close());

  it("대상 그룹 참여자의 영상만 집계한다", () => {
    const report = run(db, {
      groups: DEFAULT_GROUPS,
      now: new Date("2026-10-20T00:00:00Z"),
    });
    expect(report.generatedAt).toBe("2026-10-20T00:00:00.000Z");
    expect(report.overall.totalEvents).toBe(2);
    expect(report.overall.related.unknown.count).toBe(1);
    expect(report.byParticipant).toHaveLength(1);
  });
});

describe("parseGroupsArg", () => {
  it("인자가 없으면 기본값(TEST 그룹)을 쓴다", () => {
    expect(parseGroupsArg([])).toEqual(["TEST-EXP", "TEST-CON"]);
    expect(parseGroupsArg([], ["EXP", "CON"])).toEqual(["EXP", "CON"]);
  });

  it("넘긴 그룹을 그대로 쓰고, 모르는 그룹은 거부한다", () => {
    expect(parseGroupsArg(["EXP"])).toEqual(["EXP"]);
    expect(() => parseGroupsArg(["EXP", "exp"])).toThrow(
      "알 수 없는 그룹: exp",
    );
  });
});

describe("formatQualitySummary", () => {
  const summaryOf = (events) =>
    formatQualitySummary(buildReport(events, { groups: [], generatedAt: "" }));

  it("기준 이상이면 보정 필요를 알린다", () => {
    expect(summaryOf(relatedEvents(10, 3))).toBe(
      "관련영상 유입 10건 중 unknown 3건(30.00%) — 기준 30% 이상 — 판정 로직 보정 필요",
    );
  });

  it("기준 미만", () => {
    expect(summaryOf(relatedEvents(10, 1))).toBe(
      "관련영상 유입 10건 중 unknown 1건(10.00%) — 기준 30% 미만",
    );
  });

  it("경계 바로 아래(29.96%)는 반올림된 30%가 아니라 개수와 원래 비율로 보인다", () => {
    expect(summaryOf(relatedEvents(2500, 749))).toBe(
      "관련영상 유입 2500건 중 unknown 749건(29.96%) — 기준 30% 미만",
    );
  });

  it("관련영상 유입이 없으면 판정할 수 없다고 알린다", () => {
    expect(summaryOf([])).toBe("관련영상 유입 0건 — 판정할 수 없음");
  });
});

describe("main — 암호화 DB 파일로 실행", () => {
  const KEY = "test-key";
  let dir;
  let dbPath;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trigger-quality-"));
    dbPath = path.join(dir, "test.db");
    const db = new Database(dbPath);
    db.pragma("cipher = 'sqlcipher'");
    db.key(Buffer.from(KEY));
    db.exec(`
      CREATE TABLE participants (anonymousId TEXT, group_code TEXT);
      CREATE TABLE video_events (anonymousId TEXT, referrerType TEXT, relatedTrigger TEXT);
      INSERT INTO participants VALUES ('anon-1', 'EXP');
      INSERT INTO video_events VALUES ('anon-1', 'related', 'unknown');
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

  it("인자로 받은 그룹을 집계해 JSON으로 저장하고 판정을 출력한다", () => {
    const outDir = path.join(dir, "out");
    const outPath = main({
      argv: [dbPath, "EXP"],
      env: { DB_ENCRYPTION_KEY: KEY },
      outDir,
    });
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(report.groups).toEqual(["EXP"]);
    expect(report.overall.judgement.needsLogicFix).toBe(true);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("판정 로직 보정 필요"),
    );
  });

  it("SOURCE_DB_PATH를 쓰면 첫 인자부터 그룹으로 읽는다", () => {
    const outPath = main({
      argv: ["EXP"],
      env: { SOURCE_DB_PATH: dbPath, DB_ENCRYPTION_KEY: KEY },
      outDir: dir,
    });
    expect(JSON.parse(fs.readFileSync(outPath, "utf8")).groups).toEqual([
      "EXP",
    ]);
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
    expect(main({ argv: [dbPath], env: {} })).toBeNull();
    expect(process.exitCode).toBe(1);
  });
});
