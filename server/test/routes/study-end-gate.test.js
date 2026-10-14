import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import request from "supertest";
import express from "express";
import Database from "better-sqlite3-multiple-ciphers";
import {
  success,
  fail,
  ERROR_CODES,
  errorHandler,
} from "../../middleware/responseHandler.js";
import { rateLimiter } from "../../middleware/rateLimiter.js";
import { verifyAndRecordStudyEndCode } from "../../routes/study-end-code-validation.js";
import { getPeriodReviews } from "../../routes/period-reviews-query.js";

// 대조군 종료 게이트 통합 흐름

process.env.STUDY_END_REVEAL_CODE = "SURVEY2026";

const db = new Database(":memory:");
db.exec(`
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

afterAll(() => {
  db.close();
});

function buildApp() {
  const app = express();
  app.use(express.json());

  const studyEndCodeRouter = express.Router();
  const validateRateLimit = rateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });
  studyEndCodeRouter.post("/validate", validateRateLimit, (req, res) => {
    const { code, anonymousId } = req.body;
    if (typeof code !== "string" || !code.trim()) {
      return fail(
        res,
        400,
        ERROR_CODES.MISSING_REQUIRED_FIELD,
        "code 필드가 필요합니다.",
        "code",
      );
    }
    if (typeof anonymousId !== "string" || !anonymousId.trim()) {
      return fail(
        res,
        400,
        ERROR_CODES.MISSING_REQUIRED_FIELD,
        "anonymousId 필드가 필요합니다.",
        "anonymousId",
      );
    }
    const valid = verifyAndRecordStudyEndCode(
      db,
      anonymousId,
      code,
      process.env.STUDY_END_REVEAL_CODE,
    );
    return success(res, { valid });
  });
  app.use("/api/study-end-code", studyEndCodeRouter);

  const periodReviewsRouter = express.Router();
  periodReviewsRouter.post("/", (req, res) => {
    const anonymousId = (req.body?.anonymousId || "").toString().trim();
    if (!anonymousId) {
      return fail(
        res,
        400,
        ERROR_CODES.MISSING_REQUIRED_FIELD,
        "anonymousId 파라미터가 필요합니다.",
        "anonymousId",
      );
    }
    return success(res, getPeriodReviews(db, anonymousId));
  });
  app.use("/api/period-reviews", periodReviewsRouter);

  app.use(errorHandler);
  return app;
}

const app = buildApp();

// +6일(TOTAL_DAYS, 파일럿값) 지나 FIXED_NOW 기준 이미 종료된 것으로 판정되는 설치일
const ENDED_INSTALL_DATE = "2026-05-25T00:00:00+09:00"; // +12일(TOTAL_DAYS) = 6/6 → 종료됨
const FIXED_NOW = new Date("2026-06-10T10:00:00+09:00");

function insertParticipant(anonymousId, group_code, installDate) {
  db.prepare(
    "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
  ).run(anonymousId, group_code, installDate);
}

function insertPeriodReview(anonymousId, periodIndex) {
  db.prepare(
    `INSERT INTO period_reviews
      (anonymousId, periodIndex, periodStart, periodEnd, isBaseline, generatedAt)
     VALUES (?, ?, '2026-06-01', '2026-06-02', 1, '2026-06-03T04:00:00+09:00')`,
  ).run(anonymousId, periodIndex);
}

beforeEach(() => {
  db.exec("DELETE FROM participants");
  db.exec("DELETE FROM period_reviews");
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("대조군 종료 게이트 — 코드 검증 전후 통합 흐름", () => {
  it("연구 종료 + 전체 기간 완성이어도, 코드 검증 전에는 POST /api/period-reviews가 빈 배열을 반환한다", async () => {
    insertParticipant("con-user", "CON", ENDED_INSTALL_DATE);
    insertPeriodReview("con-user", 1);
    insertPeriodReview("con-user", 2);
    insertPeriodReview("con-user", 3);

    const res = await request(app)
      .post("/api/period-reviews")
      .send({ anonymousId: "con-user" });
    expect(res.body.data).toEqual([]);
  });

  it("틀린 코드로 검증을 시도하면 valid:false이고, 이후 조회해도 여전히 잠겨 있다", async () => {
    insertParticipant("con-user", "CON", ENDED_INSTALL_DATE);
    insertPeriodReview("con-user", 1);
    insertPeriodReview("con-user", 2);
    insertPeriodReview("con-user", 3);

    const validateRes = await request(app)
      .post("/api/study-end-code/validate")
      .send({ code: "WRONG-CODE", anonymousId: "con-user" });
    expect(validateRes.body.data).toEqual({ valid: false });

    const reviewsRes = await request(app)
      .post("/api/period-reviews")
      .send({ anonymousId: "con-user" });
    expect(reviewsRes.body.data).toEqual([]);
  });

  it("올바른 코드로 검증하면 이후 POST /api/period-reviews가 실제로 열린다(핵심 흐름)", async () => {
    insertParticipant("con-user", "CON", ENDED_INSTALL_DATE);
    insertPeriodReview("con-user", 1);
    insertPeriodReview("con-user", 2);
    insertPeriodReview("con-user", 3);

    const validateRes = await request(app)
      .post("/api/study-end-code/validate")
      .send({ code: "survey2026", anonymousId: "con-user" }); // 대소문자 무시 확인
    expect(validateRes.body.data).toEqual({ valid: true });

    const row = db
      .prepare(
        "SELECT studyEndCodeVerifiedAt FROM participants WHERE anonymousId = ?",
      )
      .get("con-user");
    expect(row.studyEndCodeVerifiedAt).not.toBeNull();

    const reviewsRes = await request(app)
      .post("/api/period-reviews")
      .send({ anonymousId: "con-user" });
    expect(reviewsRes.body.data.map((r) => r.periodIndex)).toEqual([1, 2, 3]);
  });
});
