import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import crypto from "crypto";
import request from "supertest";
import express from "express";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// server/test/routes/participants.test.js는 실제 server/routes/participants.js를 import하지
// 않고, 그 안의 일부 라우트(POST /, GET /validate)만 흉내 낸 테스트 전용 라우터로 검증한다.
// participants.js 자체의 배선은 물론, /recover·/study-end-review-event 라우트는 그 테스트로
// 아예 실행되지 않는다. 여기서는 실제 파일을 그대로 로드해 전체 라우트 배선을 검증한다.
const require = createRequire(import.meta.url);
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `viewlens-participants-wiring-${process.pid}.db`,
);
fs.rmSync(TEST_DB_PATH, { force: true });
process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
process.env.DB_PATH = TEST_DB_PATH;

const { db, initializeDB } = require("../../db.js");
initializeDB();

const { errorHandler } = require("../../middleware/responseHandler.js");
const participantsRouter = require("../../routes/participants.js");
// 정규화 회귀 테스트용 — period-reviews는 자격 미달이어도 403/404 없이 빈 배열만 돌려주므로,
// requireParticipant 체인이 실제로 통과했는지를 그룹별 부가 조건과 섞이지 않고 확인할 수 있다.
const periodReviewsRouter = require("../../routes/period-reviews.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/participants", participantsRouter);
  app.use("/api/period-reviews", periodReviewsRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

afterAll(() => {
  db.close();
  fs.rmSync(TEST_DB_PATH, { force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM participants");
  db.exec("DELETE FROM issued_codes");
});

describe("실제 server/routes/participants.js 라우터 배선", () => {
  it("POST /api/participants — 파일을 그대로 로드해도 정상 등록된다", async () => {
    db.prepare("INSERT INTO issued_codes (code, group_code) VALUES (?, ?)").run(
      "WIRE-CODE",
      "EXP",
    );
    const res = await request(app).post("/api/participants").send({
      anonymousId: "wiring-a1",
      group_code: "EXP",
      installDate: "2026-08-13T00:00:00Z",
      participantCode: "WIRE-CODE",
    });
    expect(res.status).toBe(200);

    const row = db
      .prepare("SELECT * FROM participants WHERE anonymousId = ?")
      .get("wiring-a1");
    expect(row.group_code).toBe("EXP");
  });

  it("소문자 participantCode — GET /validate가 통과시키면 POST /도 동일 코드로 등록에 성공한다(회귀)", async () => {
    db.prepare("INSERT INTO issued_codes (code, group_code) VALUES (?, ?)").run(
      "REAL-CODE",
      "CON",
    );

    const validateRes = await request(app)
      .get("/api/participants/validate")
      .query({ code: "real-code" });
    expect(validateRes.body.data.valid).toBe(true);

    const registerRes = await request(app).post("/api/participants").send({
      anonymousId: "wiring-a2",
      group_code: "EXP",
      installDate: "2026-08-13T00:00:00Z",
      participantCode: "real-code",
    });
    expect(registerRes.status).toBe(200);
  });

  it("GET /api/participants/validate — 실제 파일에 라우트가 등록돼 응답한다", async () => {
    const res = await request(app)
      .get("/api/participants/validate")
      .query({ code: "ANY-CODE" });
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(false);
  });

  it("GET /api/participants/validate — code 파라미터 없으면 400", async () => {
    const res = await request(app).get("/api/participants/validate");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
  });

  it("POST /api/participants/recover — 옛 duplicate 라우터엔 아예 없던 라우트, 실제 파일엔 등록돼 있다", async () => {
    const res = await request(app)
      .post("/api/participants/recover")
      .send({ participantCode: "UNKNOWN-CODE" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("POST /api/participants/recover — TEST 코드는 복구 불가(400)", async () => {
    const res = await request(app)
      .post("/api/participants/recover")
      .send({ participantCode: "TEST-EXP" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FIELD_VALUE");
  });

  it("POST /api/participants/study-end-review-event — 옛 duplicate 라우터엔 아예 없던 라우트, 실제 파일엔 등록돼 있다", async () => {
    const res = await request(app)
      .post("/api/participants/study-end-review-event")
      .send({ anonymousId: "no-such-participant", event: "modal_shown" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("POST /api/participants/study-end-review-event — event 값이 잘못되면 400", async () => {
    // requireParticipant가 먼저 통과해야 event 검증까지 도달하므로, 등록된 참여자여야 한다.
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
    ).run("wiring-a1", "EXP", "2026-08-13T00:00:00Z");

    const res = await request(app)
      .post("/api/participants/study-end-review-event")
      .send({ anonymousId: "wiring-a1", event: "not-a-real-event" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FIELD_VALUE");
  });

  it('보호된 라우트에 anonymousId로 {"toString":null}을 보내면 500이 아니라 400', async () => {
    const res = await request(app)
      .post("/api/period-reviews")
      .send({ anonymousId: { toString: null } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
  });

  it('등록에 participantCode로 {"toString":null}을 보내면 500이 아니라 400', async () => {
    const res = await request(app)
      .post("/api/participants")
      .send({
        anonymousId: "object-code-user",
        group_code: "EXP",
        installDate: "2026-08-13T00:00:00Z",
        participantCode: { toString: null },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
    expect(res.body.detail).toBe("participantCode");
  });

  it('복구에 participantCode로 {"toString":null}을 보내면 500이 아니라 400', async () => {
    const res = await request(app)
      .post("/api/participants/recover")
      .send({ participantCode: { toString: null } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FIELD_VALUE");
  });

  // 배열은 발급된 코드를 담아 보낸다 — 예전 toString() 정규화로는 ["CODE"]가 "CODE"가 돼 통과했다
  it.each([
    { label: "숫자", value: 123 },
    { label: "boolean", value: true },
    { label: "발급된 코드를 담은 배열", value: ["WIRE-CODE"] },
  ])(
    "등록에 participantCode로 $label을 보내면 400이고 등록되지 않는다",
    async ({ value }) => {
      db.prepare(
        "INSERT INTO issued_codes (code, group_code) VALUES (?, ?)",
      ).run("WIRE-CODE", "EXP");
      const res = await request(app).post("/api/participants").send({
        anonymousId: "non-string-code-user",
        group_code: "EXP",
        installDate: "2026-08-13T00:00:00Z",
        participantCode: value,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
      expect(res.body.detail).toBe("participantCode");
      expect(
        db
          .prepare("SELECT 1 FROM participants WHERE anonymousId = ?")
          .get("non-string-code-user"),
      ).toBeUndefined();
    },
  );

  // /recover는 IP당 15분 5회 제한이라, 이 파일의 다른 복구 요청과 한도를 나누지 않게 케이스마다 X-Real-IP를 다르게 준다
  it.each([
    { label: "숫자", value: 123, ip: "10.0.0.1" },
    { label: "boolean", value: true, ip: "10.0.0.2" },
    { label: "등록된 코드를 담은 배열", value: ["RECOVER-ME"], ip: "10.0.0.3" },
  ])(
    "복구에 participantCode로 $label을 보내면 400이고 anonymousId가 나가지 않는다",
    async ({ value, ip }) => {
      db.prepare(
        "INSERT INTO participants (anonymousId, participantCode, group_code, installDate) VALUES (?, ?, ?, ?)",
      ).run("recover-target", "RECOVER-ME", "EXP", "2026-08-13T00:00:00Z");
      const res = await request(app)
        .post("/api/participants/recover")
        .set("X-Real-IP", ip)
        .send({ participantCode: value });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_FIELD_VALUE");
      expect(JSON.stringify(res.body)).not.toContain("recover-target");
    },
  );

  it("GET /validate에 code를 여러 번 보내면(배열) 400", async () => {
    const res = await request(app)
      .get("/api/participants/validate")
      .query("code=A&code=B");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
  });

  it("등록되지 않은 경로는 404 — 예기치 않은 라우트가 실수로 노출되지 않았는지 확인", async () => {
    const res = await request(app).get("/api/participants/no-such-route");
    expect(res.status).toBe(404);
  });
});

// anonymousId 소유권 증명용 토큰 발급 — period-reviews/today-reviews 등 조회 라우트가
// requireParticipant로 강제하는 토큰의 발급 지점(IDOR 대응, 코드리뷰 지적).
describe("실제 server/routes/participants.js — participantToken 발급", () => {
  const originalSecret = process.env.PARTICIPANT_TOKEN_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.PARTICIPANT_TOKEN_SECRET;
    } else {
      process.env.PARTICIPANT_TOKEN_SECRET = originalSecret;
    }
  });

  it("PARTICIPANT_TOKEN_SECRET 미설정이면 등록 응답에 participantToken이 없다(기존 동작과 동일, 하위호환)", async () => {
    delete process.env.PARTICIPANT_TOKEN_SECRET;
    const res = await request(app).post("/api/participants").send({
      anonymousId: "no-token-user",
      group_code: "EXP",
      installDate: "2026-08-13T00:00:00Z",
      participantCode: "TEST-EXP",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.participantToken).toBeNull();
  });

  it("PARTICIPANT_TOKEN_SECRET 설정 시 등록 응답에 그 anonymousId로 검증 가능한 토큰이 실린다", async () => {
    process.env.PARTICIPANT_TOKEN_SECRET = "reg-test-secret";
    const res = await request(app).post("/api/participants").send({
      anonymousId: "token-user",
      group_code: "EXP",
      installDate: "2026-08-13T00:00:00Z",
      participantCode: "TEST-EXP",
    });
    expect(res.status).toBe(200);

    const expected = crypto
      .createHmac("sha256", "reg-test-secret")
      .update("token-user")
      .digest("hex");
    expect(res.body.data.participantToken).toBe(expected);
  });

  // 코드리뷰 지적 회귀 테스트: registerParticipant가 공백만 검사하고 원본을 저장하면서
  // issueParticipantToken도 원본으로 호출되면, checkParticipant는 trim한 값으로 조회·HMAC
  // 계산을 하니 등록 직후 발급한 토큰이 보호된 라우트에서 not_found/invalid_token으로 실패한다.
  it("앞뒤 공백이 섞인 anonymousId로 등록해도, DB엔 정규화된 값이 저장되고 발급 토큰이 보호된 라우트에서 그대로 통과한다", async () => {
    process.env.PARTICIPANT_TOKEN_SECRET = "whitespace-test-secret";
    const res = await request(app).post("/api/participants").send({
      anonymousId: "  user-1  ",
      group_code: "EXP",
      installDate: "2026-08-13T00:00:00Z",
      participantCode: "TEST-EXP",
    });
    expect(res.status).toBe(200);

    // DB엔 트림된 값으로 저장돼야 한다 — 원본(공백 포함)으로 저장되면 checkParticipant의
    // trim한 조회와 어긋나 이후 모든 보호된 요청이 not_found가 된다.
    const row = db
      .prepare("SELECT anonymousId FROM participants WHERE anonymousId = ?")
      .get("user-1");
    expect(row).toBeDefined();

    const { participantToken } = res.body.data;
    expect(participantToken).toBe(
      crypto
        .createHmac("sha256", "whitespace-test-secret")
        .update("user-1")
        .digest("hex"),
    );

    // 발급받은 토큰이 실제 보호된 라우트(requireParticipant)를 통과하는지까지 확인. period-reviews는
    // 자격 미달이어도 403/404 없이 빈 배열만 돌려주므로, 200 여부만으로 requireParticipant 체인의
    // 성패를 다른 그룹별 부가 조건과 섞이지 않고 판정할 수 있다. 클라이언트는 자기가 보낸 원본
    // (공백 포함) anonymousId를 그대로 들고 있으므로, 그 값으로 요청해도 통과해야 한다 —
    // 서버가 등록 시점에 이미 정규화해 저장했기 때문.
    const reviewRes = await request(app).post("/api/period-reviews").send({
      anonymousId: "  user-1  ",
      participantToken,
    });
    expect(reviewRes.status).toBe(200);
  });

  it("이미 등록된 참여자가 재동기화(멱등 재등록)해도 같은 토큰을 다시 받는다", async () => {
    process.env.PARTICIPANT_TOKEN_SECRET = "reg-test-secret";
    const payload = {
      anonymousId: "resync-user",
      group_code: "EXP",
      installDate: "2026-08-13T00:00:00Z",
      participantCode: "TEST-EXP",
    };
    const first = await request(app).post("/api/participants").send(payload);
    const second = await request(app).post("/api/participants").send(payload);
    expect(first.body.data.participantToken).toBe(
      second.body.data.participantToken,
    );
  });

  it("재설치 복구(POST /recover) 응답에도 그 anonymousId로 검증 가능한 토큰이 실린다", async () => {
    process.env.PARTICIPANT_TOKEN_SECRET = "recover-test-secret";
    db.prepare(
      "INSERT INTO participants (anonymousId, participantCode, group_code, installDate) VALUES (?, ?, ?, ?)",
    ).run("recovered-user", "RECOVER-CODE", "EXP", "2026-08-13T00:00:00Z");

    const res = await request(app)
      .post("/api/participants/recover")
      .send({ participantCode: "RECOVER-CODE" });
    expect(res.status).toBe(200);

    const expected = crypto
      .createHmac("sha256", "recover-test-secret")
      .update("recovered-user")
      .digest("hex");
    expect(res.body.data.participantToken).toBe(expected);
  });

  it('보호된 라우트에 participantToken으로 {"toString":null}을 보내면 500이 아니라 403', async () => {
    process.env.PARTICIPANT_TOKEN_SECRET = "object-token-secret";
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
    ).run("object-token-user", "EXP", "2026-08-13T00:00:00Z");

    const res = await request(app)
      .post("/api/period-reviews")
      .send({
        anonymousId: "object-token-user",
        participantToken: { toString: null },
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("INVALID_PARTICIPANT_TOKEN");
  });
});

// 연구 종료 리뷰 이벤트의 결과별 경로. 핸들러의 not_found 분기와 catch는 requireParticipant가
// 미등록 참여자를 먼저 거르고 DB 오류가 나야만 실행되므로 HTTP로는 도달하지 않는다.
describe("실제 server/routes/participants.js — POST /study-end-review-event 결과별 경로", () => {
  // 설치일 + 12일 다음 날 09:00 KST가 이미 지났다. 리뷰 3구간이 모두 있으면 잠금 해제
  const ENDED_INSTALL_DATE = "2026-01-01T00:00:00+09:00";
  const NOT_ENDED_INSTALL_DATE = "2099-01-01T00:00:00+09:00";

  function insertParticipant(anonymousId, groupCode, installDate) {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, ?)",
    ).run(anonymousId, groupCode, installDate);
  }

  function insertAllPeriodReviews(anonymousId) {
    for (const periodIndex of [1, 2, 3]) {
      db.prepare(
        `INSERT INTO period_reviews
          (anonymousId, periodIndex, periodStart, periodEnd, isBaseline, generatedAt)
         VALUES (?, ?, '2026-01-01', '2026-01-04', 0, '2026-01-14T04:00:00+09:00')`,
      ).run(anonymousId, periodIndex);
    }
  }

  function eventColumns(anonymousId) {
    return db
      .prepare(
        "SELECT studyEndModalShownAt, studyEndReviewViewedAt FROM participants WHERE anonymousId = ?",
      )
      .get(anonymousId);
  }

  function sendEvent(anonymousId, event) {
    return request(app)
      .post("/api/participants/study-end-review-event")
      .send({ anonymousId, event });
  }

  beforeEach(() => {
    db.exec("DELETE FROM period_reviews");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 이 404는 핸들러가 아니라 requireParticipant가 보낸다(위 "라우트가 등록돼 있다" 테스트와 같은 경로)
  it("등록되지 않은 참여자는 404 NOT_FOUND", async () => {
    const res = await sendEvent("no-such-participant", "review_viewed");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it.each([
    {
      label: "EXP 그룹",
      group: "EXP",
      installDate: ENDED_INSTALL_DATE,
      withReviews: true,
    },
    {
      label: "연구 기간이 끝나지 않은 CON",
      group: "CON",
      installDate: NOT_ENDED_INSTALL_DATE,
      withReviews: true,
    },
    {
      label: "기간 리뷰가 다 생성되지 않은 CON",
      group: "CON",
      installDate: ENDED_INSTALL_DATE,
      withReviews: false,
    },
  ])(
    "$label은 403 NOT_ELIGIBLE이고 컬럼이 바뀌지 않는다",
    async ({ group, installDate, withReviews }) => {
      insertParticipant("event-user", group, installDate);
      if (withReviews) insertAllPeriodReviews("event-user");

      for (const event of ["modal_shown", "review_viewed"]) {
        const res = await sendEvent("event-user", event);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("NOT_ELIGIBLE");
      }
      expect(eventColumns("event-user")).toEqual({
        studyEndModalShownAt: null,
        studyEndReviewViewedAt: null,
      });
    },
  );

  it.each([
    {
      event: "modal_shown",
      column: "studyEndModalShownAt",
      other: "studyEndReviewViewedAt",
    },
    {
      event: "review_viewed",
      column: "studyEndReviewViewedAt",
      other: "studyEndModalShownAt",
    },
  ])(
    "잠금 해제된 CON의 $event는 200이고 $column만 기록되며, 재호출해도 최초 시각이 유지된다",
    async ({ event, column, other }) => {
      insertParticipant("con-user", "CON", ENDED_INSTALL_DATE);
      insertAllPeriodReviews("con-user");
      // 두 호출이 같은 밀리초에 끝나면 COALESCE가 없어도 통과하므로 호출 사이에 시각을 옮긴다
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));

      const first = await sendEvent("con-user", event);
      expect(first.status).toBe(200);
      expect(eventColumns("con-user")[column]).toBe("2026-10-01T00:00:00.000Z");
      expect(eventColumns("con-user")[other]).toBeNull();

      vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
      const second = await sendEvent("con-user", event);
      expect(second.status).toBe(200);
      expect(eventColumns("con-user")[column]).toBe("2026-10-01T00:00:00.000Z");
      expect(eventColumns("con-user")[other]).toBeNull();
    },
  );
});
