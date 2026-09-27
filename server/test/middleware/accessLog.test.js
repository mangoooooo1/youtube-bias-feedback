import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import {
  createAccessLog,
  isMonitoredPath,
} from "../../middleware/accessLog.js";

const MOUNT_PATHS = ["/api/video-events", "/api/sessions"];

// app.js는 require 시점에 DB 초기화·listen을 수행해 테스트에서 불러올 수 없으므로,
// 같은 순서(접근 로그 → express.json → 라우터 → errorHandler)로 최소 앱을 조립한다.
function buildApp() {
  const app = express();
  app.use(createAccessLog(MOUNT_PATHS));
  app.use(express.json());

  const videoEvents = express.Router();
  videoEvents.post("/", (_req, res) => res.status(404).json({}));
  videoEvents.patch("/:eventId", async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    res.status(404).json({});
  });
  videoEvents.post("/ok", (_req, res) => res.status(200).json({}));
  videoEvents.post("/boom", (_req, res) => res.status(500).json({}));
  videoEvents.post("/invalid", (_req, _res, next) => {
    const err = new Error("invalid");
    err.status = 400;
    next(err);
  });
  app.use("/api/video-events", videoEvents);

  app.use((err, _req, res, _next) => res.status(err.status || 500).json({}));
  return app;
}

describe("createAccessLog", () => {
  let warn;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  // finish 이벤트는 응답 전송 직후 발생하므로 supertest가 응답을 받은 뒤 한 틱 기다린다
  async function send(req) {
    await req;
    await new Promise((resolve) => setImmediate(resolve));
    return warn.mock.calls.map(([line]) => line);
  }

  it("하위 라우터 안에서 난 4xx도 마운트 경로를 포함한 전체 경로로 기록한다", async () => {
    const lines = await send(
      request(buildApp())
        .post("/api/video-events")
        .send({ anonymousId: "abc-123" }),
    );

    expect(lines).toEqual([
      '[access] POST /api/video-events 404 anonymousId="abc-123"',
    ]);
  });

  it("경로 파라미터가 있는 라우트도 전체 경로로 기록하고 쿼리스트링은 남기지 않는다", async () => {
    const lines = await send(
      request(buildApp()).patch("/api/video-events/evt-1?code=SECRET"),
    );

    expect(lines).toEqual(["[access] PATCH /api/video-events/evt-1 404"]);
  });

  it("라우터가 next(err)로 넘긴 4xx도 [access]로 기록한다", async () => {
    const lines = await send(
      request(buildApp()).post("/api/video-events/invalid"),
    );

    expect(lines).toEqual(["[access] POST /api/video-events/invalid 400"]);
  });

  it("잘못된 JSON으로 인한 400도 [access]로 기록한다", async () => {
    const lines = await send(
      request(buildApp())
        .post("/api/video-events")
        .set("Content-Type", "application/json")
        .send("{bad"),
    );

    expect(lines).toEqual(["[access] POST /api/video-events 400"]);
  });

  it("우리 API 아래의 없는 하위 경로는 [access]로 기록한다", async () => {
    const lines = await send(request(buildApp()).get("/api/video-events/nope"));

    expect(lines).toEqual(["[access] GET /api/video-events/nope 404"]);
  });

  it("대소문자가 다른 API 경로도 [access]로 분류하고 원래 경로 그대로 기록한다", async () => {
    const lines = await send(request(buildApp()).post("/API/VIDEO-EVENTS"));

    expect(lines).toEqual(["[access] POST /API/VIDEO-EVENTS 404"]);
  });

  it("우리 API 밖의 경로는 [access-other]로 기록한다", async () => {
    const app = buildApp();
    const lines = await send(
      Promise.all([
        request(app).get("/.env"),
        request(app).post("/"),
        request(app).get("/api/v1/users"),
      ]),
    );

    expect(lines.sort()).toEqual([
      "[access-other] GET /.env 404",
      "[access-other] GET /api/v1/users 404",
      "[access-other] POST / 404",
    ]);
  });

  it("2xx와 5xx는 기록하지 않는다", async () => {
    const app = buildApp();
    const lines = await send(
      Promise.all([
        request(app).post("/api/video-events/ok"),
        request(app).post("/api/video-events/boom"),
      ]),
    );

    expect(lines).toEqual([]);
  });

  it("anonymousId의 개행은 JSON 이스케이프되어 로그 한 줄을 넘지 않는다", async () => {
    const lines = await send(
      request(buildApp())
        .post("/api/video-events")
        .send({ anonymousId: "x\n[Error] 위조된 줄" }),
    );

    expect(lines).toEqual([
      '[access] POST /api/video-events 404 anonymousId="x\\n[Error] 위조된 줄"',
    ]);
  });
});

describe("isMonitoredPath", () => {
  it("마운트 경로 자체와 그 하위 경로는 감시 대상이다", () => {
    expect(isMonitoredPath("/api/sessions", MOUNT_PATHS)).toBe(true);
    expect(
      isMonitoredPath("/api/sessions/s-1/feedback-viewed", MOUNT_PATHS),
    ).toBe(true);
  });

  it("대소문자를 구분하지 않고 비교한다", () => {
    expect(isMonitoredPath("/API/SESSIONS", MOUNT_PATHS)).toBe(true);
    expect(isMonitoredPath("/Api/Sessions/s-1", MOUNT_PATHS)).toBe(true);
    expect(isMonitoredPath("/API/SESSIONSX", MOUNT_PATHS)).toBe(false);
  });

  it("접두사만 같은 경로는 감시 대상이 아니다", () => {
    expect(isMonitoredPath("/api/sessionsX", MOUNT_PATHS)).toBe(false);
    expect(isMonitoredPath("/api", MOUNT_PATHS)).toBe(false);
    expect(isMonitoredPath("/", MOUNT_PATHS)).toBe(false);
  });
});
