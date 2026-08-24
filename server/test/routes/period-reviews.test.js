import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  getPeriodReviews,
  isStudyEndUnlocked,
  isStudyEnded,
} from "../../routes/period-reviews-query.js";

// 대조군 케이스와 무관한 기존 EXP/미등록 테스트에서 채워 넣는 자리표시 installDate.
// EXP 경로는 isStudyEndUnlocked를 호출하지 않으므로 값 자체는 결과에 영향을 주지 않는다.
const FILLER_INSTALL_DATE = "2026-01-01T00:00:00+09:00";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL UNIQUE,
      group_code TEXT NOT NULL,
      installDate TEXT NOT NULL
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

function insertParticipant(
  db,
  anonymousId,
  groupCode,
  installDate = FILLER_INSTALL_DATE,
) {
  db.prepare(
    "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
  ).run(anonymousId, groupCode, installDate);
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

  it("등록되지 않은 anonymousId는 빈 배열을 반환한다", () => {
    expect(getPeriodReviews(db, "unknown-user")).toEqual([]);
  });

  it("EXP 참여자의 기간 리뷰를 periodIndex 오름차순으로 반환한다", () => {
    insertParticipant(db, "exp-user", "EXP");
    insertReview(db, "exp-user", 2);
    insertReview(db, "exp-user", 1);

    const result = getPeriodReviews(db, "exp-user");
    expect(result.map((r) => r.periodIndex)).toEqual([1, 2]);
  });

  it("TEST-EXP 참여자도 정상적으로 조회된다", () => {
    insertParticipant(db, "test-exp-user", "TEST-EXP");
    insertReview(db, "test-exp-user", 1);

    expect(getPeriodReviews(db, "test-exp-user").length).toBe(1);
  });

  it("isBaseline을 boolean으로 변환해 반환한다", () => {
    insertParticipant(db, "exp-user", "EXP");
    insertReview(db, "exp-user", 1, { isBaseline: 1 });
    insertReview(db, "exp-user", 2, { isBaseline: 0 });

    const result = getPeriodReviews(db, "exp-user");
    expect(result[0].isBaseline).toBe(true);
    expect(result[1].isBaseline).toBe(false);
  });

  it("다른 참여자의 기간 리뷰는 섞이지 않는다", () => {
    insertParticipant(db, "user-a", "EXP");
    insertParticipant(db, "user-b", "EXP");
    insertReview(db, "user-a", 1);
    insertReview(db, "user-b", 1);
    insertReview(db, "user-b", 2);

    expect(getPeriodReviews(db, "user-a").length).toBe(1);
    expect(getPeriodReviews(db, "user-b").length).toBe(2);
  });

  it("TOTAL_PERIODS(파일럿=3) 범위 밖의 periodIndex는 응답에서 제외한다(상수 변경 후 남은 옛 행 방어)", () => {
    insertParticipant(db, "exp-user", "EXP");
    insertReview(db, "exp-user", 1);
    insertReview(db, "exp-user", 99); // 옛 설정으로 생성된 범위 밖 행 가정

    const result = getPeriodReviews(db, "exp-user");
    expect(result.map((r) => r.periodIndex)).toEqual([1]);
  });

  // 대조군(CON, TEST-CON) — 연구 종료 + 전체 기간(파일럿 TOTAL_PERIODS=3) 리뷰 생성 완료
  // 여부에 따라 조건부로만 열람을 허용한다. Story 10-10, 명세서 2·7절.
  describe("대조군(CON, TEST-CON) 종료 후 조건부 열람", () => {
    const FIXED_NOW = new Date("2026-06-10T10:00:00+09:00");
    // +6일(TOTAL_DAYS) = 2026-06-07 → FIXED_NOW(6/10) 이전이라 종료된 것으로 판정된다.
    const ENDED_INSTALL_DATE = "2026-06-01T00:00:00+09:00";
    // +6일 = 2026-06-14 → FIXED_NOW(6/10) 이후라 아직 진행 중으로 판정된다.
    const NOT_ENDED_INSTALL_DATE = "2026-06-08T00:00:00+09:00";

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("연구 종료 전이면 리뷰가 이미 쌓여 있어도 빈 배열을 반환한다", () => {
      insertParticipant(db, "con-not-ended", "CON", NOT_ENDED_INSTALL_DATE);
      insertReview(db, "con-not-ended", 1);
      insertReview(db, "con-not-ended", 2);
      insertReview(db, "con-not-ended", 3);

      expect(getPeriodReviews(db, "con-not-ended")).toEqual([]);
    });

    it("종료됐지만 전체 기간 리뷰가 아직 다 생성되지 않았으면 빈 배열을 반환한다", () => {
      insertParticipant(db, "con-incomplete", "CON", ENDED_INSTALL_DATE);
      insertReview(db, "con-incomplete", 1);
      insertReview(db, "con-incomplete", 2); // 3구간 중 2개만 — 아직 미완성

      expect(getPeriodReviews(db, "con-incomplete")).toEqual([]);
    });

    it("종료 + 전체 기간 리뷰 생성 완료 시 CON도 정상적으로 반환한다", () => {
      insertParticipant(db, "con-complete", "CON", ENDED_INSTALL_DATE);
      insertReview(db, "con-complete", 1);
      insertReview(db, "con-complete", 2);
      insertReview(db, "con-complete", 3);
      insertReview(db, "con-complete", 99); // 범위 밖 옛 행 — 응답에 섞이면 안 됨

      const result = getPeriodReviews(db, "con-complete");
      expect(result.map((r) => r.periodIndex)).toEqual([1, 2, 3]);
    });

    it("periodIndex가 1을 포함하지 않으면 개수가 맞아도 잠금이 풀리지 않는다", () => {
      // count=3=TOTAL_PERIODS지만 1구간이 없음 — 범위를 안 보면 잘못 풀리는 경우(coderabbitai 리뷰).
      insertParticipant(db, "con-gap", "CON", ENDED_INSTALL_DATE);
      insertReview(db, "con-gap", 2);
      insertReview(db, "con-gap", 3);
      insertReview(db, "con-gap", 4);

      expect(getPeriodReviews(db, "con-gap")).toEqual([]);
    });

    it("TEST-CON도 CON과 동일한 조건을 따른다", () => {
      insertParticipant(
        db,
        "test-con-complete",
        "TEST-CON",
        ENDED_INSTALL_DATE,
      );
      insertReview(db, "test-con-complete", 1);
      insertReview(db, "test-con-complete", 2);
      insertReview(db, "test-con-complete", 3);

      expect(getPeriodReviews(db, "test-con-complete").length).toBe(3);
    });

    it("EXP는 연구 종료 여부와 무관하게 항상 열람 가능하다(회귀 확인)", () => {
      insertParticipant(db, "exp-not-ended", "EXP", NOT_ENDED_INSTALL_DATE);
      insertReview(db, "exp-not-ended", 1);

      expect(getPeriodReviews(db, "exp-not-ended").length).toBe(1);
    });
  });
});

