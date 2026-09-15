import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// server/test/routes/period-reviews.test.js와 study-end-gate.test.js는 실제
// server/routes/period-reviews.js를 import하지 않고 쿼리 함수나 흉내낸 라우터로 검증한다.
// 여기서는 실제 파일을 그대로 로드해 배선(HTTP 메서드·바디 파싱)을 검증한다 — anonymousId를
// 쿼리스트링이 아니라 POST 바디로 받도록 바꾼 변경(연구데이터 보호조치 점검 후속 조치)의 회귀 방지용.
const require = createRequire(import.meta.url);
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `viewlens-period-reviews-wiring-${process.pid}.db`,
);
fs.rmSync(TEST_DB_PATH, { force: true });
process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
process.env.DB_PATH = TEST_DB_PATH;

const { db, initializeDB } = require("../../db.js");
initializeDB();

const { errorHandler } = require("../../middleware/responseHandler.js");
const periodReviewsRouter = require("../../routes/period-reviews.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/period-reviews", periodReviewsRouter);
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
  db.exec("DELETE FROM period_reviews");
});

describe("실제 server/routes/period-reviews.js 라우터 배선", () => {
  it("POST /api/period-reviews — anonymousId를 바디로 보내면 정상 응답한다", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
    ).run("wiring-exp", "EXP", "2026-01-01T00:00:00Z");

    const res = await request(app)
      .post("/api/period-reviews")
      .send({ anonymousId: "wiring-exp" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("POST /api/period-reviews — anonymousId 없으면 400", async () => {
    const res = await request(app).post("/api/period-reviews").send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
  });

  it("GET /api/period-reviews — 더 이상 지원하지 않는다(쿼리스트링 노출 경로 제거 회귀 확인)", async () => {
    const res = await request(app)
      .get("/api/period-reviews")
      .query({ anonymousId: "wiring-exp" });
    expect(res.status).toBe(404);
  });
});
