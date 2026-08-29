import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// server/test/routes/sessions.test.js는 실제 server/routes/sessions.js를 import하지 않고
// 동일 로직을 흉내 낸 테스트 전용 라우터(buildTestRouter)로 검증한다. sessions.js 자체의
// 배선(라우트 등록, require 순서, module.exports)은 그 테스트로는 실행되지 않는다.
// 여기서는 실제 파일을 그대로 로드해 그 배선까지 검증한다. server/db.js가 모듈 최상단에서
// 실제 암호화 DB를 여는 문제(위 파일 참고)는 DB_PATH를 임시 파일로 오버라이드해 피한다.
// 운영 DB 파일을 열 위험 없이 실제 sessions.js를 그대로 require할 수 있다.
const require = createRequire(import.meta.url);
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `viewlens-sessions-wiring-${process.pid}.db`,
);
fs.rmSync(TEST_DB_PATH, { force: true });
process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
process.env.DB_PATH = TEST_DB_PATH;

const { db, initializeDB } = require("../../db.js");
initializeDB();

const { errorHandler } = require("../../middleware/responseHandler.js");
const sessionsRouter = require("../../routes/sessions.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", sessionsRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

afterAll(() => {
  db.close();
  fs.rmSync(TEST_DB_PATH, { force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM sessions");
});

function basePayload(overrides = {}) {
  return {
    anonymousId: "wiring-user",
    sessionId: "wiring-s1",
    startTime: "2026-08-13T09:00:00+09:00",
    endTime: "2026-08-13T09:10:00+09:00",
    videoCount: 2,
    categoryDistribution: { 게임: 1 },
    entropy: 0,
    ...overrides,
  };
}

describe("실제 server/routes/sessions.js 라우터 배선", () => {
  it("POST /api/sessions — 파일을 그대로 로드해도 정상 저장된다", async () => {
    const res = await request(app).post("/api/sessions").send(basePayload());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const row = db
      .prepare("SELECT * FROM sessions WHERE sessionId = ?")
      .get("wiring-s1");
    expect(row.anonymousId).toBe("wiring-user");
  });

  it("POST /api/sessions — 필수 필드 누락 시 400 (validateSession이 실제로 연결돼 있는지)", async () => {
    const payload = basePayload();
    delete payload.anonymousId;

    const res = await request(app).post("/api/sessions").send(payload);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
    expect(db.prepare("SELECT COUNT(*) AS c FROM sessions").get().c).toBe(0);
  });

  it("POST /api/sessions — 중복 sessionId는 409 (unique 제약 에러 처리가 실제로 연결돼 있는지)", async () => {
    await request(app).post("/api/sessions").send(basePayload());
    const res = await request(app).post("/api/sessions").send(basePayload());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_SESSION");
  });

  it("PATCH /api/sessions/:sessionId/feedback-viewed — 실제 파일에 라우트가 등록돼 응답한다", async () => {
    await request(app).post("/api/sessions").send(basePayload());
    const res = await request(app)
      .patch("/api/sessions/wiring-s1/feedback-viewed")
      .send({ anonymousId: "wiring-user" });

    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT * FROM sessions WHERE sessionId = ?")
      .get("wiring-s1");
    expect(row.feedbackViewedAt).not.toBeNull();
  });

  it("PATCH /api/sessions/:sessionId/feedback-confirmed — 실제 파일에 라우트가 등록돼 응답한다", async () => {
    await request(app).post("/api/sessions").send(basePayload());
    const res = await request(app)
      .patch("/api/sessions/wiring-s1/feedback-confirmed")
      .send({ anonymousId: "wiring-user" });

    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT * FROM sessions WHERE sessionId = ?")
      .get("wiring-s1");
    expect(row.feedbackConfirmedAt).not.toBeNull();
  });

  it("등록되지 않은 경로는 404 — 예기치 않은 라우트가 실수로 노출되지 않았는지 확인", async () => {
    const res = await request(app).get("/api/sessions/wiring-s1/no-such-route");
    expect(res.status).toBe(404);
  });
});
