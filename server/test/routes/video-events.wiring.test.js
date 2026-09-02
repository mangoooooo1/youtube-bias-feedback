import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// sessions.wiring.test.js와 동일한 이유: 실제 server/routes/video-events.js를 그대로
// 로드해 배선(라우트 등록, 검증 함수 연결, DB insert)까지 검증한다. DB_PATH를 임시 파일로
// 오버라이드해 운영 DB를 열 위험 없이 실제 파일을 require한다.
const require = createRequire(import.meta.url);
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `viewlens-video-events-wiring-${process.pid}.db`,
);
fs.rmSync(TEST_DB_PATH, { force: true });
process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
process.env.DB_PATH = TEST_DB_PATH;

const { db, initializeDB } = require("../../db.js");
initializeDB();

const { errorHandler } = require("../../middleware/responseHandler.js");
const videoEventsRouter = require("../../routes/video-events.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/video-events", videoEventsRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

afterAll(() => {
  db.close();
  fs.rmSync(TEST_DB_PATH, { force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM video_events");
});

function basePayload(overrides = {}) {
  return {
    anonymousId: "wiring-user",
    videoId: "wiring-v1",
    watchedAt: "2026-08-13T09:00:00+09:00",
    title: "테스트 영상",
    sessionId: "wiring-s1",
    ...overrides,
  };
}

describe("실제 server/routes/video-events.js 라우터 배선", () => {
  it("POST /api/video-events — 파일을 그대로 로드해도 정상 저장된다", async () => {
    const res = await request(app)
      .post("/api/video-events")
      .send(basePayload());
    expect(res.status).toBe(200);

    const row = db
      .prepare("SELECT * FROM video_events WHERE videoId = ?")
      .get("wiring-v1");
    expect(row.anonymousId).toBe("wiring-user");
    expect(row.sessionId).toBe("wiring-s1");
  });

  it("POST /api/video-events — videoId 누락 시 400 (validateVideoEvent가 실제로 연결돼 있는지)", async () => {
    const payload = basePayload();
    delete payload.videoId;

    const res = await request(app).post("/api/video-events").send(payload);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM video_events").get().c,
    ).toBe(0);
  });

  it("POST /api/video-events — sessionId 미전송(구버전 확장)이면 null로 저장된다", async () => {
    const payload = basePayload();
    delete payload.sessionId;

    const res = await request(app).post("/api/video-events").send(payload);
    expect(res.status).toBe(200);

    const row = db
      .prepare("SELECT * FROM video_events WHERE videoId = ?")
      .get("wiring-v1");
    expect(row.sessionId).toBeNull();
  });

  it("POST /api/video-events — sessionId가 빈 문자열이면 400", async () => {
    const res = await request(app)
      .post("/api/video-events")
      .send(basePayload({ sessionId: "" }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FIELD_VALUE");
  });

  it("등록되지 않은 경로는 404 — 예기치 않은 라우트가 실수로 노출되지 않았는지 확인", async () => {
    const res = await request(app).get(
      "/api/video-events/no-such-route",
    );
    expect(res.status).toBe(404);
  });

  it("같은 eventId로 재전송해도 한 행만 남는다(OR IGNORE 멱등성) — 확장의 재시도 큐가 이미 성공한 전송을 다시 보내는 상황", async () => {
    await request(app)
      .post("/api/video-events")
      .send(basePayload({ eventId: "wiring-evt-1" }));
    const res = await request(app)
      .post("/api/video-events")
      .send(basePayload({ eventId: "wiring-evt-1", title: "다른 제목" }));

    expect(res.status).toBe(200);
    const rows = db
      .prepare("SELECT * FROM video_events WHERE eventId = ?")
      .all("wiring-evt-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("테스트 영상"); // 재전송 값이 아니라 최초 값 유지
  });

  it("entryHost/entryPath/navigationTrigger가 오면 referrerType/relatedTrigger로 분류돼 저장된다", async () => {
    const res = await request(app).post("/api/video-events").send(
      basePayload({
        entryHost: "www.youtube.com",
        entryPath: "/watch",
        navigationTrigger: "interaction",
      }),
    );
    expect(res.status).toBe(200);

    const row = db
      .prepare("SELECT * FROM video_events WHERE videoId = ?")
      .get("wiring-v1");
    expect(row.entryHost).toBe("www.youtube.com");
    expect(row.entryPath).toBe("/watch");
    expect(row.referrerType).toBe("related");
    expect(row.relatedTrigger).toBe("click");
  });

  it("entryHost/entryPath 미전송(구버전 확장)이면 referrerType은 unknown, relatedTrigger는 null로 저장된다", async () => {
    const res = await request(app).post("/api/video-events").send(basePayload());
    expect(res.status).toBe(200);

    const row = db
      .prepare("SELECT * FROM video_events WHERE videoId = ?")
      .get("wiring-v1");
    expect(row.entryHost).toBeNull();
    expect(row.entryPath).toBeNull();
    expect(row.referrerType).toBe("unknown");
    expect(row.relatedTrigger).toBeNull();
  });

  it("eventId 없는 구버전 요청은 dedup 없이 매번 새 행으로 저장된다", async () => {
    const payload = basePayload();
    delete payload.eventId;

    await request(app).post("/api/video-events").send(payload);
    await request(app).post("/api/video-events").send(payload);

    const rows = db
      .prepare("SELECT * FROM video_events WHERE anonymousId = ?")
      .all("wiring-user");
    expect(rows).toHaveLength(2);
  });
});
