import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  run,
  targetDates,
} from "../../scripts/generate-daily-today-reviews.js";
import { generateAndStoreTodayReview } from "../../routes/today-review-generate.js";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL UNIQUE,
      group_code TEXT NOT NULL,
      installDate TEXT NOT NULL
    );
    CREATE TABLE video_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId TEXT,
      anonymousId TEXT NOT NULL,
      videoId TEXT,
      sessionId TEXT,
      title TEXT,
      watchedAt TEXT,
      watchedSeconds REAL
    );
    CREATE TABLE video_metadata (
      videoId TEXT PRIMARY KEY,
      categoryId TEXT,
      title TEXT,
      durationSeconds INTEGER
    );
    CREATE TABLE today_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      reviewDate TEXT NOT NULL,
      sessionCount INTEGER,
      videoCount INTEGER,
      validVideoCount INTEGER,
      timeSharePercents TEXT,
      categoryDistribution TEXT,
      entropy REAL,
      review TEXT,
      reviewTopic TEXT,
      source TEXT,
      promptVersion TEXT,
      llmStatus TEXT,
      failureReason TEXT,
      geminiMs INTEGER,
      genCount INTEGER,
      generatedAt TEXT NOT NULL,
      updatedAt TEXT
    );
    CREATE UNIQUE INDEX idx_today_reviews_participant_date
      ON today_reviews(anonymousId, reviewDate);
  `);
  return db;
}

function addParticipant(db, anonymousId, group) {
  db.prepare(
    "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, ?, '2026-03-01T00:00:00+09:00')",
  ).run(anonymousId, group);
}

let seq = 0;
function addVideo(db, anonymousId, watchedAt, watchedSeconds = 300) {
  seq += 1;
  db.prepare(
    "INSERT INTO video_metadata (videoId, categoryId, durationSeconds) VALUES (?, '10', 600)",
  ).run(`vid-${seq}`);
  db.prepare(
    `INSERT INTO video_events (eventId, anonymousId, videoId, sessionId, title, watchedAt, watchedSeconds)
     VALUES (?, ?, ?, 's1', '영상', ?, ?)`,
  ).run(`e-${seq}`, anonymousId, `vid-${seq}`, watchedAt, watchedSeconds);
}

function geminiOk() {
  return {
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [{ text: '{"topic":"음악","feedback":"관찰 문장"}' }],
          },
        },
      ],
    }),
  };
}

function geminiDown() {
  return { ok: false, status: 503, text: async () => "unavailable" };
}

function reviewRow(db, anonymousId, reviewDate) {
  return db
    .prepare(
      "SELECT * FROM today_reviews WHERE anonymousId = ? AND reviewDate = ?",
    )
    .get(anonymousId, reviewDate);
}

// 크론은 03-11 00:30 KST에 돈다 → 대상 날짜 03-08 ~ 03-10
const NOW = new Date("2026-03-11T00:30:00+09:00");
const runAt = (db, now = NOW) =>
  run(db, "fake-key", { now, recordMetric: vi.fn() });

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("targetDates", () => {
  it("어제부터 3일 전까지의 KST 날짜를 오래된 순으로 돌려준다", () => {
    expect(targetDates(NOW)).toEqual([
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
  });

  it("UTC로는 전날이어도 KST 날짜 기준으로 계산한다", () => {
    // 2026-03-10T15:30Z = 03-11 00:30 KST
    expect(targetDates(new Date("2026-03-10T15:30:00Z"))).toEqual([
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
  });
});

describe("generate-daily-today-reviews run", () => {
  it("대조군의 어제 리뷰를 그날 전체 영상으로 한 번 만들고, 다시 돌려도 또 만들지 않는다", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = createTestDb();
    addParticipant(db, "con", "CON");
    addVideo(db, "con", "2026-03-10T09:00:00+09:00");
    addVideo(db, "con", "2026-03-10T23:50:00+09:00");
    // 크론 이후(오늘) 본 영상은 어제 리뷰에 들어가지 않는다
    addVideo(db, "con", "2026-03-11T00:10:00+09:00");
    global.fetch = vi.fn().mockResolvedValue(geminiOk());

    const first = await runAt(db);
    const second = await runAt(db);

    expect(first).toMatchObject({ created: 1, llmFailures: 0, skipped: 0 });
    expect(second.created).toBe(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(reviewRow(db, "con", "2026-03-10")).toMatchObject({
      validVideoCount: 2,
      llmStatus: "success",
      genCount: 1,
    });
    expect(reviewRow(db, "con", "2026-03-11")).toBeUndefined();
  });

  it("실험군은 마지막 생성 이후 유효 영상이 늘었을 때만 마감 생성한다", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = createTestDb();
    addParticipant(db, "exp-same", "EXP");
    addParticipant(db, "exp-more", "EXP");
    for (const id of ["exp-same", "exp-more"]) {
      addVideo(db, id, "2026-03-10T20:00:00+09:00");
    }
    global.fetch = vi.fn().mockResolvedValue(geminiOk());
    // 세션 종료 때 이미 만들어진 실시간 리뷰(유효 1개 시점)
    for (const anonymousId of ["exp-same", "exp-more"]) {
      await generateAndStoreTodayReview(db, {
        anonymousId,
        apiKey: "fake-key",
        now: new Date("2026-03-10T21:00:00+09:00"),
        recordMetric: vi.fn(),
      });
    }
    expect(global.fetch).toHaveBeenCalledTimes(2);
    // 마지막 세션의 영상이 생성 뒤에 늘어남
    addVideo(db, "exp-more", "2026-03-10T23:40:00+09:00");

    const summary = await runAt(db);

    expect(summary.created).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(reviewRow(db, "exp-same", "2026-03-10").genCount).toBe(1);
    expect(reviewRow(db, "exp-more", "2026-03-10")).toMatchObject({
      genCount: 2,
      validVideoCount: 2,
    });
  });

  it("폴백인 날은 3일 동안 하루 한 번 재시도하고, 그보다 오래된 날은 건드리지 않는다", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = createTestDb();
    addParticipant(db, "con", "CON");
    addVideo(db, "con", "2026-03-07T10:00:00+09:00");
    addVideo(db, "con", "2026-03-10T10:00:00+09:00");
    global.fetch = vi.fn().mockResolvedValue(geminiDown());

    // 03-11 크론: 03-10이 폴백으로 남음
    await run(db, "fake-key", { now: NOW, recordMetric: vi.fn() });
    expect(reviewRow(db, "con", "2026-03-10").llmStatus).toBe("fallback");

    // 03-12 크론: Gemini가 복구돼 03-10이 정상 리뷰로 바뀜
    global.fetch = vi.fn().mockResolvedValue(geminiOk());
    const retried = await runAt(db, new Date("2026-03-12T00:30:00+09:00"));

    expect(retried.created).toBe(1);
    expect(reviewRow(db, "con", "2026-03-10")).toMatchObject({
      llmStatus: "success",
      genCount: 2,
    });
    // 03-07은 03-11 크론의 범위(03-08~03-10) 밖이라 만들지 않았다
    expect(reviewRow(db, "con", "2026-03-07")).toBeUndefined();
  });

  it("Gemini를 불렀다가 실패한 건은 llmFailures로, 그날 유효 시청이 없으면 변화없음으로 센다", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = createTestDb();
    addParticipant(db, "down", "CON");
    addParticipant(db, "idle", "CON");
    addVideo(db, "down", "2026-03-10T10:00:00+09:00");
    addVideo(db, "idle", "2026-03-10T10:00:00+09:00", 3); // 잠깐 본 영상뿐
    global.fetch = vi.fn().mockResolvedValue(geminiDown());

    const summary = await runAt(db);

    expect(summary).toMatchObject({
      created: 0,
      llmFailures: 1,
      skipped: 0,
      unchanged: 5,
    });
  });

  it("그날 영상의 분야를 하나도 못 가져왔으면(유튜브 API 장애 등) Gemini를 부르지 않고 fallback으로 센다", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = createTestDb();
    addParticipant(db, "nocat", "CON");
    db.prepare(
      "INSERT INTO video_metadata (videoId, categoryId, durationSeconds) VALUES ('vid-nocat', NULL, 600)",
    ).run();
    db.prepare(
      `INSERT INTO video_events (eventId, anonymousId, videoId, sessionId, title, watchedAt, watchedSeconds)
       VALUES ('e-nocat', 'nocat', 'vid-nocat', 's1', '영상', '2026-03-10T10:00:00+09:00', 300)`,
    ).run();
    global.fetch = vi.fn();

    const summary = await runAt(db);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ fallback: 1, created: 0, llmFailures: 0 });
    expect(reviewRow(db, "nocat", "2026-03-10")).toMatchObject({
      llmStatus: "fallback",
      failureReason: null,
    });
  });

  it("한 참여자 처리 중 오류가 나도 다른 참여자는 계속 처리하고 skipped로 센다", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = createTestDb();
    addParticipant(db, "broken", "CON");
    addParticipant(db, "fine", "CON");
    addVideo(db, "broken", "2026-03-10T10:00:00+09:00");
    addVideo(db, "fine", "2026-03-10T10:00:00+09:00");
    global.fetch = vi.fn().mockResolvedValue(geminiOk());
    let calls = 0;
    const recordMetric = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error("메트릭 기록 실패");
    });

    const summary = await run(db, "fake-key", { now: NOW, recordMetric });

    expect(summary.skipped).toBe(1);
    expect(summary.created).toBe(1);
    expect(reviewRow(db, "fine", "2026-03-10").llmStatus).toBe("success");
  });
});
