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
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 대조군 종료 게이트 통합 흐름 — 코드 검증(study-end-code.js) 후 기간 리뷰 조회(period-reviews.js)가
// 실제로 열리는지를 두 실제 라우터와 실제 db.js 스키마로 검증한다.
// 단일 API 동작은 study-end-code.wiring.test.js·period-reviews.wiring.test.js가 맡는다.
const require = createRequire(import.meta.url);
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `viewlens-study-end-gate-${process.pid}.db`,
);
fs.rmSync(TEST_DB_PATH, { force: true });
process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
process.env.DB_PATH = TEST_DB_PATH;

const { db, initializeDB } = require("../../db.js");
initializeDB();

const { errorHandler } = require("../../middleware/responseHandler.js");
const studyEndCodeRouter = require("../../routes/study-end-code.js");
const periodReviewsRouter = require("../../routes/period-reviews.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/study-end-code", studyEndCodeRouter);
  app.use("/api/period-reviews", periodReviewsRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

// +12일(TOTAL_DAYS) = 6/6 → FIXED_NOW 기준 이미 종료됨
const ENDED_INSTALL_DATE = "2026-05-25T00:00:00+09:00";
const FIXED_NOW = new Date("2026-06-10T10:00:00+09:00");

// 레이트리밋 상태가 라우터 모듈 단위라 테스트끼리 한도를 나누지 않게 테스트마다 IP를 다르게 준다
let ipSeq = 0;
const nextIp = () => `10.30.0.${++ipSeq}`;

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

const originalRevealCode = process.env.STUDY_END_REVEAL_CODE;
const originalTokenSecret = process.env.PARTICIPANT_TOKEN_SECRET;

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterAll(() => {
  db.close();
  fs.rmSync(TEST_DB_PATH, { force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM participants");
  db.exec("DELETE FROM period_reviews");
  process.env.STUDY_END_REVEAL_CODE = "SURVEY2026";
  delete process.env.PARTICIPANT_TOKEN_SECRET;
  // 실제 HTTP·DB를 쓰므로 날짜만 고정하고 타이머는 그대로 둔다
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  restoreEnv("STUDY_END_REVEAL_CODE", originalRevealCode);
  restoreEnv("PARTICIPANT_TOKEN_SECRET", originalTokenSecret);
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
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("틀린 코드로 검증을 시도하면 valid:false이고, 이후 조회해도 여전히 잠겨 있다", async () => {
    insertParticipant("con-user", "CON", ENDED_INSTALL_DATE);
    insertPeriodReview("con-user", 1);
    insertPeriodReview("con-user", 2);
    insertPeriodReview("con-user", 3);

    const validateRes = await request(app)
      .post("/api/study-end-code/validate")
      .set("X-Real-IP", nextIp())
      .send({ code: "WRONG-CODE", anonymousId: "con-user" });
    expect(validateRes.body.data).toEqual({ valid: false });

    const reviewsRes = await request(app)
      .post("/api/period-reviews")
      .send({ anonymousId: "con-user" });
    expect(reviewsRes.status).toBe(200);
    expect(reviewsRes.body.data).toEqual([]);
  });

  it("올바른 코드로 검증하면 이후 POST /api/period-reviews가 실제로 열린다(핵심 흐름)", async () => {
    insertParticipant("con-user", "CON", ENDED_INSTALL_DATE);
    insertPeriodReview("con-user", 1);
    insertPeriodReview("con-user", 2);
    insertPeriodReview("con-user", 3);

    const validateRes = await request(app)
      .post("/api/study-end-code/validate")
      .set("X-Real-IP", nextIp())
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
