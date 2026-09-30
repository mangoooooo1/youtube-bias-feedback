import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createRequire } from "node:module";

// 이 라우터는 DB를 쓰지 않아 임시 DB 없이 실제 파일을 그대로 로드한다
const require = createRequire(import.meta.url);
const { errorHandler } = require("../../middleware/responseHandler.js");
const clientErrorsRouter = require("../../routes/client-errors.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/client-errors", clientErrorsRouter);
  app.use(errorHandler);
  return app;
}

function basePayload(overrides = {}) {
  return {
    anonymousId: "wiring-user",
    version: "2.4.1",
    errors: [
      {
        code: "RECORD_FAILED",
        where: "content.recordVideo",
        count: 2,
        firstAt: "2026-09-30T10:00:00+09:00",
        lastAt: "2026-09-30T10:05:00+09:00",
      },
    ],
    ...overrides,
  };
}

let errorSpy;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

function loggedLines() {
  return errorSpy.mock.calls.map((args) => args.join(" "));
}

describe("실제 server/routes/client-errors.js 라우터 배선", () => {
  it("오류 1건당 [client-error] 한 줄을 허용 목록 필드로만 남긴다", async () => {
    const res = await request(buildApp())
      .post("/api/client-errors")
      .send(basePayload());

    expect(res.status).toBe(200);
    expect(loggedLines()).toEqual([
      '[client-error] code=RECORD_FAILED where=content.recordVideo count=2 version=2.4.1 firstAt=2026-09-30T01:00:00.000Z lastAt=2026-09-30T01:05:00.000Z anonymousId="wiring-user"',
    ]);
  });

  it("여러 건이면 건마다 한 줄씩 남긴다", async () => {
    const payload = basePayload();
    payload.errors.push({
      ...payload.errors[0],
      code: "POPUP_BOOT_FAILED",
      where: "popup.boot",
    });

    await request(buildApp()).post("/api/client-errors").send(payload);

    expect(loggedLines()).toHaveLength(2);
    expect(loggedLines()[1]).toContain(
      "code=POPUP_BOOT_FAILED where=popup.boot",
    );
  });

  it("anonymousId 없이도 받는다(등록 전 오류)", async () => {
    const payload = basePayload();
    delete payload.anonymousId;

    const res = await request(buildApp())
      .post("/api/client-errors")
      .send(payload);

    expect(res.status).toBe(200);
    expect(loggedLines()[0]).not.toContain("anonymousId");
  });

  it("허용 목록 밖 필드(제목·URL·원본 메시지)는 로그에 남지 않는다", async () => {
    const payload = basePayload({
      title: "민감한 영상 제목",
      url: "https://www.youtube.com/watch?v=abc123",
      message: "TypeError at https://www.youtube.com/results?search_query=x",
    });
    payload.errors[0].stack = "민감한 영상 제목 stack";

    await request(buildApp()).post("/api/client-errors").send(payload);

    const logged = loggedLines().join("\n");
    expect(logged).not.toContain("민감한");
    expect(logged).not.toContain("youtube.com");
    expect(logged).not.toContain("TypeError");
  });

  it("검증 실패 시 400이고 아무것도 로그에 남기지 않는다", async () => {
    const payload = basePayload();
    payload.errors[0].code = "UNKNOWN";

    const res = await request(buildApp())
      .post("/api/client-errors")
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FIELD_VALUE");
    expect(loggedLines()).toEqual([]);
  });

  it("같은 IP가 15분에 30회를 넘기면 429", async () => {
    const app = buildApp();
    for (let i = 0; i < 30; i += 1) {
      await request(app)
        .post("/api/client-errors")
        .set("X-Real-IP", "203.0.113.7")
        .send(basePayload());
    }
    const res = await request(app)
      .post("/api/client-errors")
      .set("X-Real-IP", "203.0.113.7")
      .send(basePayload());

    expect(res.status).toBe(429);
  });
});
