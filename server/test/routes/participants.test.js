import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import Database from "better-sqlite3-multiple-ciphers";
import {
  success,
  fail,
  ERROR_CODES,
  errorHandler,
} from "../../middleware/responseHandler.js";
import {
  registerParticipant,
  validateParticipantCode,
} from "../../routes/participants-store.js";

// participants.js도 sessions.js와 동일한 이유(모듈 최상단에서 실제 DB 싱글턴을 열고,
// 네이티브 모듈이 vi.mock을 우회함, server/test/routes/sessions.test.js 참고)로 그대로
// import할 수 없다. 실제 라우트가 호출하는 함수(registerParticipant/validateParticipantCode)를
// 그대로 가져와 동일하게 조립한 테스트 전용 라우터로 검증한다.
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anonymousId TEXT NOT NULL UNIQUE,
    participantCode TEXT,
    group_code TEXT NOT NULL,
    installDate TEXT NOT NULL
  );
  CREATE TABLE issued_codes (
    code TEXT PRIMARY KEY,
    group_code TEXT NOT NULL
  );
`);

afterAll(() => {
  db.close();
});

function buildTestRouter() {
  const router = express.Router();

  router.post("/", (req, res, next) => {
    let result;
    try {
      result = registerParticipant(db, req.body);
    } catch (err) {
      return next(err);
    }
    switch (result.status) {
      case "missing_field":
        return fail(
          res,
          400,
          ERROR_CODES.MISSING_REQUIRED_FIELD,
          `${result.field} 필드가 올바르지 않습니다.`,
          result.field,
        );
      case "invalid_install_date":
        return fail(
          res,
          400,
          ERROR_CODES.INVALID_FIELD_VALUE,
          "installDate 필드가 올바르지 않습니다.",
          "installDate",
        );
      case "missing_participant_code":
        return fail(
          res,
          400,
          ERROR_CODES.MISSING_REQUIRED_FIELD,
          "참여 코드가 필요합니다.",
          "participantCode",
        );
      case "invalid_participant_code":
        return fail(
          res,
          400,
          ERROR_CODES.INVALID_FIELD_VALUE,
          "발급되지 않은 참여 코드입니다.",
          "participantCode",
        );
      default:
        return success(res);
    }
  });

  router.get("/validate", (req, res) => {
    const code = (req.query.code || "").toString().trim().toUpperCase();
    if (!code) {
      return fail(
        res,
        400,
        ERROR_CODES.MISSING_REQUIRED_FIELD,
        "code 파라미터가 필요합니다.",
        "code",
      );
    }
    return success(res, validateParticipantCode(db, code));
  });

  return router;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/participants", buildTestRouter());
  app.use(errorHandler);
  return app;
}

const app = buildApp();

function seedIssuedCode(code, group_code) {
  db.prepare(
    "INSERT INTO issued_codes (code, group_code) VALUES (?, ?)",
  ).run(code, group_code);
}

beforeEach(() => {
  db.exec("DELETE FROM participants");
  db.exec("DELETE FROM issued_codes");
});

describe("POST /api/participants", () => {
  it("발급 코드 명단이 비어 있으면(시드 전) 코드 없이도 등록된다", async () => {
    const res = await request(app).post("/api/participants").send({
      anonymousId: "a1",
      group_code: "EXP",
      installDate: "2026-08-13T00:00:00Z",
    });
    expect(res.status).toBe(200);

    const row = db
      .prepare("SELECT * FROM participants WHERE anonymousId = ?")
      .get("a1");
    expect(row.group_code).toBe("EXP");
  });

  it.each(["anonymousId", "group_code", "installDate"])(
    "%s가 없으면 400을 반환하고 저장하지 않는다",
    async (field) => {
      const payload = {
        anonymousId: "a1",
        group_code: "EXP",
        installDate: "2026-08-13T00:00:00Z",
      };
      delete payload[field];

      const res = await request(app).post("/api/participants").send(payload);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: "MISSING_REQUIRED_FIELD",
        detail: field,
      });
      expect(
        db.prepare("SELECT COUNT(*) AS c FROM participants").get().c,
      ).toBe(0);
    },
  );

  it("installDate가 파싱 불가능하면 400을 반환한다", async () => {
    const res = await request(app).post("/api/participants").send({
      anonymousId: "a1",
      group_code: "EXP",
      installDate: "not-a-date",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FIELD_VALUE");
  });

  it("이미 등록된 anonymousId는 발급 코드 검증 없이 그대로 성공 처리한다(멱등)", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
    ).run("a1", "EXP", "2026-08-13T00:00:00Z");
    seedIssuedCode("REAL-CODE", "CON");

    // 잘못된/미기재 참여 코드를 보내도(원래라면 400) 이미 등록된 사용자라 통과해야 한다
    const res = await request(app).post("/api/participants").send({
      anonymousId: "a1",
      group_code: "EXP",
      installDate: "2026-08-13T00:00:00Z",
    });
    expect(res.status).toBe(200);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM participants").get().c,
    ).toBe(1);
  });

  describe("발급 코드 명단이 있을 때", () => {
    beforeEach(() => {
      seedIssuedCode("REAL-CODE", "CON");
    });

    it("participantCode가 없으면 400을 반환한다", async () => {
      const res = await request(app).post("/api/participants").send({
        anonymousId: "a1",
        group_code: "EXP",
        installDate: "2026-08-13T00:00:00Z",
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: "MISSING_REQUIRED_FIELD",
        detail: "participantCode",
      });
    });

    it("발급되지 않은 participantCode면 400을 반환한다", async () => {
      const res = await request(app).post("/api/participants").send({
        anonymousId: "a1",
        group_code: "EXP",
        installDate: "2026-08-13T00:00:00Z",
        participantCode: "UNKNOWN-CODE",
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: "INVALID_FIELD_VALUE",
        detail: "participantCode",
      });
    });

    it("발급된 participantCode면, 클라이언트가 보낸 group_code가 아니라 명단의 그룹으로 저장된다", async () => {
      const res = await request(app).post("/api/participants").send({
        anonymousId: "a1",
        group_code: "EXP", // 클라이언트가 다른 그룹을 주장해도
        installDate: "2026-08-13T00:00:00Z",
        participantCode: "REAL-CODE", // 명단에는 CON으로 등록돼 있음
      });
      expect(res.status).toBe(200);

      const row = db
        .prepare("SELECT * FROM participants WHERE anonymousId = ?")
        .get("a1");
      expect(row.group_code).toBe("CON"); // 명단이 권위
    });

    it("TEST 코드는 명단 검증을 우회하고 클라이언트가 보낸 group_code를 그대로 저장한다", async () => {
      const res = await request(app).post("/api/participants").send({
        anonymousId: "a1",
        group_code: "TEST-EXP",
        installDate: "2026-08-13T00:00:00Z",
        participantCode: "TEST-EXP",
      });
      expect(res.status).toBe(200);

      const row = db
        .prepare("SELECT * FROM participants WHERE anonymousId = ?")
        .get("a1");
      expect(row.group_code).toBe("TEST-EXP");
    });

    it("소문자로 보낸 participantCode도 등록된다 — GET /validate와 동일하게 정규화(회귀)", async () => {
      const res = await request(app).post("/api/participants").send({
        anonymousId: "a1",
        group_code: "EXP",
        installDate: "2026-08-13T00:00:00Z",
        participantCode: "real-code", // 명단에는 대문자 REAL-CODE/CON으로 등록돼 있음
      });
      expect(res.status).toBe(200);

      const row = db
        .prepare("SELECT * FROM participants WHERE anonymousId = ?")
        .get("a1");
      expect(row.group_code).toBe("CON"); // 명단이 권위
      expect(row.participantCode).toBe("REAL-CODE"); // 정규화된 값으로 저장
    });
  });
});

describe("GET /api/participants/validate", () => {
  it("code 파라미터가 없으면 400을 반환한다", async () => {
    const res = await request(app).get("/api/participants/validate");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
  });

  it("발급 명단이 비어 있으면(시드 전) permissive하게 valid:true를 반환한다", async () => {
    const res = await request(app)
      .get("/api/participants/validate")
      .query({ code: "ANY-CODE" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      valid: true,
      group_code: null,
      previouslyRegistered: false,
    });
  });

  it("TEST 코드는 명단과 무관하게 항상 유효하고 previouslyRegistered는 항상 false다", async () => {
    seedIssuedCode("REAL-CODE", "CON");
    const res = await request(app)
      .get("/api/participants/validate")
      .query({ code: "test-exp" }); // 소문자로 보내도 대문자로 정규화되는지 함께 확인
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      valid: true,
      group_code: "TEST-EXP",
      previouslyRegistered: false,
    });
  });

  it("발급된 코드면 valid:true와 그 그룹을 반환한다", async () => {
    seedIssuedCode("REAL-CODE", "CON");
    const res = await request(app)
      .get("/api/participants/validate")
      .query({ code: "REAL-CODE" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      valid: true,
      group_code: "CON",
      previouslyRegistered: false,
    });
  });

  it("발급되지 않은 코드면 valid:false만 반환한다", async () => {
    seedIssuedCode("REAL-CODE", "CON");
    const res = await request(app)
      .get("/api/participants/validate")
      .query({ code: "UNKNOWN-CODE" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ valid: false });
  });

  it("이미 그 코드로 등록된 참여자가 있으면 previouslyRegistered:true를 반환한다", async () => {
    seedIssuedCode("REAL-CODE", "CON");
    db.prepare(
      "INSERT INTO participants (anonymousId, participantCode, group_code, installDate) VALUES (?, ?, ?, ?)",
    ).run("a1", "REAL-CODE", "CON", "2026-08-13T00:00:00Z");

    const res = await request(app)
      .get("/api/participants/validate")
      .query({ code: "REAL-CODE" });
    expect(res.body.data.previouslyRegistered).toBe(true);
  });
});
