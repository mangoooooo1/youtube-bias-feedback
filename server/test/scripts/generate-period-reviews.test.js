import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { run } from "../../scripts/generate-period-reviews.js";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL UNIQUE,
      group_code TEXT NOT NULL,
      installDate TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      categoryDistribution TEXT,
      videoCount INTEGER,
      endTime TEXT
    );
    CREATE TABLE video_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      title TEXT,
      watchedAt TEXT NOT NULL
    );
    CREATE TABLE period_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      periodIndex INTEGER NOT NULL,
      periodStart TEXT NOT NULL,
      periodEnd TEXT NOT NULL,
      isBaseline INTEGER NOT NULL,
      sessionCount INTEGER,
      videoCount INTEGER,
      categoryDistribution TEXT,
      entropy REAL,
      review TEXT,
      reviewTopic TEXT,
      source TEXT,
      promptVersion TEXT,
      llmStatus TEXT,
      failureReason TEXT,
      geminiMs INTEGER,
      generatedAt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_period_reviews_participant_period
      ON period_reviews(anonymousId, periodIndex);
  `);
  return db;
}

const INSTALL_DATE = "2026-06-01T00:00:00+09:00";
const FIXED_NOW = new Date("2026-06-04T10:00:00+09:00");

describe("generate-period-reviews.js — run()", () => {
  let db;
  const originalFetch = global.fetch;

  beforeEach(() => {
    db = createTestDb();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    db.close();
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("대조군(CON)은 처리 대상에서 제외한다", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'CON', ?)",
    ).run("con-user", INSTALL_DATE);

    global.fetch = vi.fn();
    await run(db, "fake-key");

    const rows = db.prepare("SELECT * FROM period_reviews").all();
    expect(rows).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("세션이 없는 기간은 Gemini 호출을 생략하고 fallback으로 저장한다", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run("empty-user", INSTALL_DATE);

    global.fetch = vi.fn();
    await run(db, "fake-key");

    const rows = db
      .prepare(
        "SELECT * FROM period_reviews WHERE anonymousId = ? ORDER BY periodIndex",
      )
      .all("empty-user");
    expect(rows.length).toBe(3); // 1~3일차
    expect(rows.every((r) => r.source === "fallback")).toBe(true);
    expect(
      rows.every((r) => r.review.includes("분석할 시청 기록이 없어요")),
    ).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("밀린 여러 기간을 오래된 순서로 순차 처리한다 (동시 호출 없음)", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run("active-user", INSTALL_DATE);

    for (const [day, count] of [
      ["2026-06-01T10:00:00+09:00", 5],
      ["2026-06-02T10:00:00+09:00", 5],
      ["2026-06-03T10:00:00+09:00", 5],
    ]) {
      db.prepare(
        "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
      ).run("active-user", JSON.stringify({ 음악: 1 }), count, day);
    }

    let inFlight = 0;
    let maxConcurrent = 0;
    const order = [];
    global.fetch = vi.fn(async (_url, opts) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      const body = JSON.parse(opts.body);
      order.push(body.contents[0].parts[0].text.length); // 호출 순서 기록용
      await Promise.resolve();
      inFlight--;
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: '{"topic":"음악","feedback":"관찰 문장"}' }],
              },
            },
          ],
        }),
      };
    });

    await run(db, "fake-key");

    expect(maxConcurrent).toBe(1); // 병렬 호출 없음 — 항상 하나씩만 진행 중
    expect(global.fetch).toHaveBeenCalledTimes(3);

    const rows = db
      .prepare(
        "SELECT * FROM period_reviews WHERE anonymousId = ? ORDER BY periodIndex",
      )
      .all("active-user");
    expect(rows.map((r) => r.periodIndex)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.source === "llm")).toBe(true);
  });

  it("period_reviews에 이미 있는 기간은 건너뛰고, UNIQUE 제약으로 중복 행이 생기지 않는다", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run("repeat-user", INSTALL_DATE);
    db.prepare(
      "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
    ).run(
      "repeat-user",
      JSON.stringify({ 음악: 1 }),
      5,
      "2026-06-01T10:00:00+09:00",
    );

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '{"topic":"음악","feedback":"문장"}' }],
            },
          },
        ],
      }),
    });

    await run(db, "fake-key"); // 1회차 실행
    await run(db, "fake-key"); // 재실행 — 이미 있는 기간은 건너뛰어야 함

    const rows = db
      .prepare("SELECT * FROM period_reviews WHERE anonymousId = ?")
      .all("repeat-user");
    // 1~3일차 각각 정확히 1건씩만 존재 (재실행으로 중복 생성되지 않음)
    expect(rows.length).toBe(3);
    const indexes = rows.map((r) => r.periodIndex).sort();
    expect(indexes).toEqual([1, 2, 3]);
  });

  it("Gemini 호출 실패 시 fallback으로 대체 저장하고 failureReason을 기록한다", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run("fail-user", INSTALL_DATE);
    db.prepare(
      "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
    ).run(
      "fail-user",
      JSON.stringify({ 음악: 1 }),
      5,
      "2026-06-01T10:00:00+09:00",
    );

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server error",
    });

    await run(db, "fake-key");

    const row = db
      .prepare(
        "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
      )
      .get("fail-user");
    expect(row.source).toBe("fallback");
    expect(row.llmStatus).toBe("fallback");
    expect(row.failureReason).toBe("http_error");
  });
});