describe("isStudyEnded / isStudyEndUnlocked", () => {
  let db;
  const FIXED_NOW = new Date("2026-06-10T10:00:00+09:00");
  const ENDED_INSTALL_DATE = "2026-06-01T00:00:00+09:00"; // +6일 = 6/7 → 종료됨
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

  it("isStudyEnded — installDate + TOTAL_DAYS가 지나지 않았으면 false", () => {
    expect(isStudyEnded(NOT_ENDED_INSTALL_DATE)).toBe(false);
  });

  it("isStudyEnded — installDate + TOTAL_DAYS가 지났으면 true", () => {
    expect(isStudyEnded(ENDED_INSTALL_DATE)).toBe(true);
  });

  it("isStudyEndUnlocked — 종료 전이면 리뷰 존재 여부와 무관하게 false", () => {
    insertReview(db, "con-user", 1);
    insertReview(db, "con-user", 2);
    insertReview(db, "con-user", 3);

    expect(isStudyEndUnlocked(db, "con-user", NOT_ENDED_INSTALL_DATE)).toBe(
      false,
    );
  });

  it("isStudyEndUnlocked — 종료 후·미완성이면 false", () => {
    insertReview(db, "con-user", 1);
    insertReview(db, "con-user", 2);

    expect(isStudyEndUnlocked(db, "con-user", ENDED_INSTALL_DATE)).toBe(false);
  });

  it("isStudyEndUnlocked — 종료 후·전체 기간 완성이면 true", () => {
    insertReview(db, "con-user", 1);
    insertReview(db, "con-user", 2);
    insertReview(db, "con-user", 3);

    expect(isStudyEndUnlocked(db, "con-user", ENDED_INSTALL_DATE)).toBe(true);
  });

  it("isStudyEndUnlocked — periodIndex가 1..TOTAL_PERIODS 범위를 벗어나면 개수가 맞아도 false", () => {
    // count=3=TOTAL_PERIODS지만 1구간이 없음(2,3,4) — 단순 COUNT(*)만 보면 잘못 true가 됨.
    insertReview(db, "con-user", 2);
    insertReview(db, "con-user", 3);
    insertReview(db, "con-user", 4);

    expect(isStudyEndUnlocked(db, "con-user", ENDED_INSTALL_DATE)).toBe(false);
  });
});
