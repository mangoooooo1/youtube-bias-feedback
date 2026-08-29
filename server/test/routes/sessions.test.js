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
import { validateSession } from "../../routes/sessions-validate.js";
import {
  insertSession,
  recordFeedbackTimestamp,
} from "../../routes/sessions-store.js";

// sessions.js는 모듈 최상단에서 실제 암호화 DB 싱글턴을 연다.
// 아래 buildTestRouter()는 sessions.js의 라우트를 재구현한 것이라, 이 파일만으로는
// sessions.js 자체(배선·require 순서·module.exports)를 검증하지 못한다.
// 이 파일은 validateSession/insertSession/recordFeedbackTimestamp 각 분기를 도는 데 집중한다.
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    anonymousId TEXT NOT NULL,
    sessionId TEXT NOT NULL UNIQUE,
    startTime TEXT NOT NULL,
    endTime TEXT NOT NULL,
    videoCount INTEGER,
    categoryDistribution TEXT,
    entropy REAL,
    totalMs INTEGER,
    youtubeMs INTEGER,
    geminiMs INTEGER,
    llmStatus TEXT,
    failureReason TEXT,
    httpStatus INTEGER,
    timedOut INTEGER,
    feedbackNotifiedAt TEXT,
    feedbackViewedAt TEXT,
    feedbackConfirmedAt TEXT,
    review TEXT,
    reviewTopic TEXT,
    source TEXT,
    promptVersion TEXT
  );
