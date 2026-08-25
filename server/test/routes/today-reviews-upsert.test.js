import { describe, it, expect, afterEach, beforeEach } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { upsertTodayReview } from "../../routes/today-reviews-upsert.js";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
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
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT
    );
    CREATE UNIQUE INDEX idx_today_reviews_participant_date
      ON today_reviews(anonymousId, reviewDate);
  `);
  return db;
}

function basePayload(overrides = {}) {
  return {
    anonymousId: "exp-user",
    reviewDate: "2026-08-13",
    sessionCount: 2,
    videoCount: 7,
    categoryDistribution: { 게임: 0.6, 뉴스: 0.4 },
    entropy: 0.97,
    review: "오늘은 게임과 뉴스를 두루 보셨네요.",
    reviewTopic: "게임과 뉴스",
    source: "llm",
    promptVersion: "viewlens-today-mirror-v1.0",
    llmStatus: "success",
    failureReason: null,
    geminiMs: 850,
    genCount: 1,
    generatedAt: "2026-08-13T10:00:00+09:00",
    ...overrides,
  };
}

describe("upsertTodayReview", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("행이 없으면 새로 삽입한다", () => {
    upsertTodayReview(db, basePayload());

    const rows = db.prepare("SELECT * FROM today_reviews").all();
    expect(rows.length).toBe(1);
    expect(rows[0].anonymousId).toBe("exp-user");
    expect(rows[0].reviewDate).toBe("2026-08-13");
    expect(rows[0].review).toBe("오늘은 게임과 뉴스를 두루 보셨네요.");
    expect(JSON.parse(rows[0].categoryDistribution)).toEqual({
      게임: 0.6,
      뉴스: 0.4,
    });
  });

  it("같은 (anonymousId, reviewDate)로 여러 번 upsert해도 행이 1개로 유지되고 최신본으로 갱신된다", () => {
    upsertTodayReview(db, basePayload({ genCount: 1, review: "첫 번째 리뷰" }));
    upsertTodayReview(db, basePayload({ genCount: 2, review: "두 번째 리뷰" }));
    upsertTodayReview(db, basePayload({ genCount: 3, review: "세 번째 리뷰" }));

    const rows = db.prepare("SELECT * FROM today_reviews").all();
    expect(rows.length).toBe(1);
    expect(rows[0].genCount).toBe(3);
    expect(rows[0].review).toBe("세 번째 리뷰");
  });

  it("역순으로 도착해도(genCount가 더 낮은 요청이 나중에 도착) 최신 genCount가 유지된다", () => {
    upsertTodayReview(db, basePayload({ genCount: 3, review: "세 번째 리뷰" }));
    // 네트워크 지연 등으로 더 이전(genCount 낮음) 요청이 나중에 도착한 상황을 재현
    upsertTodayReview(
      db,
      basePayload({ genCount: 1, review: "첫 번째 리뷰(지연 도착)" }),
    );

    const row = db.prepare("SELECT * FROM today_reviews").get();
    expect(row.genCount).toBe(3);
    expect(row.review).toBe("세 번째 리뷰");
  });

  it("같은 genCount로 재시도 도착해도 정상적으로 갱신된다(멱등)", () => {
    upsertTodayReview(db, basePayload({ genCount: 2, review: "리뷰 A" }));
    upsertTodayReview(
      db,
      basePayload({ genCount: 2, review: "리뷰 A(재시도)" }),
    );

    const row = db.prepare("SELECT * FROM today_reviews").get();
    expect(row.genCount).toBe(2);
    expect(row.review).toBe("리뷰 A(재시도)");
  });

  it("기존 행의 genCount가 없으면(과거 데이터) 비교 없이 항상 덮어쓴다", () => {
    upsertTodayReview(
      db,
      basePayload({ genCount: undefined, review: "genCount 없는 옛 리뷰" }),
    );
    upsertTodayReview(db, basePayload({ genCount: 1, review: "새 리뷰" }));

    const row = db.prepare("SELECT * FROM today_reviews").get();
    expect(row.genCount).toBe(1);
    expect(row.review).toBe("새 리뷰");
  });

  it("날짜가 다르면 별도 행으로 저장된다", () => {
    upsertTodayReview(db, basePayload({ reviewDate: "2026-08-12" }));
    upsertTodayReview(db, basePayload({ reviewDate: "2026-08-13" }));

    const rows = db.prepare("SELECT * FROM today_reviews").all();
    expect(rows.length).toBe(2);
  });

  it("참여자가 다르면 같은 날짜여도 별도 행으로 저장된다", () => {
    upsertTodayReview(db, basePayload({ anonymousId: "user-a" }));
    upsertTodayReview(db, basePayload({ anonymousId: "user-b" }));

    const rows = db.prepare("SELECT * FROM today_reviews").all();
    expect(rows.length).toBe(2);
  });

  it("fallback 결과도 llmStatus/failureReason과 함께 저장된다", () => {
    upsertTodayReview(
      db,
      basePayload({
        source: "fallback",
        llmStatus: "fallback",
        failureReason: "timeout",
      }),
    );

    const row = db.prepare("SELECT * FROM today_reviews").get();
    expect(row.source).toBe("fallback");
    expect(row.llmStatus).toBe("fallback");
    expect(row.failureReason).toBe("timeout");
  });

  it("선택 필드가 없어도(null) 저장된다", () => {
    upsertTodayReview(
      db,
      basePayload({
        sessionCount: undefined,
        videoCount: undefined,
        categoryDistribution: undefined,
        entropy: undefined,
        review: undefined,
        reviewTopic: undefined,
        source: undefined,
        promptVersion: undefined,
        llmStatus: undefined,
        failureReason: undefined,
        geminiMs: undefined,
        genCount: undefined,
      }),
    );

    const row = db.prepare("SELECT * FROM today_reviews").get();
    expect(row.sessionCount).toBeNull();
    expect(row.categoryDistribution).toBeNull();
    expect(row.review).toBeNull();
  });

  it("갱신 시 updatedAt이 채워진다", () => {
    upsertTodayReview(db, basePayload());
    const row = db.prepare("SELECT * FROM today_reviews").get();
    expect(row.updatedAt).not.toBeNull();
  });
});
