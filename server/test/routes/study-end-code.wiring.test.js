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

// study-end-gate.test.js는 requireParticipant가 빠진 복제 라우터를 쓴다.
// 여기서는 실제 server/routes/study-end-code.js를 로드해 미들웨어 순서·응답 코드·env 읽는 시점을 검증한다.
const require = createRequire(import.meta.url);
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `viewlens-study-end-code-wiring-${process.pid}.db`,
);
fs.rmSync(TEST_DB_PATH, { force: true });
process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
process.env.DB_PATH = TEST_DB_PATH;

const { db, initializeDB } = require("../../db.js");
initializeDB();

const { errorHandler } = require("../../middleware/responseHandler.js");
const studyEndCodeRouter = require("../../routes/study-end-code.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/study-end-code", studyEndCodeRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

const REVEAL_CODE = "SURVEY2026";
// 설치일 + 12일 다음 날 09:00 KST가 이미 지났다 — 리뷰 3구간이 모두 있으면 잠금 해제
const ENDED_INSTALL_DATE = "2026-01-01T00:00:00+09:00";
const NOT_ENDED_INSTALL_DATE = "2099-01-01T00:00:00+09:00";

// 레이트리밋 상태가 라우터 모듈 단위라 테스트끼리 한도를 나누지 않게 요청마다 IP를 다르게 준다
let ipSeq = 0;
const nextIp = () => `10.20.0.${++ipSeq}`;

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

function insertUnlockedControl(anonymousId) {
  insertParticipant(anonymousId, "CON", ENDED_INSTALL_DATE);
  insertAllPeriodReviews(anonymousId);
}

function verifiedAt(anonymousId) {
  return db
    .prepare(
      "SELECT studyEndCodeVerifiedAt FROM participants WHERE anonymousId = ?",
    )
    .get(anonymousId).studyEndCodeVerifiedAt;
}

function validate(body, ip = nextIp()) {
  return request(app)
    .post("/api/study-end-code/validate")
    .set("X-Real-IP", ip)
    .send(body);
}

const originalRevealCode = process.env.STUDY_END_REVEAL_CODE;
const originalTokenSecret = process.env.PARTICIPANT_TOKEN_SECRET;

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterAll(() => {
  db.close();
  fs.rmSync(TEST_DB_PATH, { force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM participants");
  db.exec("DELETE FROM period_reviews");
  process.env.STUDY_END_REVEAL_CODE = REVEAL_CODE;
  delete process.env.PARTICIPANT_TOKEN_SECRET;
});

afterEach(() => {
  vi.useRealTimers();
  restoreEnv("STUDY_END_REVEAL_CODE", originalRevealCode);
  restoreEnv("PARTICIPANT_TOKEN_SECRET", originalTokenSecret);
});

describe("실제 server/routes/study-end-code.js — POST /validate", () => {
  it.each([
    { label: "토큰 없음", token: undefined },
    { label: "토큰이 문자열이 아님", token: 12345 },
  ])(
    "$label이면 403이고 맞는 코드여도 검증 시각이 기록되지 않는다",
    async ({ token }) => {
      process.env.PARTICIPANT_TOKEN_SECRET = "study-end-secret";
      insertUnlockedControl("con-user");

      const res = await validate({
        anonymousId: "con-user",
        code: REVEAL_CODE,
        participantToken: token,
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("INVALID_PARTICIPANT_TOKEN");
      expect(verifiedAt("con-user")).toBeNull();
    },
  );

  it.each([
    { label: "없음", code: undefined },
    { label: "빈 문자열", code: "" },
    { label: "공백만", code: "   " },
    { label: "숫자", code: 123 },
    { label: "객체", code: {} },
  ])("code가 $label이면 400 MISSING_REQUIRED_FIELD", async ({ code }) => {
    insertUnlockedControl("con-user");

    const res = await validate({ anonymousId: "con-user", code });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
    expect(res.body.detail).toBe("code");
    expect(verifiedAt("con-user")).toBeNull();
  });

  it("코드가 틀리면 valid:false이고 검증 시각은 NULL로 남는다", async () => {
    insertUnlockedControl("con-user");

    const res = await validate({ anonymousId: "con-user", code: "WRONG-CODE" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ valid: false });
    expect(verifiedAt("con-user")).toBeNull();
  });

  it("EXP 그룹은 맞는 코드여도 valid:false", async () => {
    insertParticipant("exp-user", "EXP", ENDED_INSTALL_DATE);
    insertAllPeriodReviews("exp-user");

    const res = await validate({ anonymousId: "exp-user", code: REVEAL_CODE });
    expect(res.body.data).toEqual({ valid: false });
    expect(verifiedAt("exp-user")).toBeNull();
  });

  it.each([
    {
      label: "연구 기간이 끝나지 않음",
      installDate: NOT_ENDED_INSTALL_DATE,
      withReviews: true,
    },
    {
      label: "기간 리뷰가 다 생성되지 않음",
      installDate: ENDED_INSTALL_DATE,
      withReviews: false,
    },
  ])(
    "잠금 해제 전 CON($label)은 맞는 코드여도 valid:false",
    async ({ installDate, withReviews }) => {
      insertParticipant("con-user", "CON", installDate);
      if (withReviews) insertAllPeriodReviews("con-user");

      const res = await validate({
        anonymousId: "con-user",
        code: REVEAL_CODE,
      });
      expect(res.body.data).toEqual({ valid: false });
      expect(verifiedAt("con-user")).toBeNull();
    },
  );

  it("잠금 해제된 CON은 대소문자·앞뒤 공백이 달라도 통과하고, 재호출해도 최초 시각이 유지된다", async () => {
    insertUnlockedControl("con-user");
    // 두 호출이 같은 밀리초에 끝나면 COALESCE가 없어도 통과하므로 호출 사이에 시각을 옮긴다
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));

    const first = await validate({
      anonymousId: "con-user",
      code: " survey2026 ",
    });
    expect(first.body.data).toEqual({ valid: true });
    expect(verifiedAt("con-user")).toBe("2026-10-01T00:00:00.000Z");

    vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
    const second = await validate({
      anonymousId: "con-user",
      code: REVEAL_CODE,
    });
    expect(second.body.data).toEqual({ valid: true });
    expect(verifiedAt("con-user")).toBe("2026-10-01T00:00:00.000Z");
  });

  it.each([
    { label: "미설정", value: undefined },
    { label: "빈 문자열", value: "" },
  ])(
    "STUDY_END_REVEAL_CODE가 $label이면 어떤 코드든 valid:false",
    async ({ value }) => {
      restoreEnv("STUDY_END_REVEAL_CODE", value);
      insertUnlockedControl("con-user");

      for (const code of [REVEAL_CODE, "anything"]) {
        const res = await validate({ anonymousId: "con-user", code });
        expect(res.body.data).toEqual({ valid: false });
      }
      expect(verifiedAt("con-user")).toBeNull();
    },
  );

  it("같은 X-Real-IP로 6번째 요청은 429, 다른 IP는 통과한다", async () => {
    insertUnlockedControl("con-user");
    const ip = nextIp();

    for (let i = 0; i < 5; i++) {
      const res = await validate(
        { anonymousId: "con-user", code: "WRONG" },
        ip,
      );
      expect(res.status).toBe(200);
    }
    const sixth = await validate(
      { anonymousId: "con-user", code: "WRONG" },
      ip,
    );
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe("TOO_MANY_REQUESTS");

    const otherIp = await validate({ anonymousId: "con-user", code: "WRONG" });
    expect(otherIp.status).toBe(200);
  });

  // 현재 동작 문서화: 레이트리밋이 requireParticipant보다 앞이라 인증에 실패한 요청도 횟수를 소모한다
  it("토큰 없이 실패한 요청도 횟수를 소모해, 이후 올바른 요청이 429가 된다", async () => {
    process.env.PARTICIPANT_TOKEN_SECRET = "study-end-secret";
    insertUnlockedControl("con-user");
    const ip = nextIp();

    for (let i = 0; i < 5; i++) {
      const res = await validate(
        { anonymousId: "con-user", code: REVEAL_CODE },
        ip,
      );
      expect(res.status).toBe(403);
    }

    const participantToken = crypto
      .createHmac("sha256", "study-end-secret")
      .update("con-user")
      .digest("hex");
    const res = await validate(
      { anonymousId: "con-user", code: REVEAL_CODE, participantToken },
      ip,
    );
    expect(res.status).toBe(429);
    expect(verifiedAt("con-user")).toBeNull();

    // 429가 토큰 문제 때문이 아님을 확인 — 같은 요청을 다른 IP로 보내면 통과한다
    const fromOtherIp = await validate({
      anonymousId: "con-user",
      code: REVEAL_CODE,
      participantToken,
    });
    expect(fromOtherIp.body.data).toEqual({ valid: true });
  });
});
