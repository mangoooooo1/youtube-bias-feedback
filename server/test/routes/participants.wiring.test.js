import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// server/test/routes/participants.test.js는 실제 server/routes/participants.js를 import하지
// 않고, 그 안의 일부 라우트(POST /, GET /validate)만 흉내 낸 테스트 전용 라우터로 검증한다.
// participants.js 자체의 배선은 물론, /recover·/study-end-review-event 라우트는 그 테스트로
// 아예 실행되지 않는다. 여기서는 실제 파일을 그대로 로드해 전체 라우트 배선을 검증한다.
const require = createRequire(import.meta.url);
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `viewlens-participants-wiring-${process.pid}.db`,
);
fs.rmSync(TEST_DB_PATH, { force: true });
process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
process.env.DB_PATH = TEST_DB_PATH;

const { db, initializeDB } = require("../../db.js");
initializeDB();

const { errorHandler } = require("../../middleware/responseHandler.js");
const participantsRouter = require("../../routes/participants.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/participants", participantsRouter);
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
  db.exec("DELETE FROM issued_codes");
});

describe("실제 server/routes/participants.js 라우터 배선", () => {
  it("POST /api/participants — 파일을 그대로 로드해도 정상 등록된다", async () => {
    const res = await request(app).post("/api/participants").send({
      anonymousId: "wiring-a1",
      group_code: "EXP",
      installDate: "2026-08-13T00:00:00Z",
    });
    expect(res.status).toBe(200);

    const row = db
      .prepare("SELECT * FROM participants WHERE anonymousId = ?")
      .get("wiring-a1");
    expect(row.group_code).toBe("EXP");
  });

  it("GET /api/participants/validate — 실제 파일에 라우트가 등록돼 응답한다", async () => {
    const res = await request(app)
      .get("/api/participants/validate")
      .query({ code: "ANY-CODE" });
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(true);
  });

  it("GET /api/participants/validate — code 파라미터 없으면 400", async () => {
    const res = await request(app).get("/api/participants/validate");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
  });

  it("POST /api/participants/recover — 옛 duplicate 라우터엔 아예 없던 라우트, 실제 파일엔 등록돼 있다", async () => {
    const res = await request(app)
      .post("/api/participants/recover")
      .send({ participantCode: "UNKNOWN-CODE" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("POST /api/participants/recover — TEST 코드는 복구 불가(400)", async () => {
    const res = await request(app)
      .post("/api/participants/recover")
      .send({ participantCode: "TEST-EXP" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FIELD_VALUE");
  });

  it("POST /api/participants/study-end-review-event — 옛 duplicate 라우터엔 아예 없던 라우트, 실제 파일엔 등록돼 있다", async () => {
    const res = await request(app)
      .post("/api/participants/study-end-review-event")
      .send({ anonymousId: "no-such-participant", event: "modal_shown" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("POST /api/participants/study-end-review-event — event 값이 잘못되면 400", async () => {
    const res = await request(app)
      .post("/api/participants/study-end-review-event")
      .send({ anonymousId: "wiring-a1", event: "not-a-real-event" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FIELD_VALUE");
  });

  it("등록되지 않은 경로는 404 — 예기치 않은 라우트가 실수로 노출되지 않았는지 확인", async () => {
    const res = await request(app).get("/api/participants/no-such-route");
    expect(res.status).toBe(404);
  });
});
