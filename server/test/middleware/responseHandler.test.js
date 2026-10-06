import { describe, it, expect, afterEach, vi } from "vitest";
import {
  success,
  fail,
  errorHandler,
  ERROR_CODES,
} from "../../middleware/responseHandler.js";

// 500 응답 로그는 끝에 스택이 붙으므로 그 앞부분만 비교한다
function withoutStack(line) {
  return line.split(" stack=")[0];
}

function createMockRes() {
  const res = {
    statusCode: null,
    body: null,
  };
  res.status = vi.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((payload) => {
    res.body = payload;
    return res;
  });
  return res;
}

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe("success", () => {
  it("기본값으로 200과 success:true, data:null을 응답한다", () => {
    const res = createMockRes();

    success(res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({ success: true, message: "ok", data: null });
  });

  it("전달한 data/message를 그대로 담아 응답한다", () => {
    const res = createMockRes();

    success(res, { id: 1 }, "생성됨");

    expect(res.body).toEqual({
      success: true,
      message: "생성됨",
      data: { id: 1 },
    });
  });
});

describe("fail", () => {
  it("개발 환경(NODE_ENV=development)에서는 detail을 그대로 노출한다", () => {
    process.env.NODE_ENV = "development";
    const res = createMockRes();

    fail(res, 400, ERROR_CODES.INVALID_FIELD_VALUE, "잘못된 값", {
      field: "videoCount",
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toEqual({
      success: false,
      message: "잘못된 값",
      code: ERROR_CODES.INVALID_FIELD_VALUE,
      detail: { field: "videoCount" },
    });
  });

  it("프로덕션 환경(NODE_ENV=production)에서는 detail을 숨긴다", () => {
    process.env.NODE_ENV = "production";
    const res = createMockRes();

    fail(res, 500, ERROR_CODES.INTERNAL_SERVER_ERROR, "서버 오류", {
      stack: "민감한 내부 정보",
    });

    expect(res.body.detail).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain("민감한 내부 정보");
  });

  it("인자를 생략하면 기본값(500, INTERNAL_SERVER_ERROR)으로 응답한다", () => {
    process.env.NODE_ENV = "development";
    const res = createMockRes();

    fail(res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body.code).toBe(ERROR_CODES.INTERNAL_SERVER_ERROR);
    expect(res.body.message).toBe("서버 오류가 발생했습니다.");
    expect(res.body.detail).toBeNull();
  });
});

describe("errorHandler", () => {
  it("err.status/err.code/err.message/err.detail을 그대로 fail에 전달한다", () => {
    process.env.NODE_ENV = "development";
    const res = createMockRes();
    const req = { method: "POST", path: "/api/sessions" };
    const err = {
      status: 409,
      code: "DUPLICATE_SESSION",
      message: "이미 존재하는 세션입니다.",
      detail: { sessionId: "abc" },
    };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    errorHandler(err, req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body).toEqual({
      success: false,
      message: "이미 존재하는 세션입니다.",
      code: "DUPLICATE_SESSION",
      detail: { sessionId: "abc" },
    });

    consoleSpy.mockRestore();
  });

  it("err에 status/code/detail이 없으면 기본값(500, INTERNAL_SERVER_ERROR, detail:null)으로 응답한다", () => {
    process.env.NODE_ENV = "development";
    const res = createMockRes();
    const req = { method: "GET", path: "/api/participants" };
    const err = new Error("예상치 못한 오류");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    errorHandler(err, req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body.code).toBe(ERROR_CODES.INTERNAL_SERVER_ERROR);
    expect(res.body.message).toBe("예상치 못한 오류");
    expect(res.body.detail).toBeNull();

    consoleSpy.mockRestore();
  });

  it("프로덕션 환경에서는 err.detail도 숨긴다", () => {
    process.env.NODE_ENV = "production";
    const res = createMockRes();
    const req = { method: "GET", path: "/api/participants" };
    const err = { status: 500, detail: { internalPath: "/secret" } };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    errorHandler(err, req, res, vi.fn());

    expect(res.body.detail).toBeNull();

    consoleSpy.mockRestore();
  });

  it("요청 본문에 anonymousId가 있으면 에러 로그에 함께 남긴다", () => {
    const res = createMockRes();
    const req = {
      method: "POST",
      path: "/api/sessions",
      body: { anonymousId: "abc-123" },
    };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    errorHandler(new Error("DB 오류"), req, res, vi.fn());

    expect(withoutStack(consoleSpy.mock.calls[0][0])).toBe(
      '[Error] POST /api/sessions : DB 오류 anonymousId="abc-123"',
    );

    consoleSpy.mockRestore();
  });

  it("anonymousId의 개행은 JSON 이스케이프되어 로그 한 줄을 넘지 않는다", () => {
    const res = createMockRes();
    const req = {
      method: "POST",
      path: "/api/sessions",
      body: { anonymousId: "x\n[Error] 위조된 줄" },
    };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    errorHandler(new Error("DB 오류"), req, res, vi.fn());

    expect(withoutStack(consoleSpy.mock.calls[0][0])).toBe(
      '[Error] POST /api/sessions : DB 오류 anonymousId="x\\n[Error] 위조된 줄"',
    );

    consoleSpy.mockRestore();
  });

  it("본문이 없으면(JSON 파싱 실패 등) anonymousId 없이 남긴다", () => {
    const res = createMockRes();
    const req = { method: "POST", path: "/api/sessions" };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // body-parser의 JSON 파싱 실패는 status 400이라 스택이 붙지 않는다
    const err = Object.assign(new Error("잘못된 JSON"), { status: 400 });

    errorHandler(err, req, res, vi.fn());

    expect(consoleSpy).toHaveBeenCalledWith(
      "[Error] POST /api/sessions : 잘못된 JSON",
    );

    consoleSpy.mockRestore();
  });

  it("500 응답이면 스택을 줄바꿈 없이 한 줄로 끝에 붙인다", () => {
    const res = createMockRes();
    const req = { method: "POST", path: "/api/sessions", body: {} };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("DB 오류");

    errorHandler(err, req, res, vi.fn());

    const line = consoleSpy.mock.calls[0][0];
    expect(line).not.toContain("\n");
    expect(line).toBe(
      `[Error] POST /api/sessions : DB 오류 stack=${JSON.stringify(err.stack)}`,
    );

    consoleSpy.mockRestore();
  });

  it("4xx 응답이면 스택을 남기지 않는다(예상된 입력 오류)", () => {
    const res = createMockRes();
    const req = { method: "POST", path: "/api/sessions" };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = Object.assign(new Error("참여자 없음"), { status: 404 });

    errorHandler(err, req, res, vi.fn());

    expect(consoleSpy.mock.calls[0][0]).not.toContain("stack=");

    consoleSpy.mockRestore();
  });

  it("오류 메시지 속 줄바꿈으로 가짜 [Error] 줄을 만들 수 없다(잘못된 JSON 요청 재현)", () => {
    const res = createMockRes();
    const req = { method: "POST", path: "/api/sessions" };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Node 22 JSON 파싱 오류는 요청 본문 일부를 그대로 담는다
    let parseError;
    try {
      JSON.parse("x\n[Error] POST /api/sessions : 위조");
    } catch (e) {
      parseError = Object.assign(e, { status: 400 });
    }

    errorHandler(parseError, req, res, vi.fn());

    const line = consoleSpy.mock.calls[0][0];
    expect(line).not.toMatch(/[\r\n]/);
    expect(line.startsWith("[Error] POST /api/sessions : ")).toBe(true);
    expect(line.indexOf("[Error]", 1)).toBeGreaterThan(0); // 위조 시도는 줄 중간에 문자로만 남는다

    consoleSpy.mockRestore();
  });
});
