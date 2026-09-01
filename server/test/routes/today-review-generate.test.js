process.env.TZ = "Asia/Seoul";

import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { generateAndStoreTodayReview } from "../../routes/today-review-generate.js";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      sessionId TEXT NOT NULL UNIQUE,
      endTime TEXT,
      videoCount INTEGER,
      categoryDistribution TEXT
    );
    CREATE TABLE video_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      title TEXT,
      watchedAt TEXT
    );
    CREATE TABLE today_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      reviewDate TEXT NOT NULL,
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
      genCount INTEGER,
      generatedAt TEXT NOT NULL,
      updatedAt TEXT
    );
    CREATE UNIQUE INDEX idx_today_reviews_participant_date
      ON today_reviews(anonymousId, reviewDate);
  `);
  return db;
}

function insertSession(
  db,
  { anonymousId, sessionId, endTime, videoCount, categoryDistribution },
) {
  db.prepare(
    `INSERT INTO sessions (anonymousId, sessionId, endTime, videoCount, categoryDistribution)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    anonymousId,
    sessionId,
    endTime,
    videoCount,
    JSON.stringify(categoryDistribution),
  );
}

function insertVideoEvent(db, { anonymousId, title, watchedAt }) {
  db.prepare(
    `INSERT INTO video_events (anonymousId, title, watchedAt) VALUES (?, ?, ?)`,
  ).run(anonymousId, title, watchedAt);
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("generateAndStoreTodayReview", () => {
  it("오늘 분석된 세션이 하나도 없으면 null을 반환하고 아무것도 저장하지 않는다", async () => {
    const db = createTestDb();
    const now = new Date("2026-03-10T20:00:00+09:00");

    const result = await generateAndStoreTodayReview(db, {
      anonymousId: "no-session-user",
      apiKey: "fake-key",
      now,
    });

    expect(result).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS c FROM today_reviews").get().c).toBe(
      0,
    );
    db.close();
  });

  it("apiKey가 없으면 Gemini를 부르지 않고 폴백만 사용한다", async () => {
    const db = createTestDb();
    const now = new Date("2026-03-10T20:00:00+09:00");
    insertSession(db, {
      anonymousId: "u1",
      sessionId: "s1",
      endTime: "2026-03-10T10:00:00+09:00",
      videoCount: 3,
      categoryDistribution: { 음악: 1 },
    });
    global.fetch = vi.fn();

    const result = await generateAndStoreTodayReview(db, {
      anonymousId: "u1",
      apiKey: undefined,
      now,
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.source).toBe("fallback");
    expect(result.llmStatus).toBe("fallback");
    expect(result.genCount).toBe(1);

    const row = db
      .prepare("SELECT * FROM today_reviews WHERE anonymousId = ?")
      .get("u1");
    expect(row.reviewDate).toBe("2026-03-10");
    expect(row.source).toBe("fallback");
    expect(row.review).toContain("음악");
  });

  it("Gemini 호출이 성공하면 llm 결과를 저장한다", async () => {
    const db = createTestDb();
    const now = new Date("2026-03-10T20:00:00+09:00");
    insertSession(db, {
      anonymousId: "u2",
      sessionId: "s1",
      endTime: "2026-03-10T10:00:00+09:00",
      videoCount: 3,
      categoryDistribution: { 음악: 1 },
    });
    insertVideoEvent(db, {
      anonymousId: "u2",
      title: "오늘 영상",
      watchedAt: "2026-03-10T10:00:00+09:00",
    });
    global.fetch = vi.fn().mockResolvedValue({
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
    });

    const result = await generateAndStoreTodayReview(db, {
      anonymousId: "u2",
      apiKey: "fake-key",
      now,
    });

    expect(result.source).toBe("llm");
    expect(result.review).toBe("관찰 문장");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-goog-api-key": "fake-key" }),
      }),
    );
  });

  it("Gemini 호출이 실패하면 폴백으로 대체하고 failureReason을 기록한다", async () => {
    const db = createTestDb();
    const now = new Date("2026-03-10T20:00:00+09:00");
    insertSession(db, {
      anonymousId: "u3",
      sessionId: "s1",
      endTime: "2026-03-10T10:00:00+09:00",
      videoCount: 3,
      categoryDistribution: { 음악: 1 },
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server error",
    });

    const result = await generateAndStoreTodayReview(db, {
      anonymousId: "u3",
      apiKey: "fake-key",
      now,
    });

    expect(result.source).toBe("fallback");
    expect(result.llmStatus).toBe("fallback");
    expect(result.failureReason).toBe("http_error");
  });

  it("같은 날짜에 재호출하면 genCount가 1씩 증가하고 최신본으로 덮어쓴다", async () => {
    const db = createTestDb();
    const now = new Date("2026-03-10T10:00:00+09:00");
    insertSession(db, {
      anonymousId: "u4",
      sessionId: "s1",
      endTime: "2026-03-10T09:00:00+09:00",
      videoCount: 2,
      categoryDistribution: { 음악: 1 },
    });

    const first = await generateAndStoreTodayReview(db, {
      anonymousId: "u4",
      apiKey: undefined,
      now,
    });
    expect(first.genCount).toBe(1);

    insertSession(db, {
      anonymousId: "u4",
      sessionId: "s2",
      endTime: "2026-03-10T09:30:00+09:00",
      videoCount: 5,
      categoryDistribution: { 게임: 1 },
    });
    const second = await generateAndStoreTodayReview(db, {
      anonymousId: "u4",
      apiKey: undefined,
      now,
    });
    expect(second.genCount).toBe(2);

    const row = db
      .prepare("SELECT * FROM today_reviews WHERE anonymousId = ?")
      .get("u4");
    expect(row.genCount).toBe(2);
    expect(row.videoCount).toBe(7);
  });

  it("categoryDistribution이 빈 세션(YouTube 카테고리 조회 전부 실패)은 집계에서 제외된다", async () => {
    const db = createTestDb();
    const now = new Date("2026-03-10T20:00:00+09:00");
    insertSession(db, {
      anonymousId: "u5",
      sessionId: "s1",
      endTime: "2026-03-10T10:00:00+09:00",
      videoCount: 3,
      categoryDistribution: {},
    });

    const result = await generateAndStoreTodayReview(db, {
      anonymousId: "u5",
      apiKey: undefined,
      now,
    });

    expect(result).toBeNull();
  });
});
