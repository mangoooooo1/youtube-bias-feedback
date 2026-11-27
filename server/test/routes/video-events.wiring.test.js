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

  it.each([
    ["+09:00", "2026-08-13T09:00:00+09:00", "2026-08-13T00:00:00.000Z"],
    ["toISOString", "2026-08-13T00:00:00.123Z", "2026-08-13T00:00:00.123Z"],
  ])(
    "POST /api/video-events — watchedAt %s 입력은 UTC ISO로 저장된다",
    async (_label, watchedAt, expected) => {
      const res = await request(app)
        .post("/api/video-events")
        .send(basePayload({ watchedAt }));
      expect(res.status).toBe(200);
      expect(
        db
          .prepare("SELECT watchedAt FROM video_events WHERE videoId = ?")
          .get("wiring-v1").watchedAt,
      ).toBe(expected);
    },
  );

  it("POST /api/video-events — 시간대 없는 watchedAt은 400이고 저장하지 않는다", async () => {
    const res = await request(app)
      .post("/api/video-events")
      .send(basePayload({ watchedAt: "2026-08-13T09:00:00" }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FIELD_VALUE");
    expect(db.prepare("SELECT COUNT(*) AS c FROM video_events").get().c).toBe(
      0,
    );
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

  it("POST /api/video-events — title 미전송이면 null로 저장된다", async () => {
    const payload = basePayload();
    delete payload.title;

    const res = await request(app).post("/api/video-events").send(payload);
    expect(res.status).toBe(200);
    expect(
      db
        .prepare("SELECT title FROM video_events WHERE videoId = ?")
        .get("wiring-v1").title,
    ).toBeNull();
  });

  it.each([
    ["1", 1, 1],
    ["0", 0, 0],
    ["미전송(구버전 확장)", undefined, null],
  ])(
    "POST /api/video-events — isShortsUrl이 %s이면 %s로 저장된다",
    async (_label, isShortsUrl, expected) => {
      const res = await request(app)
        .post("/api/video-events")
        .send(basePayload({ isShortsUrl }));
      expect(res.status).toBe(200);
      expect(
        db
          .prepare("SELECT isShortsUrl FROM video_events WHERE videoId = ?")
          .get("wiring-v1").isShortsUrl,
      ).toBe(expected);
    },
  );

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

  const savedRow = () =>
    db.prepare("SELECT * FROM video_events WHERE videoId = ?").get("wiring-v1");

  it("확장이 실제로 보내는 외부 유입(경로 없음)이면 external로 저장하고 경로는 비워 둔다", async () => {
    const res = await request(app)
      .post("/api/video-events")
      .send(basePayload({ entryHost: "www.google.com", entryPath: null }));
    expect(res.status).toBe(200);

    const row = savedRow();
    expect(row.entryHost).toBe("www.google.com");
    expect(row.entryPath).toBeNull();
    expect(row.referrerType).toBe("external");
  });

  it("재생목록 페이지에서 영상을 누르면 playlist/click으로 저장하고 경로 /playlist와 재생목록 값을 남긴다", async () => {
    const res = await request(app)
      .post("/api/video-events")
      .send(
        basePayload({
          entryHost: "www.youtube.com",
          entryPath: "/playlist",
          navigationTrigger: "interaction",
          entryHasList: 1,
          watchHasList: 1,
        }),
      );
    expect(res.status).toBe(200);

    const row = savedRow();
    expect(row.referrerType).toBe("playlist");
    expect(row.relatedTrigger).toBe("click");
    expect(row.entryPath).toBe("/playlist");
    expect(row.entryHasList).toBe(1);
    expect(row.watchHasList).toBe(1);
  });

  it("재생목록 안에서 자동으로 넘어간 영상은 playlist/autoplay로 저장한다", async () => {
    await request(app)
      .post("/api/video-events")
      .send(
        basePayload({
          entryHost: "www.youtube.com",
          entryPath: "/watch",
          navigationTrigger: "ended",
          entryHasList: 1,
          watchHasList: 1,
        }),
      );

    const row = savedRow();
    expect(row.referrerType).toBe("playlist");
    expect(row.relatedTrigger).toBe("autoplay");
    expect(row.entryPath).toBe("/watch");
  });

  it("재생목록 값이 0·1이 아니면 기록은 저장하고 그 값만 비워 둔다", async () => {
    const res = await request(app)
      .post("/api/video-events")
      .send(
        basePayload({
          entryHost: "www.youtube.com",
          entryPath: "/watch",
          entryHasList: 2,
          watchHasList: "1",
        }),
      );
    expect(res.status).toBe(200);

    const row = savedRow();
    expect(row.entryHasList).toBeNull();
    expect(row.watchHasList).toBeNull();
    expect(row.referrerType).toBe("related");
  });

  it("재생목록 값을 보내지 않는 옛 확장은 그 칸을 비워 두고 지금처럼 분류한다", async () => {
    await request(app)
      .post("/api/video-events")
      .send(
        basePayload({
          entryHost: "www.youtube.com",
          entryPath: "/watch",
          navigationTrigger: "ended",
        }),
      );

    const row = savedRow();
    expect(row.entryHasList).toBeNull();
    expect(row.watchHasList).toBeNull();
    expect(row.referrerType).toBe("related");
    expect(row.relatedTrigger).toBe("autoplay");
  });

  it.each(["/watch?list=PL_PRIVATE", "/@someChannelHandle"])(
    "재생목록 값이 1이어도 %s 같은 경로는 저장하지 않는다",
    async (entryPath) => {
      await request(app)
        .post("/api/video-events")
        .send(
          basePayload({
            entryHost: "www.youtube.com",
            entryPath,
            entryHasList: 1,
            watchHasList: 1,
          }),
        );

      const row = savedRow();
      expect(row.referrerType).toBe("unknown");
      expect(row.entryPath).toBeNull();
    },
  );

  // 확장은 쿼리·해시가 없는 pathname만 보낸다. 섞여 오면 분류와 관계없이 경로를 버린다
  it.each(["/shorts/abc123?list=PL_PRIVATE", "/shorts/abc123#t=10"])(
    "%s처럼 쿼리나 해시가 붙은 경로는 분류와 관계없이 저장하지 않는다",
    async (entryPath) => {
      await request(app)
        .post("/api/video-events")
        .send(
          basePayload({
            entryHost: "www.youtube.com",
            entryPath,
            navigationTrigger: "ended",
          }),
        );

      const row = savedRow();
      expect(row.referrerType).toBe("related");
      expect(row.entryPath).toBeNull();
    },
  );

  it("다시 재생해 새로 만든 기록은 앞 기록의 eventId를 저장하고, 유입 경로는 unknown으로 둔다", async () => {
    const res = await request(app)
      .post("/api/video-events")
      .send(
        basePayload({ eventId: "evt-next", resumedFromEventId: "evt-prev" }),
      );
    expect(res.status).toBe(200);

    const row = db
      .prepare("SELECT * FROM video_events WHERE eventId = ?")
      .get("evt-next");
    expect(row.resumedFromEventId).toBe("evt-prev");
    expect(row.referrerType).toBe("unknown");
  });

  it("resumedFromEventId 미전송(이동으로 생긴 기록·구버전 확장)이면 null로 저장된다", async () => {
    await request(app).post("/api/video-events").send(basePayload());

    const row = db
      .prepare("SELECT * FROM video_events WHERE videoId = ?")
      .get("wiring-v1");
    expect(row.resumedFromEventId).toBeNull();
  });

  it("resumedFromEventId가 빈 문자열이면 400이고 저장하지 않는다", async () => {
    const res = await request(app)
      .post("/api/video-events")
      .send(basePayload({ resumedFromEventId: "" }));

    expect(res.status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS c FROM video_events").get().c).toBe(
      0,
    );
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
    expect(db.prepare("SELECT COUNT(*) AS c FROM video_events").get().c).toBe(
      0,
    );
  });
});

// 시청시간 원시 데이터 확정 (클릭성 이탈 판별용) — 영상을 떠난 뒤에야 알 수
// 있는 값이라 POST와 분리된 PATCH로 온다.
describe("POST /api/video-events — 확장 버전 기록", () => {
  function storedVersion(eventId) {
    return db
      .prepare("SELECT extensionVersion FROM video_events WHERE eventId = ?")
      .get(eventId).extensionVersion;
  }

  it("X-Extension-Version 헤더의 버전을 저장한다", async () => {
    const res = await request(app)
      .post("/api/video-events")
      .set("X-Extension-Version", "3.4.0")
      .send(basePayload({ eventId: "ver-1" }));
    expect(res.status).toBe(200);
    expect(storedVersion("ver-1")).toBe("3.4.0");
  });

  it("헤더가 없는 옛 확장의 기록도 저장하고 버전은 null로 둔다", async () => {
    const res = await request(app)
      .post("/api/video-events")
      .send(basePayload({ eventId: "ver-2" }));
    expect(res.status).toBe(200);
    expect(storedVersion("ver-2")).toBeNull();
  });

  it.each([["3.4.0-beta"], ["v3.4"], ["1.2.3.4.5"], ["<script>"], [""]])(
    "형식이 틀린 버전(%s)이면 기록은 저장하고 버전은 null로 둔다",
    async (version) => {
      const res = await request(app)
        .post("/api/video-events")
        .set("X-Extension-Version", version)
        .send(basePayload({ eventId: "ver-3" }));
      expect(res.status).toBe(200);
      expect(storedVersion("ver-3")).toBeNull();
    },
  );

  it("본문의 extensionVersion은 무시하고 헤더만 믿는다", async () => {
    await request(app)
      .post("/api/video-events")
      .send(basePayload({ eventId: "ver-4", extensionVersion: "9.9.9" }));
    expect(storedVersion("ver-4")).toBeNull();
  });

  it("업데이트된 확장이 같은 기록을 다시 보내도 처음 도착한 버전을 유지한다", async () => {
    await request(app)
      .post("/api/video-events")
      .set("X-Extension-Version", "3.3.1")
      .send(basePayload({ eventId: "ver-5" }));
    await request(app)
      .post("/api/video-events")
      .set("X-Extension-Version", "3.4.0")
      .send(basePayload({ eventId: "ver-5" }));
    expect(storedVersion("ver-5")).toBe("3.3.1");
  });
});

describe("PATCH /api/video-events/:eventId — 시청시간 확정", () => {
  it("정상 요청이면 watchedSeconds/playbackRate/wasBackgrounded가 저장된다", async () => {
    await request(app)
      .post("/api/video-events")
      .send(basePayload({ eventId: "watch-evt-1" }));

    const res = await request(app).patch("/api/video-events/watch-evt-1").send({
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

  it("watchedSeconds 없이 다른 필드만 보내도 watchedSeconds는 null로 저장된다", async () => {
    await request(app)
      .post("/api/video-events")
      .send(basePayload({ eventId: "watch-evt-5" }));

    const res = await request(app).patch("/api/video-events/watch-evt-5").send({
      anonymousId: "wiring-user",
      playbackRate: 2,
      wasBackgrounded: 0,
    });

    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT * FROM video_events WHERE eventId = ?")
      .get("watch-evt-5");
    expect(row.watchedSeconds).toBeNull();
    expect(row.playbackRate).toBe(2);
    expect(row.wasBackgrounded).toBe(0);
  });
});

describe("PATCH /api/video-events/:eventId — 재생 구간 합(playedSeconds)", () => {
  function storedRow(eventId) {
    return db
      .prepare(
        "SELECT watchedSeconds, playedSeconds FROM video_events WHERE eventId = ?",
      )
      .get(eventId);
  }

  it("보낸 재생 구간 합을 시청 시간과 함께 저장한다", async () => {
    await request(app)
      .post("/api/video-events")
      .send(basePayload({ eventId: "played-1" }));

    const res = await request(app).patch("/api/video-events/played-1").send({
      anonymousId: "wiring-user",
      watchedSeconds: 30,
      playedSeconds: 60,
    });

    expect(res.status).toBe(200);
    expect(storedRow("played-1")).toEqual({
      watchedSeconds: 30,
      playedSeconds: 60,
    });
  });

  it("보내지 않는 옛 확장이면 null로 둔다", async () => {
    await request(app)
      .post("/api/video-events")
      .send(basePayload({ eventId: "played-2" }));

    await request(app)
      .patch("/api/video-events/played-2")
      .send({ anonymousId: "wiring-user", watchedSeconds: 30 });

    expect(storedRow("played-2")).toEqual({
      watchedSeconds: 30,
      playedSeconds: null,
    });
  });

  it("값이 잘못돼도 요청은 받아 시청 시간은 저장하고 재생 구간 합만 null로 둔다", async () => {
    await request(app)
      .post("/api/video-events")
      .send(basePayload({ eventId: "played-3" }));

    const res = await request(app).patch("/api/video-events/played-3").send({
      anonymousId: "wiring-user",
      watchedSeconds: 30,
      playedSeconds: -5,
    });

    expect(res.status).toBe(200);
    expect(storedRow("played-3")).toEqual({
      watchedSeconds: 30,
      playedSeconds: null,
    });
  });
});
