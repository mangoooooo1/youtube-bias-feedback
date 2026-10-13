import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import {
  buildAllowedOrigins,
  isAllowedOrigin,
  createCorsPolicy,
} from "../../middleware/corsPolicy.js";

// 상수를 불러오지 않고 직접 적어, 게시 확장 ID가 바뀌면 테스트가 잡아내게 한다
const VIEWLENS_ORIGIN = "chrome-extension://hdoachgdmhdlbgbacaffihocdjagjecp";

describe("isAllowedOrigin — 기본 허용 목록", () => {
  const allowed = buildAllowedOrigins({ NODE_ENV: "production" });

  it("origin이 없는 요청(curl, 헬스체크)은 허용한다", () => {
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
  });

  it("게시된 ViewLens 확장은 허용한다", () => {
    expect(isAllowedOrigin(VIEWLENS_ORIGIN, allowed)).toBe(true);
  });

  it("다른 확장 ID는 거부한다", () => {
    expect(
      isAllowedOrigin(
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        allowed,
      ),
    ).toBe(false);
  });

  it.each([
    "https://www.youtube.com",
    "https://m.youtube.com",
    "https://youtube.com",
  ])("유튜브 출처 %s는 허용한다", (origin) => {
    expect(isAllowedOrigin(origin, allowed)).toBe(true);
  });

  it("http 스킴의 유튜브는 거부한다", () => {
    expect(isAllowedOrigin("http://www.youtube.com", allowed)).toBe(false);
  });

  it.each([
    "https://evil-youtube.com",
    "https://youtube.com.evil.com",
    "https://www.youtube.com:8443",
    // 브라우저가 보내는 형식은 아니지만, 정규식 앞 앵커(^)가 빠지면 통과하는 값
    "https://evil.com/https://www.youtube.com",
  ])("유튜브를 흉내 낸 출처 %s는 거부한다", (origin) => {
    expect(isAllowedOrigin(origin, allowed)).toBe(false);
  });

  it("자체 도메인 viewlens.site는 허용한다", () => {
    expect(isAllowedOrigin("https://viewlens.site", allowed)).toBe(true);
  });
});

describe("buildAllowedOrigins — DEV_EXTENSION_ID", () => {
  const DEV_ORIGIN = "chrome-extension://abc";

  it("development에서는 개발용 확장 ID를 허용한다", () => {
    const allowed = buildAllowedOrigins({
      NODE_ENV: "development",
      DEV_EXTENSION_ID: "abc",
    });
    expect(isAllowedOrigin(DEV_ORIGIN, allowed)).toBe(true);
  });

  it("production에서는 개발용 확장 ID를 거부한다", () => {
    const allowed = buildAllowedOrigins({
      NODE_ENV: "production",
      DEV_EXTENSION_ID: "abc",
    });
    expect(isAllowedOrigin(DEV_ORIGIN, allowed)).toBe(false);
  });

  // 현재 동작 기록: production이 아니면 허용하므로 NODE_ENV 없이 실행한 로컬 서버도 허용한다
  it("NODE_ENV가 없으면 개발용 확장 ID를 허용한다", () => {
    const allowed = buildAllowedOrigins({ DEV_EXTENSION_ID: "abc" });
    expect(isAllowedOrigin(DEV_ORIGIN, allowed)).toBe(true);
  });
});

describe("createCorsPolicy — HTTP 응답 헤더", () => {
  const YOUTUBE_ORIGIN = "https://www.youtube.com";
  const DENIED_ORIGIN = "https://evil-youtube.com";

  // app.js와 같은 미들웨어를 붙이고, content.js가 호출하는 경로만 더미로 둔다
  function buildApp() {
    const app = express();
    app.use(createCorsPolicy({ NODE_ENV: "production" }));
    app.post("/api/video-events", (_req, res) => res.status(201).json({}));
    return app;
  }

  // content.js의 fetch(POST, Content-Type: application/json)가 보내는 preflight
  function preflight(origin) {
    return request(buildApp())
      .options("/api/video-events")
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "Content-Type");
  }

  it("유튜브 Origin의 preflight에 요청 Origin과 credentials 허용으로 응답한다", async () => {
    const res = await preflight(YOUTUBE_ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(YOUTUBE_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-headers"]).toBe("Content-Type");
  });

  it("유튜브 Origin의 실제 POST 응답에도 허용 헤더가 붙는다", async () => {
    const res = await request(buildApp())
      .post("/api/video-events")
      .set("Origin", YOUTUBE_ORIGIN)
      .send({});
    expect(res.status).toBe(201);
    expect(res.headers["access-control-allow-origin"]).toBe(YOUTUBE_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("거부되는 Origin의 preflight에는 허용 헤더가 없다", async () => {
    const res = await preflight(DENIED_ORIGIN);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  // 서버는 요청을 처리하지만 브라우저가 응답을 막는다 — 이 차단은 헤더가 없다는 것으로만 드러난다
  it("거부되는 Origin의 실제 POST 응답에도 허용 헤더가 없다", async () => {
    const res = await request(buildApp())
      .post("/api/video-events")
      .set("Origin", DENIED_ORIGIN)
      .send({});
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
