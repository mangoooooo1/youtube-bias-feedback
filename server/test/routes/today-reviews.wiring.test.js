import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import crypto from "crypto";
import request from "supertest";
import express from "express";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// today-reviews-query.test.js/today-reviews-upsert.test.js는 쿼리·저장 함수만 검증하고
// 실제 server/routes/today-reviews.js는 로드하지 않는다. 여기서는 실제 파일을 그대로 로드해
// 배선(HTTP 메서드·바디 파싱)을 검증한다 — anonymousId를 쿼리스트링이 아니라 POST 바디로
// 받도록 바꾼 변경(연구데이터 보호조치 점검 후속 조치)의 회귀 방지용.
const require = createRequire(import.meta.url);
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `viewlens-today-reviews-wiring-${process.pid}.db`,
);
fs.rmSync(TEST_DB_PATH, { force: true });
process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
process.env.DB_PATH = TEST_DB_PATH;

const { db, initializeDB } = require("../../db.js");
initializeDB();

const { errorHandler } = require("../../middleware/responseHandler.js");
const todayReviewsRouter = require("../../routes/today-reviews.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/today-reviews", todayReviewsRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

afterAll(() => {
  db.close();
  fs.rmSync(TEST_DB_PATH, { force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM participants");
  db.exec("DELETE FROM today_reviews");
});

describe("실제 server/routes/today-reviews.js 라우터 배선", () => {
  it("POST /api/today-reviews — anonymousId를 바디로 보내면 정상 응답한다", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
    ).run("wiring-test-exp", "TEST-EXP", "2026-01-01T00:00:00Z");

    const res = await request(app)
      .post("/api/today-reviews")
      .send({ anonymousId: "wiring-test-exp" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("POST /api/today-reviews — anonymousId 없으면 400", async () => {
    const res = await request(app).post("/api/today-reviews").send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
  });

  it("GET /api/today-reviews — 더 이상 지원하지 않는다(쿼리스트링 노출 경로 제거 회귀 확인)", async () => {
    const res = await request(app)
      .get("/api/today-reviews")
      .query({ anonymousId: "wiring-test-exp" });
    expect(res.status).toBe(404);
  });
});

// IDOR 방지 — 다른 참여자의 anonymousId를 아는 것만으로 그 사람의 리뷰를 조회할 수 있던
// 문제(코드리뷰 지적)의 회귀 확인. PARTICIPANT_TOKEN_SECRET을 실제로 설정했을 때만
// requireParticipant가 토큰을 강제하므로, 이 describe 안에서만 켠다.
describe("POST /api/today-reviews — PARTICIPANT_TOKEN_SECRET 설정 시 소유권 검증", () => {
  const originalSecret = process.env.PARTICIPANT_TOKEN_SECRET;
  const SECRET = "wiring-test-secret";

  beforeEach(() => {
    process.env.PARTICIPANT_TOKEN_SECRET = SECRET;
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
    ).run("token-owner", "TEST-EXP", "2026-01-01T00:00:00Z");
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.PARTICIPANT_TOKEN_SECRET;
    } else {
      process.env.PARTICIPANT_TOKEN_SECRET = originalSecret;
    }
  });

  function tokenFor(anonymousId) {
    return crypto
      .createHmac("sha256", SECRET)
      .update(anonymousId)
      .digest("hex");
  }

  it("유효한 토큰이면 200", async () => {
    const res = await request(app).post("/api/today-reviews").send({
      anonymousId: "token-owner",
      participantToken: tokenFor("token-owner"),
    });
    expect(res.status).toBe(200);
  });

  it("토큰이 아예 없으면 403 — anonymousId만 아는 것으로는 더 이상 조회할 수 없다", async () => {
    const res = await request(app)
      .post("/api/today-reviews")
      .send({ anonymousId: "token-owner" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("INVALID_PARTICIPANT_TOKEN");
  });

  it("다른 참여자의 토큰이면 403(IDOR 시나리오 그대로 재현)", async () => {
    const res = await request(app).post("/api/today-reviews").send({
      anonymousId: "token-owner",
      participantToken: tokenFor("someone-else"),
    });
    expect(res.status).toBe(403);
  });
});
