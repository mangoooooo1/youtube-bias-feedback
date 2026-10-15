import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import crypto from "crypto";
import request from "supertest";
import express from "express";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 실제 server/routes/viewing-summary.js와 db.js를 그대로 로드해 배선·자격·응답 형태를 검증한다.
const require = createRequire(import.meta.url);
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `viewlens-viewing-summary-wiring-${process.pid}.db`,
);
fs.rmSync(TEST_DB_PATH, { force: true });
process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
process.env.DB_PATH = TEST_DB_PATH;

const { db, initializeDB } = require("../../db.js");
initializeDB();

const { errorHandler } = require("../../middleware/responseHandler.js");
const viewingSummaryRouter = require("../../routes/viewing-summary.js");
const { getViewingSummary } = require("../../routes/viewing-summary-query.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/viewing-summary", viewingSummaryRouter);
  app.use(errorHandler);
  return app;
}
const app = buildApp();

const DAY_MS = 86400000;

function addParticipant(anonymousId, group, installDate, extra = {}) {
  db.prepare(
    `INSERT INTO participants (anonymousId, group_code, installDate, studyEndCodeVerifiedAt)
     VALUES (?, ?, ?, ?)`,
  ).run(anonymousId, group, installDate, extra.studyEndCodeVerifiedAt ?? null);
}

