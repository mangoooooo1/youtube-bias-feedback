import { describe, it, expect, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import request from "supertest";
import express from "express";

// 운영과 같이 CJS require로 불러와, useTracer로 지정한 tracer를 미들웨어들이 공유하는지 본다
const require = createRequire(import.meta.url);
const { traceRef, useTracer } = require("../tracing.js");
const { errorHandler } = require("../middleware/responseHandler.js");
const { createAccessLog } = require("../middleware/accessLog.js");
const { formatClientErrorLine } = require("../routes/client-errors.js");

const TRACE =
  " dd.trace_id=69a1b2c3d4e5f60718293a4b5c6d7e8f dd.span_id=1234567890";

function fakeTracer({ span = {}, inject } = {}) {
  return {
    scope: () => ({ active: () => span }),
    inject:
      inject ??
      ((_ctx, format, carrier) => {
        expect(format).toBe("log");
        carrier.dd = {
          trace_id: "69a1b2c3d4e5f60718293a4b5c6d7e8f",
          span_id: "1234567890",
        };
      }),
  };
}

const spanWithContext = { context: () => ({}) };

afterEach(() => {
  useTracer(null);
  vi.restoreAllMocks();
});

describe("traceRef", () => {
  it("활성 span이 있으면 dd-trace log 주입 값으로 trace·span ID를 만든다", () => {
    expect(traceRef(fakeTracer({ span: spanWithContext }))).toBe(TRACE);
  });

  it("tracer가 없거나(초기화 전) 활성 span이 없으면 빈 문자열이다", () => {
    expect(traceRef(null)).toBe("");
    expect(traceRef(fakeTracer({ span: null }))).toBe("");
  });

  it("주입이 실패해도 던지지 않고 빈 문자열이다", () => {
    const tracer = fakeTracer({
      span: spanWithContext,
      inject: () => {
        throw new Error("boom");
      },
    });
    expect(traceRef(tracer)).toBe("");
  });

  it("인자가 없으면 useTracer로 지정한 tracer를 쓴다", () => {
    expect(traceRef()).toBe("");
    useTracer(fakeTracer({ span: spanWithContext }));
    expect(traceRef()).toBe(TRACE);
  });
});

describe("로그 줄의 trace ID 위치", () => {
  it("[Error]는 anonymousId 뒤, 스택 앞에 붙는다", () => {
    useTracer(fakeTracer({ span: spanWithContext }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = { status: () => res, json: () => res };

    errorHandler(
      new Error("DB 오류"),
      { method: "POST", path: "/api/sessions", body: { anonymousId: "abc" } },
      res,
      () => {},
    );

    expect(
      error.mock.calls[0][0].startsWith(
        `[Error] POST /api/sessions : DB 오류 anonymousId="abc"${TRACE} stack=`,
      ),
    ).toBe(true);
  });

  it("[access]는 요청 진입 때 잡은 trace ID를 응답 완료 로그 끝에 붙인다", async () => {
    useTracer(fakeTracer({ span: spanWithContext }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = express();
    app.use(createAccessLog(["/api/video-events"]));
    app.post("/api/video-events", (_req, res) => {
      // 응답 시점에는 활성 span이 없어도 진입 때 값이 남아야 한다
      useTracer(null);
      res.status(404).json({});
    });

    await request(app).post("/api/video-events");
    await new Promise((resolve) => setImmediate(resolve));

    expect(warn.mock.calls[0][0]).toBe(
      `[access] POST /api/video-events 404${TRACE}`,
    );
  });

  it("[client-error]는 줄 끝에 붙는다", () => {
    const line = formatClientErrorLine(
      {
        code: "QUEUE_CRASHED",
        where: "background.queue",
        count: 1,
        firstAt: "2026-10-01T00:00:00Z",
        lastAt: "2026-10-01T00:00:00Z",
      },
      { version: "2.4.1" },
      TRACE,
    );
    expect(line.endsWith(`lastAt=2026-10-01T00:00:00.000Z${TRACE}`)).toBe(true);
  });

  it("tracer가 없으면 기존 형식 그대로다", () => {
    const line = formatClientErrorLine(
      {
        code: "QUEUE_CRASHED",
        where: "background.queue",
        count: 1,
        firstAt: "2026-10-01T00:00:00Z",
        lastAt: "2026-10-01T00:00:00Z",
      },
      { version: "2.4.1" },
    );
    expect(line).not.toContain("dd.");
  });
});
