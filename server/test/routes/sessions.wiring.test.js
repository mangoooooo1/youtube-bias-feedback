process.env.TZ = "Asia/Seoul";

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from "vitest";
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
    videoIds: ["v1", "v2"],
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

  it("POST /api/sessions — 중복 sessionId는 409이지만, 최초 요청 때 이미 저장된 categoryDistribution/entropy를 응답에 함께 돌려준다", async () => {
    const first = await request(app).post("/api/sessions").send(basePayload());
    const res = await request(app).post("/api/sessions").send(basePayload());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_SESSION");
    expect(res.body.data.categoryDistribution).toEqual(
      first.body.data.categoryDistribution,
    );
    expect(res.body.data.entropy).toBe(first.body.data.entropy);
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

// 세션 저장 직후 "오늘" 누적 리뷰를 서버가 직접 생성해 응답에 실어 보내는지(연구 무결성
// 점검 항목 1 후속 조치) — 자격 없는 그룹/시기에는 리뷰 텍스트 자체가 응답에 없어야 한다.
// TODAY_REVIEW_GEMINI_API_KEY를 설정하지 않았으므로 실제 Gemini 호출 없이 폴백만 사용된다.
// basePayload()의 endTime은 고정 과거 날짜라 "오늘" 집계 대상이 되지 않으므로, 이 describe의
// 테스트들은 endTime을 실행 시점의 실제 "지금"으로 덮어써야 한다.
//
// "오늘" 집계(aggregateTodayCumulative)는 categoryDistribution이 비어 있는 세션을 걸러낸다.
// categoryDistribution은 이제 서버가 video_metadata를 통해 계산하므로(전면 이관), 이 describe
// 안에서만 YOUTUBE_API_KEY와 global.fetch를 스텁해 v1/v2가 실제로 카테고리를 갖도록 만든다.
describe("POST /api/sessions — 오늘 누적 리뷰 생성·자격 게이팅", () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.YOUTUBE_API_KEY;

  beforeEach(() => {
    process.env.YOUTUBE_API_KEY = "wiring-test-key";
    global.fetch = vi.fn((url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/videos")) {
        const ids = parsed.searchParams.get("id").split(",");
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: ids.map((id) => ({
              id,
              snippet: { categoryId: "20", title: id },
            })),
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });
  });

  afterEach(() => {
    db.exec("DELETE FROM participants");
    global.fetch = originalFetch;
    process.env.YOUTUBE_API_KEY = originalApiKey;
  });

  it("자격 있는 EXP(베이스라인 이후)는 응답에 오늘 리뷰가 실린다", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
    ).run("exp-eligible", "EXP", "2020-01-01T00:00:00+09:00");

    const res = await request(app)
      .post("/api/sessions")
      .send(
        basePayload({
          anonymousId: "exp-eligible",
          sessionId: "exp-eligible-s1",
          endTime: new Date().toISOString(),
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.data.todayReview).not.toBeNull();
    expect(typeof res.body.data.todayReview.review).toBe("string");
    expect(res.body.data.todayReview.review.length).toBeGreaterThan(0);
  });

  it("EXP라도 베이스라인 기간 중이면 응답에 오늘 리뷰가 없다(텍스트 자체가 안 실림)", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
    ).run("exp-baseline", "EXP", new Date().toISOString());

    const res = await request(app)
      .post("/api/sessions")
      .send(
        basePayload({
          anonymousId: "exp-baseline",
          sessionId: "exp-baseline-s1",
          endTime: new Date().toISOString(),
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.data.todayReview).toBeNull();

    // 자격이 없을 뿐, 서버 DB에는 여전히 생성·저장은 되어 있어야 한다(항상 생성, 응답만 게이팅).
    const row = db
      .prepare("SELECT * FROM today_reviews WHERE anonymousId = ?")
      .get("exp-baseline");
    expect(row).not.toBeUndefined();
    expect(row.review).not.toBeNull();
  });

  it("연구종료 코드 검증 전인 CON은 응답에 오늘 리뷰가 없다", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
    ).run("con-unverified", "CON", "2020-01-01T00:00:00+09:00");

    const res = await request(app)
      .post("/api/sessions")
      .send(
        basePayload({
          anonymousId: "con-unverified",
          sessionId: "con-unverified-s1",
          endTime: new Date().toISOString(),
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.data.todayReview).toBeNull();
  });

  it("참여자 등록이 없는 anonymousId(온보딩 전 등)도 세션 저장은 성공하고 오늘 리뷰만 비어 있다", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .send(
        basePayload({
          anonymousId: "unregistered-user",
          sessionId: "unregistered-s1",
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.todayReview).toBeNull();
  });
});
