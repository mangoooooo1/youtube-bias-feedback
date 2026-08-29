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
  periodReviewsRouter.get("/", (req, res) => {
    const anonymousId = (req.query.anonymousId || "").toString().trim();
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
const ENDED_INSTALL_DATE = "2026-06-01T00:00:00+09:00";
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
  it("연구 종료 + 전체 기간 완성이어도, 코드 검증 전에는 GET /api/period-reviews가 빈 배열을 반환한다", async () => {
    insertParticipant("con-user", "CON", ENDED_INSTALL_DATE);
    insertPeriodReview("con-user", 1);
    insertPeriodReview("con-user", 2);
    insertPeriodReview("con-user", 3);

    const res = await request(app)
      .get("/api/period-reviews")
      .query({ anonymousId: "con-user" });
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
      .get("/api/period-reviews")
      .query({ anonymousId: "con-user" });
    expect(reviewsRes.body.data).toEqual([]);
  });

  it("올바른 코드로 검증하면 이후 GET /api/period-reviews가 실제로 열린다(핵심 흐름)", async () => {
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
      .get("/api/period-reviews")
      .query({ anonymousId: "con-user" });
    expect(reviewsRes.body.data.map((r) => r.periodIndex)).toEqual([1, 2, 3]);
  });

  it("아직 연구가 종료되지 않은 대조군은 올바른 코드를 보내도 검증되지 않는다", async () => {
    const notEndedInstallDate = "2026-06-08T00:00:00+09:00"; // +6일 = 6/14, FIXED_NOW(6/10) 이전이라 진행 중
    insertParticipant("con-early", "CON", notEndedInstallDate);

    const res = await request(app)
      .post("/api/study-end-code/validate")
      .send({ code: "SURVEY2026", anonymousId: "con-early" });
    expect(res.body.data).toEqual({ valid: false });
  });

  it("EXP 참여자는 코드 검증 절차와 무관하게 항상 열람 가능하다(회귀 확인)", async () => {
    insertParticipant("exp-user", "EXP", "2026-01-01T00:00:00+09:00");
    insertPeriodReview("exp-user", 1);

    const res = await request(app)
      .get("/api/period-reviews")
      .query({ anonymousId: "exp-user" });
    expect(res.body.data).toHaveLength(1);
  });

  it("코드 필드가 없으면 400을 반환하고 아무것도 기록하지 않는다", async () => {
    insertParticipant("con-user", "CON", ENDED_INSTALL_DATE);

    const res = await request(app)
      .post("/api/study-end-code/validate")
      .send({ anonymousId: "con-user" });
    expect(res.status).toBe(400);

    const row = db
      .prepare(
        "SELECT studyEndCodeVerifiedAt FROM participants WHERE anonymousId = ?",
      )
      .get("con-user");
    expect(row.studyEndCodeVerifiedAt).toBeNull();
  });

  it("15분에 5회를 초과해 검증을 시도하면 429를 반환한다(레이트리밋 배선 확인)", async () => {
    insertParticipant("con-user", "CON", ENDED_INSTALL_DATE);

    // 공유 app(모듈 최상단에서 buildApp()을 한 번만 호출)을 쓰면 앞선 테스트들의 POST가
    // 같은 IP의 할당량을 이미 소비해, max가 5가 아니라 1이어도 이 테스트가 우연히
    // 통과할 수 있다 — buildApp()을 다시 호출해 이 테스트 전용 rate limiter 인스턴스를 쓴다.
    const isolatedApp = buildApp();

    for (let i = 0; i < 5; i++) {
      const res = await request(isolatedApp)
        .post("/api/study-end-code/validate")
        .send({ code: "WRONG", anonymousId: "con-user" });
      expect(res.status).toBe(200);
    }

    const sixthRes = await request(isolatedApp)
      .post("/api/study-end-code/validate")
      .send({ code: "WRONG", anonymousId: "con-user" });
    expect(sixthRes.status).toBe(429);
  });
});
