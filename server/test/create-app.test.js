import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import request from "supertest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 운영 서버(app.js)가 쓰는 createApp()을 그대로 불러, 미들웨어 순서와 라우터 마운트를 검증한다.
// 라우터 내부 동작은 *.wiring.test.js가 맡고, 여기서는 "맞는 라우터에 도착했는가"만 본다.
const require = createRequire(import.meta.url);
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `viewlens-create-app-${process.pid}.db`,
);
fs.rmSync(TEST_DB_PATH, { force: true });
process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
process.env.DB_PATH = TEST_DB_PATH;
// 토큰 검사를 건너뛰고 등록 여부만 확인하게 한다
delete process.env.PARTICIPANT_TOKEN_SECRET;

const { db, initializeDB } = require("../db.js");
initializeDB();

const ANONYMOUS_ID = "create-app-user";
// TEST 그룹은 기간과 무관하게 오늘 리뷰를 받을 수 있어, 리뷰 한 건으로 today/period 라우터를 구분할 수 있다
db.prepare(
  `INSERT INTO participants (anonymousId, group_code, installDate)
   VALUES (?, 'TEST-EXP', '2026-08-01T00:00:00.000Z')`,
).run(ANONYMOUS_ID);
db.prepare(
  `INSERT INTO today_reviews (anonymousId, reviewDate, review, generatedAt)
   VALUES (?, '2026-08-02', '조립 테스트 리뷰', '2026-08-02T00:00:00.000Z')`,
).run(ANONYMOUS_ID);

const { createApp } = require("../create-app.js");
const app = createApp();

const MOUNT_PATHS = [
  "/api/participants",
  "/api/sessions",
  "/api/video-events",
  "/api/popup-events",
  "/api/period-reviews",
  "/api/today-reviews",
  "/api/viewing-summary",
  "/api/study-end-code",
  "/api/client-errors",
];

let warn;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
});

// 접근 로그는 응답 finish 뒤에 남으므로 한 틱 기다린 뒤 기록을 읽는다
async function accessLines() {
  await new Promise((resolve) => setImmediate(resolve));
  return warn.mock.calls.map(([line]) => line);
}

describe("createApp — 라우터 마운트", () => {
  const id = { anonymousId: ANONYMOUS_ID };

  it("/api/participants는 participants 라우터에 연결된다", async () => {
    const res = await request(app).get("/api/participants/validate");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      message: "code 파라미터가 필요합니다.",
      detail: "code",
    });
  });

  it.each([
    ["/api/sessions", id, "sessionId"],
    ["/api/video-events", id, "videoId"],
    ["/api/popup-events", { ...id, openedAt: "bad" }, "openedAt"],
    ["/api/client-errors", {}, "version"],
  ])(
    "%s는 해당 라우터의 본문 검증에 도착한다",
    async (mountPath, body, detail) => {
      const res = await request(app).post(mountPath).send(body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, detail });
    },
  );

  it("/api/study-end-code는 study-end-code 라우터에 연결된다", async () => {
    const res = await request(app)
      .post("/api/study-end-code/validate")
      .send(id);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      message: "code 필드가 필요합니다.",
      detail: "code",
    });
  });

  it("/api/today-reviews와 /api/period-reviews는 각자의 라우터에 연결된다", async () => {
    const today = await request(app).post("/api/today-reviews").send(id);
    const period = await request(app).post("/api/period-reviews").send(id);

    expect(today.status).toBe(200);
    expect(today.body.data).toEqual([
      expect.objectContaining({ review: "조립 테스트 리뷰" }),
    ]);
    expect(period.status).toBe(200);
    expect(period.body.data).toEqual([]);
  });

  it("/api/viewing-summary는 viewing-summary 라우터에 연결된다", async () => {
    const res = await request(app).post("/api/viewing-summary").send(id);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        days: expect.any(Array),
        periods: expect.any(Array),
      }),
    );
  });
});

describe("createApp — 접근 로그·오류 처리 순서", () => {
  it.each(MOUNT_PATHS)(
    "%s 아래의 없는 경로는 404이고 [access]로 기록된다(감시 목록 = 마운트 목록)",
    async (mountPath) => {
      const res = await request(app).get(`${mountPath}/__no_such__`);
      expect(res.status).toBe(404);
      expect(await accessLines()).toEqual([
        `[access] GET ${mountPath}/__no_such__ 404`,
      ]);
    },
  );

  it("마운트 밖 경로는 404이고 [access-other]로 기록된다", async () => {
    const res = await request(app).get("/no-such-path");
    expect(res.status).toBe(404);
    expect(await accessLines()).toEqual([
      "[access-other] GET /no-such-path 404",
    ]);
  });

  it("잘못된 JSON은 errorHandler 형식의 400으로 응답하고 [access]로 기록된다", async () => {
    const res = await request(app)
      .post("/api/sessions")
      .set("Content-Type", "application/json")
      .send("{bad json");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(await accessLines()).toEqual(["[access] POST /api/sessions 400"]);
  });
});

describe("createApp — /health·CORS", () => {
  it("GET /health는 실제 DB로 healthy를 응답한다", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "healthy", db: "ok" });
  });

  function preflight(origin) {
    return request(app)
      .options("/api/video-events")
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "Content-Type");
  }

  it("YouTube Origin의 preflight에는 CORS 허용 헤더가 붙는다", async () => {
    const res = await preflight("https://www.youtube.com");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://www.youtube.com",
    );
  });

  it("허용되지 않은 Origin에는 CORS 허용 헤더가 붙지 않는다", async () => {
    const res = await preflight("https://evil-youtube.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