`);

afterAll(() => {
  db.close();
});

function buildTestRouter() {
  const router = express.Router();

  router.post("/", (req, res, next) => {
    const error = validateSession(req.body);
    if (error) {
      return fail(
        res,
        400,
        error.code,
        `${error.field} 필드가 올바르지 않습니다.`,
        error.field,
      );
    }
    try {
      insertSession(db, req.body);
    } catch (err) {
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return fail(
          res,
          409,
          ERROR_CODES.DUPLICATE_SESSION,
          "이미 존재하는 세션입니다.",
          req.body.sessionId,
        );
      }
      return next(err);
    }
    return success(res);
  });

  function makeFeedbackTimestampHandler(column) {
    return (req, res, next) => {
      const { sessionId } = req.params;
      const anonymousId = req.body?.anonymousId;
      if (typeof anonymousId !== "string" || !anonymousId.trim()) {
        return fail(
          res,
          400,
          ERROR_CODES.MISSING_REQUIRED_FIELD,
          "anonymousId 필드가 올바르지 않습니다.",
          "anonymousId",
        );
      }
      let result;
      try {
        result = recordFeedbackTimestamp(db, column, sessionId, anonymousId);
      } catch (err) {
        return next(err);
      }
      if (result === "not_found") {
        return fail(
          res,
          404,
          ERROR_CODES.NOT_FOUND,
          "세션을 찾을 수 없습니다.",
          sessionId,
        );
      }
      return success(res);
    };
  }

  router.patch(
    "/:sessionId/feedback-viewed",
    makeFeedbackTimestampHandler("feedbackViewedAt"),
  );
  router.patch(
    "/:sessionId/feedback-confirmed",
    makeFeedbackTimestampHandler("feedbackConfirmedAt"),
  );

  return router;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", buildTestRouter());
  app.use(errorHandler);
  return app;
}

const app = buildApp();

function basePayload(overrides = {}) {
  return {
    anonymousId: "exp-user",
    sessionId: "s1",
    startTime: "2026-08-13T09:00:00+09:00",
    endTime: "2026-08-13T09:10:00+09:00",
    videoCount: 3,
    categoryDistribution: { 게임: 0.6, 뉴스: 0.4 },
    entropy: 0.97,
    ...overrides,
  };
}

beforeEach(() => {
  db.exec("DELETE FROM sessions");
});

describe("POST /api/sessions", () => {
  it("정상 payload는 200과 함께 저장된다", async () => {
    const res = await request(app).post("/api/sessions").send(basePayload());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const row = db
      .prepare("SELECT * FROM sessions WHERE sessionId = ?")
      .get("s1");
    expect(row.anonymousId).toBe("exp-user");
    expect(JSON.parse(row.categoryDistribution)).toEqual({
      게임: 0.6,
      뉴스: 0.4,
    });
  });

  it("필수 필드가 없으면 400과 함께 validateSession의 에러를 그대로 응답한다", async () => {
    const payload = basePayload();
    delete payload.anonymousId;

    const res = await request(app).post("/api/sessions").send(payload);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      code: "MISSING_REQUIRED_FIELD",
    });
    expect(db.prepare("SELECT COUNT(*) AS c FROM sessions").get().c).toBe(0);
  });

  it("이미 존재하는 sessionId로 다시 저장하면 409를 반환한다", async () => {
    await request(app).post("/api/sessions").send(basePayload());
    const res = await request(app).post("/api/sessions").send(basePayload());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_SESSION");
    expect(db.prepare("SELECT COUNT(*) AS c FROM sessions").get().c).toBe(1);
  });

  it("옵션 필드를 보내지 않으면 null로 저장된다", async () => {
    await request(app).post("/api/sessions").send({
      anonymousId: "exp-user",
      sessionId: "s2",
      startTime: "2026-08-13T09:00:00+09:00",
      endTime: "2026-08-13T09:10:00+09:00",
    });

    const row = db
      .prepare("SELECT * FROM sessions WHERE sessionId = ?")
      .get("s2");
    expect(row.videoCount).toBeNull();
    expect(row.categoryDistribution).toBeNull();
    expect(row.review).toBeNull();
  });
});

describe.each([
  ["feedback-viewed", "feedbackViewedAt"],
  ["feedback-confirmed", "feedbackConfirmedAt"],
])("PATCH /api/sessions/:sessionId/%s", (path, column) => {
  beforeEach(async () => {
    await request(app).post("/api/sessions").send(basePayload());
  });

  it("anonymousId가 없으면 400을 반환한다", async () => {
    const res = await request(app).patch(`/api/sessions/s1/${path}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
  });

  it("존재하지 않는 sessionId면 404를 반환한다", async () => {
    const res = await request(app)
      .patch(`/api/sessions/no-such-session/${path}`)
      .send({ anonymousId: "exp-user" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("다른 참여자의 anonymousId로는 갱신되지 않는다(소유권 검증)", async () => {
    const res = await request(app)
      .patch(`/api/sessions/s1/${path}`)
      .send({ anonymousId: "다른-참여자" });
    expect(res.status).toBe(404);

    const row = db
      .prepare("SELECT * FROM sessions WHERE sessionId = ?")
      .get("s1");
    expect(row[column]).toBeNull();
  });

  it("정상 요청이면 해당 컬럼에 현재 시각이 기록된다", async () => {
    const res = await request(app)
      .patch(`/api/sessions/s1/${path}`)
      .send({ anonymousId: "exp-user" });
    expect(res.status).toBe(200);

    const row = db
      .prepare("SELECT * FROM sessions WHERE sessionId = ?")
      .get("s1");
    expect(row[column]).not.toBeNull();
    expect(new Date(row[column]).toString()).not.toBe("Invalid Date");
  });

  it("이미 기록된 값은 재호출해도 덮어쓰지 않는다(최초 시각만 유지)", async () => {
    await request(app)
      .patch(`/api/sessions/s1/${path}`)
      .send({ anonymousId: "exp-user" });
    const first = db
      .prepare("SELECT * FROM sessions WHERE sessionId = ?")
      .get("s1")[column];

    const res = await request(app)
      .patch(`/api/sessions/s1/${path}`)
      .send({ anonymousId: "exp-user" });
    expect(res.status).toBe(200); // 재호출도 세션은 존재하므로 성공 처리

    const second = db
      .prepare("SELECT * FROM sessions WHERE sessionId = ?")
      .get("s1")[column];
    expect(second).toBe(first);
  });
});
