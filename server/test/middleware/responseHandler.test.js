import { describe, it, expect, afterEach, vi } from "vitest";
import {
  success,
  fail,
  errorHandler,
  ERROR_CODES,
} from "../../middleware/responseHandler.js";

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
});
