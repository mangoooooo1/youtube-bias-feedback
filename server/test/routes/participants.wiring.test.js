import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import crypto from "crypto";
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

  it("소문자 participantCode — GET /validate가 통과시키면 POST /도 동일 코드로 등록에 성공한다(회귀)", async () => {
    db.prepare(
      "INSERT INTO issued_codes (code, group_code) VALUES (?, ?)",
    ).run("REAL-CODE", "CON");

    const validateRes = await request(app)
      .get("/api/participants/validate")
      .query({ code: "real-code" });
    expect(validateRes.body.data.valid).toBe(true);

    const registerRes = await request(app).post("/api/participants").send({
      anonymousId: "wiring-a2",
      group_code: "EXP",
      installDate: "2026-08-13T00:00:00Z",
      participantCode: "real-code",
    });
    expect(registerRes.status).toBe(200);
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
    // requireParticipant가 먼저 통과해야 event 검증까지 도달하므로, 등록된 참여자여야 한다.
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
    ).run("wiring-a1", "EXP", "2026-08-13T00:00:00Z");

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

// anonymousId 소유권 증명용 토큰 발급 — period-reviews/today-reviews 등 조회 라우트가
// requireParticipant로 강제하는 토큰의 발급 지점(IDOR 대응, 코드리뷰 지적).
describe("실제 server/routes/participants.js — participantToken 발급", () => {
  const originalSecret = process.env.PARTICIPANT_TOKEN_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.PARTICIPANT_TOKEN_SECRET;
    } else {
      process.env.PARTICIPANT_TOKEN_SECRET = originalSecret;
    }
  });

  it("PARTICIPANT_TOKEN_SECRET 미설정이면 등록 응답에 participantToken이 없다(기존 동작과 동일, 하위호환)", async () => {
    delete process.env.PARTICIPANT_TOKEN_SECRET;
    const res = await request(app).post("/api/participants").send({
      anonymousId: "no-token-user",
      group_code: "EXP",
      installDate: "2026-08-13T00:00:00Z",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.participantToken).toBeNull();
  });

  it("PARTICIPANT_TOKEN_SECRET 설정 시 등록 응답에 그 anonymousId로 검증 가능한 토큰이 실린다", async () => {
    process.env.PARTICIPANT_TOKEN_SECRET = "reg-test-secret";
    const res = await request(app).post("/api/participants").send({
      anonymousId: "token-user",
      group_code: "EXP",
      installDate: "2026-08-13T00:00:00Z",
    });
    expect(res.status).toBe(200);

    const expected = crypto
      .createHmac("sha256", "reg-test-secret")
      .update("token-user")
      .digest("hex");
    expect(res.body.data.participantToken).toBe(expected);
  });

  it("이미 등록된 참여자가 재동기화(멱등 재등록)해도 같은 토큰을 다시 받는다", async () => {
    process.env.PARTICIPANT_TOKEN_SECRET = "reg-test-secret";
    const payload = {
      anonymousId: "resync-user",
      group_code: "EXP",
      installDate: "2026-08-13T00:00:00Z",
    };
    const first = await request(app).post("/api/participants").send(payload);
    const second = await request(app).post("/api/participants").send(payload);
    expect(first.body.data.participantToken).toBe(
      second.body.data.participantToken,
    );
  });

  it("재설치 복구(POST /recover) 응답에도 그 anonymousId로 검증 가능한 토큰이 실린다", async () => {
    process.env.PARTICIPANT_TOKEN_SECRET = "recover-test-secret";
    db.prepare(
      "INSERT INTO participants (anonymousId, participantCode, group_code, installDate) VALUES (?, ?, ?, ?)",
    ).run(
      "recovered-user",
      "RECOVER-CODE",
      "EXP",
      "2026-08-13T00:00:00Z",
    );

    const res = await request(app)
      .post("/api/participants/recover")
      .send({ participantCode: "RECOVER-CODE" });
    expect(res.status).toBe(200);

    const expected = crypto
      .createHmac("sha256", "recover-test-secret")
      .update("recovered-user")
      .digest("hex");
    expect(res.body.data.participantToken).toBe(expected);
  });
});
