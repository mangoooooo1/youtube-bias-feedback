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

// 설치일로부터 이미 6일이 지난 것으로 고정 — 파일럿 구성(DAYS_PER_PERIOD=2, TOTAL_DAYS=6)
// 기준으로 3개 기간(베이스라인 1구간 + 일반 2구간) 전부 완료 대상이 된다.
const INSTALL_DATE = "2026-06-01T00:00:00+09:00";
const FIXED_NOW = new Date("2026-06-07T10:00:00+09:00");

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

  it("대조군(CON, TEST-CON)도 실험군과 동일하게 처리 대상에 포함된다 (Story 10-10 사전 생성)", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'CON', ?)",
    ).run("con-user", INSTALL_DATE);
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'TEST-CON', ?)",
    ).run("test-con-user", INSTALL_DATE);

    global.fetch = vi.fn();
    await run(db, "fake-key");

    for (const anonymousId of ["con-user", "test-con-user"]) {
      const rows = db
        .prepare(
          "SELECT * FROM period_reviews WHERE anonymousId = ? ORDER BY periodIndex",
        )
        .all(anonymousId);
      expect(rows.length).toBe(3); // 1~3구간 — EXP와 동일하게 전부 생성됨
      expect(rows.every((r) => r.source === "fallback")).toBe(true);
    }
    // 세션이 없는 케이스라 Gemini 호출은 여전히 생략된다(기존 fallback 경로 재사용).
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

    // DAYS_PER_PERIOD=2 기준 각 기간(1구간 6/1-6/2, 2구간 6/3-6/4, 3구간 6/5-6/6)에
    // 하나씩 세션을 심어 3개 기간 모두 데이터가 있는 상태로 만든다.
    for (const [day, count] of [
      ["2026-06-01T10:00:00+09:00", 5],
      ["2026-06-03T10:00:00+09:00", 5],
      ["2026-06-05T10:00:00+09:00", 5],
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
    const indexes = rows.map((r) => r.periodIndex).sort((a, b) => a - b);
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

  describe("fallback 재시도 정책 (periodEnd 기준 3일 이내)", () => {
    // 1일차(offset 0-1, periodEnd=2026-06-02) 하나만 완료되도록 고정 — 나머지 기간은
    // 이 테스트들과 무관하니 아직 진행 중인 채로 둔다.
    const P1_INSTALL_DATE = "2026-06-01T00:00:00+09:00";
    const P1_SESSION_AT = "2026-06-01T10:00:00+09:00";

    it("성공(llmStatus=success)한 기간은 재실행해도 다시 시도하지 않는다", async () => {
      vi.setSystemTime(new Date("2026-06-03T10:00:00+09:00"));
      db.prepare(
        "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
      ).run("locked-success-user", P1_INSTALL_DATE);
      db.prepare(
        "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
      ).run(
        "locked-success-user",
        JSON.stringify({ 음악: 1 }),
        5,
        P1_SESSION_AT,
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

      await run(db, "fake-key");
      expect(global.fetch).toHaveBeenCalledTimes(1);

      await run(db, "fake-key"); // 재실행 — success는 다시 건드리지 않아야 함
      expect(global.fetch).toHaveBeenCalledTimes(1);

      const row = db
        .prepare(
          "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
        )
        .get("locked-success-user");
      expect(row.llmStatus).toBe("success");
    });

    it("fallback 기간은 periodEnd로부터 3일 이내면 재시도해 성공으로 갱신될 수 있다", async () => {
      vi.setSystemTime(new Date("2026-06-03T10:00:00+09:00"));
      db.prepare(
        "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
      ).run("retry-user", P1_INSTALL_DATE);
      db.prepare(
        "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
      ).run("retry-user", JSON.stringify({ 음악: 1 }), 5, P1_SESSION_AT);

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "server error",
      });
      await run(db, "fake-key"); // 1회차 — 실패 → fallback 저장 (periodEnd=6/2, 재시도 기한 6/5)

      let row = db
        .prepare(
          "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
        )
        .get("retry-user");
      expect(row.llmStatus).toBe("fallback");

      // 하루 뒤(재시도 기한 안) — 이번엔 성공하도록 변경 후 재실행
      vi.setSystemTime(new Date("2026-06-04T10:00:00+09:00"));
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: '{"topic":"음악","feedback":"복구된 리뷰"}' }],
              },
            },
          ],
        }),
      });
      await run(db, "fake-key");

      row = db
        .prepare(
          "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
        )
        .get("retry-user");
      expect(row.llmStatus).toBe("success");
      expect(row.review).toBe("복구된 리뷰");
      // OR REPLACE로 갱신돼도 같은 기간에 행이 여러 개 생기면 안 된다.
      const rows = db
        .prepare(
          "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
        )
        .all("retry-user");
      expect(rows.length).toBe(1);
    });

    it("fallback 기간이 재시도 기한(periodEnd+3일)을 지나면 더 이상 재시도하지 않는다", async () => {
      vi.setSystemTime(new Date("2026-06-03T10:00:00+09:00"));
      db.prepare(
        "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
      ).run("expired-user", P1_INSTALL_DATE);
      db.prepare(
        "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
      ).run("expired-user", JSON.stringify({ 음악: 1 }), 5, P1_SESSION_AT);

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "server error",
      });
      await run(db, "fake-key"); // periodEnd=6/2, 재시도 기한 6/5

      // 기한(6/5)을 지난 시점 — 이제 성공하도록 바꿔도 더 이상 호출되면 안 된다.
      vi.setSystemTime(new Date("2026-06-06T10:00:00+09:00"));
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  { text: '{"topic":"음악","feedback":"너무 늦은 성공"}' },
                ],
              },
            },
          ],
        }),
      });
      await run(db, "fake-key");

      expect(global.fetch).not.toHaveBeenCalled();
      const row = db
        .prepare(
          "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
        )
        .get("expired-user");
      expect(row.llmStatus).toBe("fallback");
    });
  });
});
