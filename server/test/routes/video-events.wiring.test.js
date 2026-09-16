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
  db.prepare(
    `INSERT OR IGNORE INTO participants (anonymousId, group_code, installDate)
     VALUES ('wiring-user', 'EXP', '2020-01-01T00:00:00+09:00')`,
  ).run();
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
    expect(db.prepare("SELECT COUNT(*) AS c FROM video_events").get().c).toBe(
      0,
    );
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
    const res = await request(app).get("/api/video-events/no-such-route");
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
    const res = await request(app)
      .post("/api/video-events")
      .send(
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

  // 외부 사이트의 경로는 사용자명 등 직접 식별 정보를 담을 수 있어, 클라이언트가
  // 어떤 이유로든(구버전 확장 등) 여전히 보내오더라도 서버가 저장 직전에 걸러내야 한다는 지적의 회귀 테스트.
  it("외부 유입(entryHost가 유튜브가 아님)이면 entryHost는 저장하되 entryPath는 저장하지 않는다", async () => {
    const res = await request(app)
      .post("/api/video-events")
      .send(
        basePayload({
          entryHost: "twitter.com",
          entryPath: "/janedoe123/status/12345",
        }),
      );
    expect(res.status).toBe(200);

    const row = db
      .prepare("SELECT * FROM video_events WHERE videoId = ?")
      .get("wiring-v1");
    expect(row.entryHost).toBe("twitter.com");
    expect(row.entryPath).toBeNull();
    expect(row.referrerType).toBe("external");
  });

  // 채널(/@handle) 등 유튜브 내부 경로라도 4분류 밖(unknown)이면 식별 정보를 담을 수 있어
  // entryPath를 저장하지 않아야 한다는 지적의 회귀 테스트.
  it("유튜브 내부 경로라도 unknown으로 분류되면(예: 채널 페이지) entryPath는 저장하지 않는다", async () => {
    const res = await request(app)
      .post("/api/video-events")
      .send(
        basePayload({
          entryHost: "www.youtube.com",
          entryPath: "/@someChannelHandle",
        }),
      );
    expect(res.status).toBe(200);

    const row = db
      .prepare("SELECT * FROM video_events WHERE videoId = ?")
      .get("wiring-v1");
    expect(row.entryHost).toBe("www.youtube.com");
    expect(row.entryPath).toBeNull();
    expect(row.referrerType).toBe("unknown");
  });

  it("entryHost/entryPath 미전송(구버전 확장)이면 referrerType은 unknown, relatedTrigger는 null로 저장된다", async () => {
    const res = await request(app)
      .post("/api/video-events")
      .send(basePayload());
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

  it("등록되지 않은 anonymousId는 저장을 거부한다(날조된 참여자 방지)", async () => {
    const res = await request(app)
      .post("/api/video-events")
      .send(basePayload({ anonymousId: "unregistered-user" }));

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM video_events").get().c,
    ).toBe(0);
  });
});

// 시청시간 원시 데이터 확정 (교수 피드백: 클릭성 이탈 판별용) — 영상을 떠난 뒤에야 알 수
// 있는 값이라 POST와 분리된 PATCH로 온다.
describe("PATCH /api/video-events/:eventId — 시청시간 확정", () => {
  it("정상 요청이면 watchedSeconds/playbackRate/wasBackgrounded가 저장된다", async () => {
    await request(app)
      .post("/api/video-events")
      .send(basePayload({ eventId: "watch-evt-1" }));

    const res = await request(app)
      .patch("/api/video-events/watch-evt-1")
      .send({
        anonymousId: "wiring-user",
        watchedSeconds: 42.5,
        playbackRate: 1.5,
        wasBackgrounded: 1,
      });

    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT * FROM video_events WHERE eventId = ?")
      .get("watch-evt-1");
    expect(row.watchedSeconds).toBe(42.5);
    expect(row.playbackRate).toBe(1.5);
    expect(row.wasBackgrounded).toBe(1);
  });

  it("존재하지 않는 eventId면 404를 반환한다", async () => {
    const res = await request(app)
      .patch("/api/video-events/no-such-event")
      .send({ anonymousId: "wiring-user", watchedSeconds: 10 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("다른 참여자의 eventId는 갱신되지 않는다(소유권 검증)", async () => {
    db.prepare(
      `INSERT OR IGNORE INTO participants (anonymousId, group_code, installDate)
       VALUES ('other-user', 'EXP', '2020-01-01T00:00:00+09:00')`,
    ).run();
    await request(app)
      .post("/api/video-events")
      .send(basePayload({ eventId: "watch-evt-2" }));

    const res = await request(app)
      .patch("/api/video-events/watch-evt-2")
      .send({ anonymousId: "other-user", watchedSeconds: 99 });

    expect(res.status).toBe(404);
    const row = db
      .prepare("SELECT * FROM video_events WHERE eventId = ?")
      .get("watch-evt-2");
    expect(row.watchedSeconds).toBeNull();
  });

  it("잘못된 값(음수 watchedSeconds)이면 400을 반환하고 갱신하지 않는다", async () => {
    await request(app)
      .post("/api/video-events")
      .send(basePayload({ eventId: "watch-evt-3" }));

    const res = await request(app)
      .patch("/api/video-events/watch-evt-3")
      .send({ anonymousId: "wiring-user", watchedSeconds: -5 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FIELD_VALUE");
  });

  it("일부 필드만 보내도(계측 일부 실패) 나머지는 null로 저장된다", async () => {
    await request(app)
      .post("/api/video-events")
      .send(basePayload({ eventId: "watch-evt-4" }));

    const res = await request(app)
      .patch("/api/video-events/watch-evt-4")
      .send({ anonymousId: "wiring-user", watchedSeconds: 12 });

    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT * FROM video_events WHERE eventId = ?")
      .get("watch-evt-4");
    expect(row.watchedSeconds).toBe(12);
    expect(row.playbackRate).toBeNull();
    expect(row.wasBackgrounded).toBeNull();
  });
});
