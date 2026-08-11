import { describe, it, expect, afterEach, beforeEach } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { getPeriodReviews } from "../../routes/period-reviews-query.js";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL UNIQUE,
      group_code TEXT NOT NULL
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
  `);
  return db;
}

function insertReview(db, anonymousId, periodIndex, overrides = {}) {
  db.prepare(
    `INSERT INTO period_reviews
      (anonymousId, periodIndex, periodStart, periodEnd, isBaseline, sessionCount,
       videoCount, categoryDistribution, entropy, review, reviewTopic, source,
       promptVersion, generatedAt)
     VALUES (@anonymousId, @periodIndex, @periodStart, @periodEnd, @isBaseline, @sessionCount,
       @videoCount, @categoryDistribution, @entropy, @review, @reviewTopic, @source,
       @promptVersion, @generatedAt)`,
  ).run({
    anonymousId,
    periodIndex,
    periodStart: "2026-06-01",
    periodEnd: "2026-06-01",
    isBaseline: 1,
    sessionCount: 1,
    videoCount: 5,
    categoryDistribution: JSON.stringify({ 음악: 1 }),
    entropy: 0,
    review: "리뷰 문장",
    reviewTopic: "음악",
    source: "llm",
    promptVersion: "viewlens-period-mirror-v1.0",
    generatedAt: "2026-06-02T04:00:00+09:00",
    ...overrides,
  });
}

describe("getPeriodReviews", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("대조군(CON) anonymousId는 빈 배열을 반환한다", () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code) VALUES (?, 'CON')",
    ).run("con-user");
    insertReview(db, "con-user", 1);

    expect(getPeriodReviews(db, "con-user")).toEqual([]);
  });

  it("TEST-CON anonymousId도 빈 배열을 반환한다", () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code) VALUES (?, 'TEST-CON')",
    ).run("test-con-user");
    insertReview(db, "test-con-user", 1);

    expect(getPeriodReviews(db, "test-con-user")).toEqual([]);
  });

  it("등록되지 않은 anonymousId는 빈 배열을 반환한다", () => {
    expect(getPeriodReviews(db, "unknown-user")).toEqual([]);
  });

  it("EXP 참여자의 기간 리뷰를 periodIndex 오름차순으로 반환한다", () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code) VALUES (?, 'EXP')",
    ).run("exp-user");
    insertReview(db, "exp-user", 2);
    insertReview(db, "exp-user", 1);

    const result = getPeriodReviews(db, "exp-user");
    expect(result.map((r) => r.periodIndex)).toEqual([1, 2]);
  });

  it("TEST-EXP 참여자도 정상적으로 조회된다", () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code) VALUES (?, 'TEST-EXP')",
    ).run("test-exp-user");
    insertReview(db, "test-exp-user", 1);

    expect(getPeriodReviews(db, "test-exp-user").length).toBe(1);
  });

  it("isBaseline을 boolean으로 변환해 반환한다", () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code) VALUES (?, 'EXP')",
    ).run("exp-user");
    insertReview(db, "exp-user", 1, { isBaseline: 1 });
    insertReview(db, "exp-user", 2, { isBaseline: 0 });

    const result = getPeriodReviews(db, "exp-user");
    expect(result[0].isBaseline).toBe(true);
    expect(result[1].isBaseline).toBe(false);
  });

  it("다른 참여자의 기간 리뷰는 섞이지 않는다", () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code) VALUES (?, 'EXP')",
    ).run("user-a");
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code) VALUES (?, 'EXP')",
    ).run("user-b");
    insertReview(db, "user-a", 1);
    insertReview(db, "user-b", 1);
    insertReview(db, "user-b", 2);

    expect(getPeriodReviews(db, "user-a").length).toBe(1);
    expect(getPeriodReviews(db, "user-b").length).toBe(2);
  });
});