let seq = 0;
function addVideo(
  anonymousId,
  { watchedAt, categoryId = "10", watchedSeconds = 300, durationSeconds = 600 },
) {
  seq += 1;
  const videoId = `vs-${seq}`;
  if (categoryId !== null) {
    db.prepare(
      "INSERT INTO video_metadata (videoId, categoryId, durationSeconds) VALUES (?, ?, ?)",
    ).run(videoId, categoryId, durationSeconds);
  }
  db.prepare(
    `INSERT INTO video_events (eventId, anonymousId, videoId, title, watchedAt, watchedSeconds)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`ev-${seq}`, anonymousId, videoId, videoId, watchedAt, watchedSeconds);
  return `ev-${seq}`;
}

afterAll(() => {
  db.close();
  fs.rmSync(TEST_DB_PATH, { force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM participants");
  db.exec("DELETE FROM video_events");
});

describe("POST /api/viewing-summary — 배선·자격", () => {
  it("자격 있는 참여자(베이스라인 이후 EXP)는 날짜별·구간별 집계를 받는다", async () => {
    const installDate = new Date(Date.now() - 6 * DAY_MS).toISOString();
    addParticipant("exp-eligible", "EXP", installDate);
    addVideo("exp-eligible", { watchedAt: new Date().toISOString() });

    const res = await request(app)
      .post("/api/viewing-summary")
      .send({ anonymousId: "exp-eligible" });

    expect(res.status).toBe(200);
    expect(res.body.data.days).toHaveLength(1);
    expect(res.body.data.days[0].countDistribution).toEqual({ 음악: 1 });
    expect(res.body.data.periods.length).toBeGreaterThan(0);
  });

  it("베이스라인 기간 중인 EXP는 빈 배열을 받는다(today-reviews와 같은 규칙)", async () => {
    addParticipant("exp-baseline", "EXP", new Date().toISOString());
    addVideo("exp-baseline", { watchedAt: new Date().toISOString() });

    const res = await request(app)
      .post("/api/viewing-summary")
      .send({ anonymousId: "exp-baseline" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ days: [], periods: [] });
  });

  it("종료 코드를 입력하기 전 CON은 빈 배열, 입력한 뒤에는 집계를 받는다", async () => {
    const installDate = new Date(Date.now() - 6 * DAY_MS).toISOString();
    addParticipant("con-before", "CON", installDate);
    addParticipant("con-after", "CON", installDate, {
      studyEndCodeVerifiedAt: new Date().toISOString(),
    });
    addVideo("con-before", { watchedAt: new Date().toISOString() });
    addVideo("con-after", { watchedAt: new Date().toISOString() });

    const before = await request(app)
      .post("/api/viewing-summary")
      .send({ anonymousId: "con-before" });
    const after = await request(app)
      .post("/api/viewing-summary")
      .send({ anonymousId: "con-after" });

    expect(before.body.data).toEqual({ days: [], periods: [] });
    expect(after.body.data.days).toHaveLength(1);
  });

  it("등록되지 않은 참여자는 404", async () => {
    const res = await request(app)
      .post("/api/viewing-summary")
      .send({ anonymousId: "nobody" });
    expect(res.status).toBe(404);
  });

  // 화면 지표 선택 원칙 3 — H2 결과 변수(다양성 점수)는 화면용 응답에 넣지 않는다
  it("응답에 다양성 점수(entropy·weightedEntropy)와 분석용 분포가 없다", async () => {
    addParticipant("no-score", "TEST-EXP", "2026-01-01T00:00:00Z");
    addVideo("no-score", { watchedAt: new Date().toISOString() });

    const res = await request(app)
      .post("/api/viewing-summary")
      .send({ anonymousId: "no-score" });

    const text = JSON.stringify(res.body.data);
    for (const key of [
      "entropy",
      "weightedEntropy",
      "weightedDistribution",
      "analysisDistribution",
    ]) {
      expect(text).not.toContain(`"${key}"`);
    }
  });
});

describe("POST /api/viewing-summary — PARTICIPANT_TOKEN_SECRET 설정 시 소유권 검증", () => {
  const originalSecret = process.env.PARTICIPANT_TOKEN_SECRET;
  const SECRET = "wiring-test-secret";

  beforeEach(() => {
    process.env.PARTICIPANT_TOKEN_SECRET = SECRET;
    addParticipant("token-owner", "TEST-EXP", "2026-01-01T00:00:00Z");
  });

  afterEach(() => {
    if (originalSecret === undefined)
      delete process.env.PARTICIPANT_TOKEN_SECRET;
    else process.env.PARTICIPANT_TOKEN_SECRET = originalSecret;
  });

  const tokenFor = (id) =>
    crypto.createHmac("sha256", SECRET).update(id).digest("hex");

  it("유효한 토큰이면 200", async () => {
    const res = await request(app)
      .post("/api/viewing-summary")
      .send({
        anonymousId: "token-owner",
        participantToken: tokenFor("token-owner"),
      });
    expect(res.status).toBe(200);
  });

  it("다른 참여자의 토큰이면 403 — 남의 시청 기록을 조회할 수 없다", async () => {
    const res = await request(app)
      .post("/api/viewing-summary")
      .send({
        anonymousId: "token-owner",
        participantToken: tokenFor("someone-else"),
      });
    expect(res.status).toBe(403);
  });
});

describe("getViewingSummary — 날짜·구간 나눔과 화면용 값", () => {
  // 설치 2026-03-01 KST, 4일 구간(study-constants) → 1구간 3/1~3/4, 2구간 3/5~3/8, 3구간 3/9~3/12
  const INSTALL = "2026-03-01T00:00:00+09:00";
  const NOW = new Date("2026-03-06T12:00:00+09:00");

  it("영상을 본 시각(KST) 기준으로 날짜를 나누고, 시작된 구간까지만 돌려준다", () => {
    addParticipant("split", "TEST-EXP", INSTALL);
    addVideo("split", {
      watchedAt: "2026-03-04T23:50:00+09:00",
      categoryId: "10",
    });
    addVideo("split", { watchedAt: "2026-03-04T15:10:00Z", categoryId: "20" }); // KST 3/5 00:10

    const { days, periods } = getViewingSummary(db, "split", NOW);

    expect(days.map((d) => d.date)).toEqual(["2026-03-04", "2026-03-05"]);
    expect(days[0].countDistribution).toEqual({ 음악: 1 });
    expect(days[1].countDistribution).toEqual({ 게임: 1 });
    // 3구간(3/9 시작)은 아직 시작 전이라 없다
    expect(periods.map((p) => [p.periodIndex, p.start, p.end])).toEqual([
      [1, "2026-03-01", "2026-03-04"],
      [2, "2026-03-05", "2026-03-08"],
    ]);
    expect(periods[0].countDistribution).toEqual({ 음악: 1 });
    expect(periods[1].countDistribution).toEqual({ 게임: 1 });
  });

  it("날짜별로 그래프에서 뺀 영상과 사유를 영상별로 돌려주고, 구간에는 넣지 않는다", () => {
    addParticipant("excluded", "TEST-EXP", INSTALL);
    addVideo("excluded", { watchedAt: "2026-03-05T10:00:00+09:00" });
    const short = addVideo("excluded", {
      watchedAt: "2026-03-05T10:10:00+09:00",
      watchedSeconds: 3,
    });
    const pending = addVideo("excluded", {
      watchedAt: "2026-03-05T10:20:00+09:00",
      watchedSeconds: null,
    });
    const uncategorized = addVideo("excluded", {
      watchedAt: "2026-03-05T10:30:00+09:00",
      categoryId: null,
    });

    const { days, periods } = getViewingSummary(db, "excluded", NOW);

    expect(days[0]).toMatchObject({
      validCount: 3,
      shortCount: 1,
      pendingTimeCount: 1,
      uncategorizedCount: 1,
      chartCount: 1,
      chartSeconds: 300,
    });
    expect(days[0].excluded).toEqual([
      { eventId: short, reason: "short" },
      { eventId: pending, reason: "pending_time" },
      { eventId: uncategorized, reason: "uncategorized" },
    ]);
    expect(periods[1].excluded).toBeUndefined();
    expect(periods[1].validCount).toBe(3);
  });

  it("시청 시간 합이 유한하지 않으면 null로 돌려준다(영상 길이를 모르는 극단값)", () => {
    addParticipant("overflow", "TEST-EXP", INSTALL);
    for (let i = 0; i < 3; i++) {
      addVideo("overflow", {
        watchedAt: "2026-03-05T10:00:00+09:00",
        watchedSeconds: 8e307,
        durationSeconds: null,
      });
    }

    const { days } = getViewingSummary(db, "overflow", NOW);

    expect(days[0].chartSeconds).toBeNull();
    expect(days[0].timeDistribution).toEqual({ 음악: 1 });
  });
});
