import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// sessions.wiring.test.js/participants.wiring.test.js와 동일한 이유: 실제
// server/routes/popup-events.js를 그대로 로드해 OR IGNORE(eventId 멱등 키) 배선까지
// 검증한다. DB_PATH를 임시 파일로 오버라이드해 운영 DB를 열 위험 없이 실제 파일을 require한다.
const require = createRequire(import.meta.url);
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `viewlens-popup-events-wiring-${process.pid}.db`,
);
fs.rmSync(TEST_DB_PATH, { force: true });
process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
process.env.DB_PATH = TEST_DB_PATH;

const { db, initializeDB } = require("../../db.js");
initializeDB();

const { errorHandler } = require("../../middleware/responseHandler.js");
const popupEventsRouter = require("../../routes/popup-events.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/popup-events", popupEventsRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

afterAll(() => {
  db.close();
  fs.rmSync(TEST_DB_PATH, { force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM popup_events");
});

function basePayload(overrides = {}) {
  return {
    eventId: "wiring-evt-1",
    anonymousId: "wiring-user",
    dwellMs: 1200,
    tabTodayClicks: 1,
    tabWeekClicks: 0,
    feedbackViewed: 1,
    openedAt: "2026-08-13T09:00:00+09:00",
    ...overrides,
  };
}

describe("실제 server/routes/popup-events.js 라우터 배선", () => {
  it("POST /api/popup-events — 파일을 그대로 로드해도 정상 저장된다", async () => {
    const res = await request(app)
      .post("/api/popup-events")
      .send(basePayload());
    expect(res.status).toBe(200);

    const row = db
      .prepare("SELECT * FROM popup_events WHERE eventId = ?")
      .get("wiring-evt-1");
    expect(row.anonymousId).toBe("wiring-user");
  });

  it("POST /api/popup-events — anonymousId 누락 시 400 (validatePopupEvent가 실제로 연결돼 있는지)", async () => {
    const payload = basePayload();
    delete payload.anonymousId;

    const res = await request(app).post("/api/popup-events").send(payload);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM popup_events").get().c,
    ).toBe(0);
  });

  it("같은 eventId로 재전송해도 한 행만 남는다(OR IGNORE 멱등성)", async () => {
    await request(app).post("/api/popup-events").send(basePayload());
    const res = await request(app)
      .post("/api/popup-events")
      .send(basePayload({ dwellMs: 9999 }));

    expect(res.status).toBe(200);
    const rows = db
      .prepare("SELECT * FROM popup_events WHERE eventId = ?")
      .all("wiring-evt-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].dwellMs).toBe(1200); // 재전송 값(9999)이 아니라 최초 값 유지
  });

  it("eventId 없는 구버전 요청은 dedup 없이 매번 새 행으로 저장된다", async () => {
    const payload = basePayload();
    delete payload.eventId;

    await request(app).post("/api/popup-events").send(payload);
    await request(app).post("/api/popup-events").send(payload);

    const rows = db
      .prepare("SELECT * FROM popup_events WHERE anonymousId = ?")
      .all("wiring-user");
    expect(rows).toHaveLength(2);
  });

  it("등록되지 않은 경로는 404 — 예기치 않은 라우트가 실수로 노출되지 않았는지 확인", async () => {
    const res = await request(app).get(
      "/api/popup-events/no-such-route",
    );
    expect(res.status).toBe(404);
  });
});
