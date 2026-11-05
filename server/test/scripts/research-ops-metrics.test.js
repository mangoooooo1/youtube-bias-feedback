import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  run,
  yesterdayWindow,
  buildParticipantStats,
  summarizeFunnel,
  summarizeSessionQuality,
  percentile,
  formatSummary,
  reportToHealthchecks,
  sendGauges,
  GAUGES,
  PING_ENV_VAR,
} from "../../scripts/research-ops-metrics.js";
import { fingerprint } from "../../scripts/fingerprint.js";
import { formatMetric } from "../../monitoring/dogstatsd.js";
import { BASELINE_DAYS, TOTAL_DAYS } from "../../pipeline/study-constants.js";

const DAY = 24 * 60 * 60 * 1000;
// 2026-11-10 10:30 KST
const NOW = Date.parse("2026-11-10T10:30:00+09:00");

describe("yesterdayWindow — 어제(KST) 하루", () => {
  it("KST 오전 실행이면 전날 00:00~24:00 KST를 돌려준다", () => {
    expect(yesterdayWindow(NOW)).toEqual({
      day: "2026-11-09",
      startMs: Date.parse("2026-11-09T00:00:00+09:00"),
      endMs: Date.parse("2026-11-10T00:00:00+09:00"),
    });
  });

  it("UTC로는 아직 전날이어도 KST 날짜 기준으로 자른다", () => {
    // 2026-11-10 00:30 KST = 2026-11-09 15:30Z
    const now = Date.parse("2026-11-10T00:30:00+09:00");
    expect(yesterdayWindow(now).day).toBe("2026-11-09");
  });
});

describe("buildParticipantStats — 연구 기간 중인 참여자만 지문으로", () => {
  const row = (overrides) => ({
    anonymousId: "u1",
    installDate: new Date(NOW - 3 * DAY).toISOString(),
    lastVideoTs: (NOW - 2 * DAY) / 1000,
    lastSessionTs: null,
    dailyVideos: 4,
    ...overrides,
  });

  it("지문·어제 기록 수·경과일(소수 첫째 자리)을 남긴다", () => {
    expect(buildParticipantStats([row()], NOW)).toEqual([
      { fp: fingerprint("u1"), dailyVideos: 4, daysSinceActivity: 2 },
    ]);
  });

  it("영상 기록과 세션 중 더 최근 활동을 기준으로 경과일을 잰다", () => {
    const [stat] = buildParticipantStats(
      [row({ lastSessionTs: (NOW - 0.5 * DAY) / 1000 })],
      NOW,
    );
    expect(stat.daysSinceActivity).toBe(0.5);
  });

  it("연구 기간이 끝난 참여자는 뺀다", () => {
    const ended = row({
      installDate: new Date(NOW - (TOTAL_DAYS + 2) * DAY).toISOString(),
    });
    expect(buildParticipantStats([ended], NOW)).toEqual([]);
  });

  it("설치일이 깨진 행은 뺀다", () => {
    expect(buildParticipantStats([row({ installDate: "oops" })], NOW)).toEqual(
      [],
    );
  });

  it("활동이 한 번도 없으면 설치일부터 경과일을 잰다", () => {
    const [stat] = buildParticipantStats(
      [row({ lastVideoTs: null, dailyVideos: 0 })],
      NOW,
    );
    expect(stat.daysSinceActivity).toBe(3);
  });
});

describe("summarizeFunnel — 자격 있던 실험군 세션만", () => {
  const afterBaseline = new Date(NOW - (BASELINE_DAYS + 2) * DAY).toISOString();
  const session = (overrides) => ({
    endTs: (NOW - 0.6 * DAY) / 1000,
    group_code: "EXP",
    installDate: afterBaseline,
    studyEndCodeVerifiedAt: null,
    reviewed: 1,
    notified: 1,
    viewed: 0,
    confirmed: 0,
    ...overrides,
  });

  it("단계별 세션 수를 센다", () => {
    expect(
      summarizeFunnel([
        session({ viewed: 1, confirmed: 1 }),
        session({ viewed: 1 }),
        session({ notified: 0 }),
      ]),
    ).toEqual({
      sessions: 3,
      reviewed: 3,
      notified: 2,
      viewed: 2,
      confirmed: 1,
    });
  });

  it("베이스라인 중인 실험군 세션은 처치 대상이 아니라 세지 않는다", () => {
    const inBaseline = session({
      installDate: new Date(NOW - 1 * DAY).toISOString(),
    });
    expect(summarizeFunnel([inBaseline]).sessions).toBe(0);
  });

  it("대조군 세션은 코드 검증 뒤라도 세지 않는다", () => {
    const control = session({
      group_code: "CON",
      studyEndCodeVerifiedAt: new Date(NOW - 5 * DAY).toISOString(),
    });
    expect(summarizeFunnel([control]).sessions).toBe(0);
  });
});

