import { describe, it, expect, afterEach, beforeEach } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { recordStudyEndReviewEvent } from "../../routes/study-end-review-event.js";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL UNIQUE,
      group_code TEXT NOT NULL,
      installDate TEXT NOT NULL,
      studyEndModalShownAt TEXT,
      studyEndReviewViewedAt TEXT
    );
  `);
  return db;
}

function getParticipant(db, anonymousId) {
  return db
    .prepare(
      "SELECT studyEndModalShownAt, studyEndReviewViewedAt FROM participants WHERE anonymousId = ?",
    )
    .get(anonymousId);
}

describe("recordStudyEndReviewEvent", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'CON', ?)",
    ).run("con-user", "2026-06-01T00:00:00+09:00");
  });

  afterEach(() => {
    db.close();
  });

  it("modal_shown 이벤트를 studyEndModalShownAt에 기록한다", () => {
    recordStudyEndReviewEvent(db, "con-user", "modal_shown");

    const row = getParticipant(db, "con-user");
    expect(row.studyEndModalShownAt).not.toBeNull();
    expect(row.studyEndReviewViewedAt).toBeNull();
  });

  it("review_viewed 이벤트를 studyEndReviewViewedAt에 기록한다", () => {
    recordStudyEndReviewEvent(db, "con-user", "review_viewed");

    const row = getParticipant(db, "con-user");
    expect(row.studyEndReviewViewedAt).not.toBeNull();
    expect(row.studyEndModalShownAt).toBeNull();
  });

  it("이미 기록된 이벤트는 재호출해도 덮어쓰지 않는다(최초 1회만)", () => {
    recordStudyEndReviewEvent(db, "con-user", "modal_shown");
    const first = getParticipant(db, "con-user").studyEndModalShownAt;

    recordStudyEndReviewEvent(db, "con-user", "modal_shown");
    const second = getParticipant(db, "con-user").studyEndModalShownAt;

    expect(second).toBe(first);
  });

  it("두 이벤트는 서로 독립적으로 기록된다", () => {
    recordStudyEndReviewEvent(db, "con-user", "modal_shown");
    recordStudyEndReviewEvent(db, "con-user", "review_viewed");

    const row = getParticipant(db, "con-user");
    expect(row.studyEndModalShownAt).not.toBeNull();
    expect(row.studyEndReviewViewedAt).not.toBeNull();
  });

  it("등록되지 않은 anonymousId를 호출해도 예외를 던지지 않는다", () => {
    expect(() =>
      recordStudyEndReviewEvent(db, "unknown-user", "modal_shown"),
    ).not.toThrow();
  });
});
