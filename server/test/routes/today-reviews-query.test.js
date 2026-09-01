import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  getTodayReviews,
  isTodayReviewEligible,
} from "../../routes/today-reviews-query.js";
import { isBaselinePeriod as isBaselinePeriodClient } from "../../../extension/pipeline/baseline.js";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL UNIQUE,
      group_code TEXT NOT NULL,
      installDate TEXT NOT NULL,
      studyEndCodeVerifiedAt TEXT
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
      generatedAt TEXT NOT NULL
    );
  `);
  return db;
}

function insertParticipant(
  db,
  anonymousId,
  groupCode,
  installDate,
  studyEndCodeVerifiedAt = null,
) {
  db.prepare(
    "INSERT INTO participants (anonymousId, group_code, installDate, studyEndCodeVerifiedAt) VALUES (?, ?, ?, ?)",
  ).run(anonymousId, groupCode, installDate, studyEndCodeVerifiedAt);
}

function insertTodayReview(db, anonymousId, reviewDate, overrides = {}) {
  db.prepare(
    `INSERT INTO today_reviews
      (anonymousId, reviewDate, sessionCount, videoCount, categoryDistribution,
       entropy, review, reviewTopic, source, promptVersion, generatedAt)
     VALUES (@anonymousId, @reviewDate, @sessionCount, @videoCount, @categoryDistribution,
       @entropy, @review, @reviewTopic, @source, @promptVersion, @generatedAt)`,
  ).run({
    anonymousId,
    reviewDate,
    sessionCount: 1,
    videoCount: 3,
    categoryDistribution: "{}",
    entropy: 0,
    review: `review for ${reviewDate}`,
    reviewTopic: "topic",
    source: "llm",
    promptVersion: "v1",
    generatedAt: `${reviewDate}T12:00:00+09:00`,
    ...overrides,
  });
}

describe("isBaselinePeriod — extension/pipeline/baseline.js와 동치성", () => {
  it.each([
    [
      "설치 직후(0일 경과)",
      "2026-01-01T00:00:00+09:00",
      "2026-01-01T00:00:00+09:00",
    ],
    ["1일 경과", "2026-01-01T00:00:00+09:00", "2026-01-02T00:00:00+09:00"],
    [
      "정확히 베이스라인 경계",
      "2026-01-01T00:00:00+09:00",
      "2026-01-03T00:00:00+09:00",
    ],
    [
      "베이스라인 이후",
      "2026-01-01T00:00:00+09:00",
      "2026-01-05T00:00:00+09:00",
    ],
  ])("%s — 두 구현이 동일한 결과를 낸다", (_label, installDate, nowStr) => {
    const now = new Date(nowStr);
    // isTodayReviewEligible을 거치지 않고 직접 비교할 수 있도록, 같은 installDate/now로
    // 두 참여자를 만들어 isTodayReviewEligible의 EXP 분기를 통해 간접 비교한다.
    const db = createTestDb();
    insertParticipant(db, "u1", "EXP", installDate);
    const participant = db
      .prepare("SELECT * FROM participants WHERE anonymousId = ?")
      .get("u1");
    const serverResult = isTodayReviewEligible(participant, now);
    // EXP는 "베이스라인이 아닐 때만" eligible이므로, eligible === !isBaselinePeriod
    expect(serverResult).toBe(!isBaselinePeriodClient(installDate, now));
    db.close();
  });
});

describe("isTodayReviewEligible — 그룹·자격별 판정", () => {
  const BASELINE_INSTALL = "2026-03-01T00:00:00+09:00";
  const POST_BASELINE_NOW = new Date("2026-03-10T00:00:00+09:00");
  const BASELINE_NOW = new Date("2026-03-01T01:00:00+09:00");

  it("참여자 자체가 없으면(undefined) 자격 없음", () => {
    expect(isTodayReviewEligible(undefined, POST_BASELINE_NOW)).toBe(false);
  });

  it("EXP — 베이스라인 기간 중엔 자격 없음", () => {
    expect(
      isTodayReviewEligible(
        { group_code: "EXP", installDate: BASELINE_INSTALL },
        BASELINE_NOW,
      ),
    ).toBe(false);
  });

  it("EXP — 베이스라인 이후엔 자격 있음", () => {
    expect(
      isTodayReviewEligible(
        { group_code: "EXP", installDate: BASELINE_INSTALL },
        POST_BASELINE_NOW,
      ),
    ).toBe(true);
  });

  it("TEST-EXP — 베이스라인 기간에도 자격 있음(연구자 모드 예외)", () => {
    expect(
      isTodayReviewEligible(
        { group_code: "TEST-EXP", installDate: BASELINE_INSTALL },
        BASELINE_NOW,
      ),
    ).toBe(true);
  });

  it("CON — 연구종료 코드 검증 전엔 자격 없음(설치일이 오래돼도)", () => {
    expect(
      isTodayReviewEligible(
        {
          group_code: "CON",
          installDate: "2020-01-01T00:00:00+09:00",
          studyEndCodeVerifiedAt: null,
        },
        POST_BASELINE_NOW,
      ),
    ).toBe(false);
  });

  it("CON — 연구종료 코드 검증을 통과하면 자격 있음", () => {
    expect(
      isTodayReviewEligible(
        {
          group_code: "CON",
          installDate: BASELINE_INSTALL,
          studyEndCodeVerifiedAt: "2026-03-10T09:00:00+09:00",
        },
        POST_BASELINE_NOW,
      ),
    ).toBe(true);
  });

  it("TEST-CON도 CON과 동일 규칙을 따른다", () => {
    expect(
      isTodayReviewEligible(
        {
          group_code: "TEST-CON",
          installDate: BASELINE_INSTALL,
          studyEndCodeVerifiedAt: "2026-03-10T09:00:00+09:00",
        },
        POST_BASELINE_NOW,
      ),
    ).toBe(true);
  });

  it("알 수 없는 그룹 코드는 자격 없음", () => {
    expect(
      isTodayReviewEligible(
        { group_code: "ETC", installDate: BASELINE_INSTALL },
        POST_BASELINE_NOW,
      ),
    ).toBe(false);
  });
});

describe("getTodayReviews — DB 통합", () => {
  let db;
  afterEach(() => {
    db?.close();
    vi.useRealTimers();
  });

  it("참여자가 존재하지 않으면 빈 배열", () => {
    db = createTestDb();
    expect(getTodayReviews(db, "no-such-user")).toEqual([]);
  });

  it("EXP 베이스라인 기간 중엔 리뷰 행이 있어도 빈 배열", () => {
    db = createTestDb();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T01:00:00+09:00"));
    insertParticipant(db, "exp-baseline", "EXP", "2026-03-01T00:00:00+09:00");
    insertTodayReview(db, "exp-baseline", "2026-03-01");

    expect(getTodayReviews(db, "exp-baseline")).toEqual([]);
  });

  it("EXP 베이스라인 이후엔 reviewDate 오름차순으로 전체 이력을 반환한다", () => {
    db = createTestDb();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T00:00:00+09:00"));
    insertParticipant(db, "exp-active", "EXP", "2026-03-01T00:00:00+09:00");
    insertTodayReview(db, "exp-active", "2026-03-05");
    insertTodayReview(db, "exp-active", "2026-03-03");

    const rows = getTodayReviews(db, "exp-active");
    expect(rows.map((r) => r.reviewDate)).toEqual(["2026-03-03", "2026-03-05"]);
  });

  it("CON은 코드 검증 전이면 리뷰 행이 있어도 빈 배열", () => {
    db = createTestDb();
    insertParticipant(
      db,
      "con-unverified",
      "CON",
      "2020-01-01T00:00:00+09:00",
      null,
    );
    insertTodayReview(db, "con-unverified", "2026-03-05");

    expect(getTodayReviews(db, "con-unverified")).toEqual([]);
  });

  it("CON은 코드 검증 후 전체 이력을 반환한다", () => {
    db = createTestDb();
    insertParticipant(
      db,
      "con-verified",
      "CON",
      "2020-01-01T00:00:00+09:00",
      "2026-03-10T09:00:00+09:00",
    );
    insertTodayReview(db, "con-verified", "2026-03-05");

    const rows = getTodayReviews(db, "con-verified");
    expect(rows).toHaveLength(1);
    expect(rows[0].reviewDate).toBe("2026-03-05");
  });
});