describe("summarizeSessionQuality — 세션당 영상 수 분포", () => {
  it("세션 수·0개 세션·중앙값·p95·최댓값을 낸다", () => {
    const sessions = [3, 0, 5, 1, 2, null].map((videoCount) => ({
      videoCount,
    }));
    expect(summarizeSessionQuality(sessions)).toEqual({
      sessions: 6,
      zero: 2,
      median: 1,
      p95: 5,
      max: 5,
    });
  });

  it("세션이 없으면 모두 0이다", () => {
    expect(summarizeSessionQuality([])).toEqual({
      sessions: 0,
      zero: 0,
      median: 0,
      p95: 0,
      max: 0,
    });
  });

  it("percentile은 nearest-rank 방식이다", () => {
    const sorted = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(10);
    expect(percentile(sorted, 95)).toBe(19);
  });
});

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE participants (
      anonymousId TEXT NOT NULL UNIQUE,
      group_code TEXT NOT NULL,
      installDate TEXT,
      studyEndCodeVerifiedAt TEXT
    );
    CREATE TABLE video_events (
      anonymousId TEXT NOT NULL,
      watchedAt TEXT NOT NULL
    );
    CREATE TABLE sessions (
      anonymousId TEXT NOT NULL,
      endTime TEXT NOT NULL,
      videoCount INTEGER,
      review TEXT,
      feedbackNotifiedAt TEXT,
      feedbackViewedAt TEXT,
      feedbackConfirmedAt TEXT,
      createdAt TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe("run — 실제 테이블에서 어제 하루를 집계", () => {
  const installDate = new Date(NOW - (BASELINE_DAYS + 2) * DAY).toISOString();
  const yesterdayNoon = "2026-11-09T12:00:00+09:00";

  function seed(db) {
    const insertP = db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
    );
    insertP.run("exp-1", "EXP", installDate);
    insertP.run("con-1", "CON", installDate);
    insertP.run("test-1", "TEST-EXP", installDate);

    const insertV = db.prepare(
      "INSERT INTO video_events (anonymousId, watchedAt) VALUES (?, ?)",
    );
    insertV.run("exp-1", yesterdayNoon);
    insertV.run("exp-1", "2026-11-09T23:59:00+09:00");
    insertV.run("exp-1", "2026-11-10T00:10:00+09:00"); // 오늘 — 어제 수에 안 듦
    insertV.run("con-1", "2026-11-08T12:00:00+09:00"); // 그저께
    insertV.run("test-1", yesterdayNoon);

    const insertS = db.prepare(
      `INSERT INTO sessions (anonymousId, endTime, videoCount, review, feedbackNotifiedAt, feedbackViewedAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertS.run(
      "exp-1",
      yesterdayNoon,
      2,
      "리뷰",
      yesterdayNoon,
      yesterdayNoon,
    );
    insertS.run("con-1", yesterdayNoon, 0, "리뷰", null, null);
    insertS.run("test-1", yesterdayNoon, 9, "리뷰", yesterdayNoon, null);
  }

  it("TEST 집단을 빼고 참여자별 기록 수·퍼널·품질을 낸다", () => {
    const db = createTestDb();
    seed(db);
    const result = run(db, { now: NOW });

    expect(result.day).toBe("2026-11-09");
    expect(result.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fp: fingerprint("exp-1"), dailyVideos: 2 }),
        expect.objectContaining({ fp: fingerprint("con-1"), dailyVideos: 0 }),
      ]),
    );
    expect(result.participants).toHaveLength(2);
    expect(result.funnel).toEqual({
      sessions: 1,
      reviewed: 1,
      notified: 1,
      viewed: 1,
      confirmed: 0,
    });
    expect(result.quality).toMatchObject({ sessions: 2, zero: 1, max: 2 });
    db.close();
  });
});

describe("Healthchecks 본문과 Datadog gauge", () => {
  const result = {
    day: "2026-11-09",
    participants: [
      { fp: "aaaaaaaaaa", dailyVideos: 3, daysSinceActivity: 0.4 },
      { fp: "bbbbbbbbbb", dailyVideos: 0, daysSinceActivity: 5.2 },
    ],
    funnel: { sessions: 4, reviewed: 4, notified: 3, viewed: 2, confirmed: 1 },
    quality: { sessions: 6, zero: 1, median: 3, p95: 8, max: 9 },
  };

  it("본문에는 건수만 담고 지문은 담지 않는다", () => {
    const body = formatSummary(result);
    expect(body).toBe(
      "2026-11-09 참여자 2명(활동 1명) / 퍼널 4→4→3→2→1 / 세션 6개(0개 1)",
    );
    expect(body).not.toContain("aaaaaaaaaa");
  });

  it("값과 무관하게 success로 보고한다", async () => {
    const ping = { pingSuccess: vi.fn().mockResolvedValue({ ok: true }) };
    await reportToHealthchecks(result, { ping });
    expect(ping.pingSuccess).toHaveBeenCalledWith(PING_ENV_VAR, {
      method: "POST",
      body: formatSummary(result),
    });
  });

  it("참여자 gauge에는 participant 지문 태그만, 퍼널·품질 gauge에는 태그 없이 보낸다", () => {
    const lines = [];
    let allowedTags;
    const createClient = (opts) => {
      allowedTags = opts.allowedTags;
      return {
        send: (name, value, type, tags) =>
          lines.push(formatMetric(name, value, type, tags, allowedTags)),
      };
    };
    sendGauges(result, createClient);

    expect([...allowedTags.participant]).toEqual(["aaaaaaaaaa", "bbbbbbbbbb"]);
    expect(lines).toContain(
      `${GAUGES.dailyVideos}:3|g|#participant:aaaaaaaaaa`,
    );
    expect(lines).toContain(
      `${GAUGES.daysSinceActivity}:5.2|g|#participant:bbbbbbbbbb`,
    );
    expect(lines).toContain("viewlens.feedback_funnel.confirmed:1|g");
    expect(lines).toContain("viewlens.session_quality.p95:8|g");
    expect(lines).toHaveLength(2 * 2 + 5 + 5);
  });

  it("허용 목록에 없는 지문은 태그가 버려진다", () => {
    const allowedTags = { participant: new Set(["aaaaaaaaaa"]) };
    const line = formatMetric(
      GAUGES.dailyVideos,
      1,
      "g",
      { participant: "zzzz" },
      allowedTags,
    );
    expect(line).toBe(`${GAUGES.dailyVideos}:1|g`);
  });
});
