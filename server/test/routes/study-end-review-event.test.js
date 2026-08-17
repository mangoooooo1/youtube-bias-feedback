import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
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
    CREATE TABLE period_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      periodIndex INTEGER NOT NULL
    );
  `);
  return db;
}

function insertParticipant(db, anonymousId, groupCode, installDate) {
  db.prepare(
    "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
  ).run(anonymousId, groupCode, installDate);
}

function insertPeriodReview(db, anonymousId, periodIndex) {
  db.prepare(
    "INSERT INTO period_reviews (anonymousId, periodIndex) VALUES (?, ?)",
  ).run(anonymousId, periodIndex);
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
  const FIXED_NOW = new Date("2026-06-10T10:00:00+09:00");
  const ENDED_INSTALL_DATE = "2026-06-01T00:00:00+09:00"; // +6일(TOTAL_DAYS) = 6/7 → 종료됨
  const NOT_ENDED_INSTALL_DATE = "2026-06-08T00:00:00+09:00"; // +6일 = 6/14 → 진행 중

  beforeEach(() => {
    db = createTestDb();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("등록되지 않은 anonymousId는 not_found를 반환하고 아무것도 기록하지 않는다", () => {
    const result = recordStudyEndReviewEvent(db, "unknown-user", "modal_shown");
    expect(result).toBe("not_found");
  });

  it("연구 종료 전 CON은 not_eligible을 반환하고 기록하지 않는다", () => {
    insertParticipant(db, "con-not-ended", "CON", NOT_ENDED_INSTALL_DATE);

    const result = recordStudyEndReviewEvent(db, "con-not-ended", "modal_shown");

    expect(result).toBe("not_eligible");
    expect(getParticipant(db, "con-not-ended").studyEndModalShownAt).toBeNull();
  });

  it("종료됐지만 전체 기간 리뷰가 아직 다 생성되지 않은 CON은 not_eligible을 반환한다", () => {
    insertParticipant(db, "con-incomplete", "CON", ENDED_INSTALL_DATE);
    insertPeriodReview(db, "con-incomplete", 1);
    insertPeriodReview(db, "con-incomplete", 2); // 3구간 중 2개만 — 아직 미완성

    const result = recordStudyEndReviewEvent(db, "con-incomplete", "modal_shown");

    expect(result).toBe("not_eligible");
    expect(getParticipant(db, "con-incomplete").studyEndModalShownAt).toBeNull();
  });

  it("EXP는 종료·완성 상태여도 not_eligible을 반환한다(이 이벤트는 대조군 전용)", () => {
    insertParticipant(db, "exp-user", "EXP", ENDED_INSTALL_DATE);
    insertPeriodReview(db, "exp-user", 1);
    insertPeriodReview(db, "exp-user", 2);
    insertPeriodReview(db, "exp-user", 3);

    const result = recordStudyEndReviewEvent(db, "exp-user", "modal_shown");

    expect(result).toBe("not_eligible");
    expect(getParticipant(db, "exp-user").studyEndModalShownAt).toBeNull();
  });

  it("종료 + 전체 기간 완성 상태의 CON은 modal_shown을 기록한다", () => {
    insertParticipant(db, "con-complete", "CON", ENDED_INSTALL_DATE);
    insertPeriodReview(db, "con-complete", 1);
    insertPeriodReview(db, "con-complete", 2);
    insertPeriodReview(db, "con-complete", 3);

    const result = recordStudyEndReviewEvent(db, "con-complete", "modal_shown");

    expect(result).toBe("recorded");
    const row = getParticipant(db, "con-complete");
    expect(row.studyEndModalShownAt).not.toBeNull();
    expect(row.studyEndReviewViewedAt).toBeNull();
  });

  it("TEST-CON도 동일한 조건에서 review_viewed를 기록한다", () => {
    insertParticipant(db, "test-con-complete", "TEST-CON", ENDED_INSTALL_DATE);
    insertPeriodReview(db, "test-con-complete", 1);
    insertPeriodReview(db, "test-con-complete", 2);
    insertPeriodReview(db, "test-con-complete", 3);

    const result = recordStudyEndReviewEvent(
      db,
      "test-con-complete",
      "review_viewed",
    );

    expect(result).toBe("recorded");
    expect(
      getParticipant(db, "test-con-complete").studyEndReviewViewedAt,
    ).not.toBeNull();
  });

  it("이미 기록된 이벤트는 재호출해도 덮어쓰지 않는다(최초 1회만)", () => {
    insertParticipant(db, "con-complete", "CON", ENDED_INSTALL_DATE);
    insertPeriodReview(db, "con-complete", 1);
    insertPeriodReview(db, "con-complete", 2);
    insertPeriodReview(db, "con-complete", 3);

    recordStudyEndReviewEvent(db, "con-complete", "modal_shown");
    const first = getParticipant(db, "con-complete").studyEndModalShownAt;

    recordStudyEndReviewEvent(db, "con-complete", "modal_shown");
    const second = getParticipant(db, "con-complete").studyEndModalShownAt;

    expect(second).toBe(first);
  });

  it("두 이벤트는 서로 독립적으로 기록된다", () => {
    insertParticipant(db, "con-complete", "CON", ENDED_INSTALL_DATE);
    insertPeriodReview(db, "con-complete", 1);
    insertPeriodReview(db, "con-complete", 2);
    insertPeriodReview(db, "con-complete", 3);

    recordStudyEndReviewEvent(db, "con-complete", "modal_shown");
    recordStudyEndReviewEvent(db, "con-complete", "review_viewed");

    const row = getParticipant(db, "con-complete");
    expect(row.studyEndModalShownAt).not.toBeNull();
    expect(row.studyEndReviewViewedAt).not.toBeNull();
  });
});
