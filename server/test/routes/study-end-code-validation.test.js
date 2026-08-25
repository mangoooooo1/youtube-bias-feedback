import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  isValidStudyEndCode,
  verifyAndRecordStudyEndCode,
} from "../../routes/study-end-code-validation.js";

describe("isValidStudyEndCode", () => {
  it("입력 코드와 서버 코드가 일치하면 true를 반환한다", () => {
    expect(isValidStudyEndCode("ABCD1234", "ABCD1234")).toBe(true);
  });

  it("대소문자가 달라도 일치로 처리한다", () => {
    expect(isValidStudyEndCode("abcd1234", "ABCD1234")).toBe(true);
  });

  it("앞뒤 공백은 무시한다", () => {
    expect(isValidStudyEndCode("  ABCD1234  ", "ABCD1234")).toBe(true);
  });

  it("일치하지 않으면 false를 반환한다", () => {
    expect(isValidStudyEndCode("WRONG", "ABCD1234")).toBe(false);
  });

  it("서버 코드가 설정되지 않았으면(빈 값) 항상 false를 반환한다 — 통과 폴백 없음", () => {
    expect(isValidStudyEndCode("ANYTHING", "")).toBe(false);
    expect(isValidStudyEndCode("ANYTHING", undefined)).toBe(false);
  });

  it("입력 코드가 빈 값이어도 안전하게 false를 반환한다", () => {
    expect(isValidStudyEndCode("", "ABCD1234")).toBe(false);
    expect(isValidStudyEndCode(null, "ABCD1234")).toBe(false);
  });
});

describe("verifyAndRecordStudyEndCode", () => {
  let db;
  const CODE = "ABCD1234";
  const FIXED_NOW = new Date("2026-06-10T10:00:00+09:00");
  const ENDED_INSTALL_DATE = "2026-06-01T00:00:00+09:00"; // +6일(TOTAL_DAYS) = 6/7 → 종료됨
  const NOT_ENDED_INSTALL_DATE = "2026-06-08T00:00:00+09:00"; // +6일 = 6/14 → 진행 중

  function createTestDb() {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        anonymousId TEXT NOT NULL UNIQUE,
        group_code TEXT NOT NULL,
        installDate TEXT NOT NULL,
        studyEndCodeVerifiedAt TEXT
      );
      CREATE TABLE period_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        anonymousId TEXT NOT NULL,
        periodIndex INTEGER NOT NULL
      );
    `);
    return database;
  }

  function insertParticipant(database, anonymousId, groupCode, installDate) {
    database
      .prepare(
        "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
      )
      .run(anonymousId, groupCode, installDate);
  }

  function insertPeriodReview(database, anonymousId, periodIndex) {
    database
      .prepare(
        "INSERT INTO period_reviews (anonymousId, periodIndex) VALUES (?, ?)",
      )
      .run(anonymousId, periodIndex);
  }

  function getVerifiedAt(database, anonymousId) {
    return database
      .prepare(
        "SELECT studyEndCodeVerifiedAt FROM participants WHERE anonymousId = ?",
      )
      .get(anonymousId).studyEndCodeVerifiedAt;
  }

  function makeCompleteCon(database, anonymousId, groupCode = "CON") {
    insertParticipant(database, anonymousId, groupCode, ENDED_INSTALL_DATE);
    insertPeriodReview(database, anonymousId, 1);
    insertPeriodReview(database, anonymousId, 2);
    insertPeriodReview(database, anonymousId, 3);
  }

  beforeEach(() => {
    db = createTestDb();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("코드가 틀리면 자격과 무관하게 false를 반환하고 기록하지 않는다", () => {
    makeCompleteCon(db, "con-complete");
    expect(verifyAndRecordStudyEndCode(db, "con-complete", "WRONG", CODE)).toBe(
      false,
    );
    expect(getVerifiedAt(db, "con-complete")).toBeNull();
  });

  it("등록되지 않은 anonymousId는 코드가 맞아도 false를 반환한다", () => {
    expect(
      verifyAndRecordStudyEndCode(db, "unknown-user", CODE, CODE),
    ).toBe(false);
  });

  it("EXP는 코드가 맞아도 false를 반환한다(이 게이트는 대조군 전용)", () => {
    insertParticipant(db, "exp-user", "EXP", ENDED_INSTALL_DATE);
    insertPeriodReview(db, "exp-user", 1);
    expect(verifyAndRecordStudyEndCode(db, "exp-user", CODE, CODE)).toBe(
      false,
    );
    expect(getVerifiedAt(db, "exp-user")).toBeNull();
  });

  it("연구 종료 전 대조군은 코드가 맞아도 false를 반환한다", () => {
    insertParticipant(db, "con-not-ended", "CON", NOT_ENDED_INSTALL_DATE);
    insertPeriodReview(db, "con-not-ended", 1);
    insertPeriodReview(db, "con-not-ended", 2);
    insertPeriodReview(db, "con-not-ended", 3);
    expect(
      verifyAndRecordStudyEndCode(db, "con-not-ended", CODE, CODE),
    ).toBe(false);
  });

  it("종료됐지만 전체 기간 리뷰가 미완성이면 false를 반환한다", () => {
    insertParticipant(db, "con-incomplete", "CON", ENDED_INSTALL_DATE);
    insertPeriodReview(db, "con-incomplete", 1);
    expect(
      verifyAndRecordStudyEndCode(db, "con-incomplete", CODE, CODE),
    ).toBe(false);
  });

  it("코드 일치 + 대조군 + 종료 + 완결 조건을 모두 만족하면 true를 반환하고 시각을 기록한다", () => {
    makeCompleteCon(db, "con-complete");
    expect(verifyAndRecordStudyEndCode(db, "con-complete", CODE, CODE)).toBe(
      true,
    );
    expect(getVerifiedAt(db, "con-complete")).not.toBeNull();
  });

  it("TEST-CON도 CON과 동일하게 통과한다", () => {
    makeCompleteCon(db, "test-con-complete", "TEST-CON");
    expect(
      verifyAndRecordStudyEndCode(db, "test-con-complete", CODE, CODE),
    ).toBe(true);
  });

  it("이미 기록된 시각은 재검증해도 덮어쓰지 않는다(최초 1회만)", () => {
    makeCompleteCon(db, "con-complete");
    verifyAndRecordStudyEndCode(db, "con-complete", CODE, CODE);
    const first = getVerifiedAt(db, "con-complete");

    vi.setSystemTime(new Date(FIXED_NOW.getTime() + 60000));
    verifyAndRecordStudyEndCode(db, "con-complete", CODE, CODE);
    const second = getVerifiedAt(db, "con-complete");

    expect(second).toBe(first);
  });
});
