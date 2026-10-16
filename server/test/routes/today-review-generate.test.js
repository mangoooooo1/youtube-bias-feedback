process.env.TZ = "Asia/Seoul";

import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { generateAndStoreTodayReview } from "../../routes/today-review-generate.js";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
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
      durationSeconds INTEGER
    );
    CREATE TABLE today_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      reviewDate TEXT NOT NULL,
      sessionCount INTEGER,
      videoCount INTEGER,
      validVideoCount INTEGER,
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

// "오늘" 리뷰는 세션이 아니라 영상 기록(video_events + video_metadata)에서 집계한다.
// category가 null이면 메타데이터 행 없이(카테고리를 못 가져온 상태로) 넣는다.
const CATEGORY_ID = { 음악: "10", 게임: "20" };
let videoSeq = 0;
function insertWatchedVideos(
  db,
  {
    anonymousId,
    sessionId = "s1",
    watchedAt,
    category = "음악",
    count = 1,
    title = "영상",
  },
) {
  for (let i = 0; i < count; i++) {
    videoSeq += 1;
    const videoId = `vid-${videoSeq}`;
    if (category !== null) {
      db.prepare(
        "INSERT INTO video_metadata (videoId, categoryId, durationSeconds) VALUES (?, ?, 600)",
      ).run(videoId, CATEGORY_ID[category]);
    }
    db.prepare(
      `INSERT INTO video_events (eventId, anonymousId, videoId, sessionId, title, watchedAt, watchedSeconds)
       VALUES (?, ?, ?, ?, ?, ?, 300)`,
    ).run(`e-${videoSeq}`, anonymousId, videoId, sessionId, title, watchedAt);
  }
}

// 3초만 본 영상 — 유효 시청이 아님
function insertShortVideo(db, anonymousId, watchedAt) {
  videoSeq += 1;
  db.prepare(
    `INSERT INTO video_events (eventId, anonymousId, videoId, sessionId, title, watchedAt, watchedSeconds)
     VALUES (?, ?, ?, 's1', '잠깐', ?, 3)`,
  ).run(`e-${videoSeq}`, anonymousId, `vid-${videoSeq}`, watchedAt);
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("generateAndStoreTodayReview", () => {
  it("오늘 본 영상이 하나도 없으면 null을 반환하고 아무것도 저장하지 않는다", async () => {
    const db = createTestDb();
    const now = new Date("2026-03-10T20:00:00+09:00");

    const result = await generateAndStoreTodayReview(db, {
      anonymousId: "no-session-user",
      apiKey: "fake-key",
      now,
    });

    expect(result).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS c FROM today_reviews").get().c).toBe(
      0,
    );
    db.close();
  });

  it("apiKey가 없으면 Gemini를 부르지 않고 폴백만 사용한다", async () => {
    const db = createTestDb();
    const now = new Date("2026-03-10T20:00:00+09:00");
    insertWatchedVideos(db, {
      anonymousId: "u1",
      watchedAt: "2026-03-10T10:00:00+09:00",
      count: 3,
    });
    global.fetch = vi.fn();

    const result = await generateAndStoreTodayReview(db, {
      anonymousId: "u1",
      apiKey: undefined,
      now,
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.source).toBe("fallback");
    expect(result.llmStatus).toBe("fallback");
    expect(result.genCount).toBe(1);

    const row = db
      .prepare("SELECT * FROM today_reviews WHERE anonymousId = ?")
      .get("u1");
    expect(row.reviewDate).toBe("2026-03-10");
    expect(row.source).toBe("fallback");
    expect(row.review).toContain("음악");
  });

  it("Gemini 호출이 성공하면 llm 결과를 저장한다", async () => {
    const db = createTestDb();
    const now = new Date("2026-03-10T20:00:00+09:00");
    insertWatchedVideos(db, {
      anonymousId: "u2",
      title: "오늘 영상",
      watchedAt: "2026-03-10T10:00:00+09:00",
      count: 3,
    });
    global.fetch = vi.fn().mockResolvedValue({
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
    });

    const result = await generateAndStoreTodayReview(db, {
      anonymousId: "u2",
      apiKey: "fake-key",
      now,
    });

    expect(result.source).toBe("llm");
    expect(result.review).toBe("관찰 문장");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-goog-api-key": "fake-key" }),
      }),
    );
  });

  it("Gemini 호출이 실패하면 폴백으로 대체하고 failureReason을 기록한다", async () => {
    const db = createTestDb();
    const now = new Date("2026-03-10T20:00:00+09:00");
    insertWatchedVideos(db, {
      anonymousId: "u3",
      watchedAt: "2026-03-10T10:00:00+09:00",
      count: 3,
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server error",
    });

    const result = await generateAndStoreTodayReview(db, {
      anonymousId: "u3",
      apiKey: "fake-key",
      now,
    });

    expect(result.source).toBe("fallback");
    expect(result.llmStatus).toBe("fallback");
    expect(result.failureReason).toBe("http_error");
    expect(result.httpStatus).toBe(500);
    expect(result.timedOut).toBeNull();
  });

  it("같은 날짜에 재호출하면 genCount가 1씩 증가하고 최신본으로 덮어쓴다", async () => {
    const db = createTestDb();
    const now = new Date("2026-03-10T10:00:00+09:00");
    insertWatchedVideos(db, {
      anonymousId: "u4",
      sessionId: "s1",
      watchedAt: "2026-03-10T09:00:00+09:00",
      count: 2,
    });

    const first = await generateAndStoreTodayReview(db, {
      anonymousId: "u4",
      apiKey: undefined,
      now,
    });
    expect(first.genCount).toBe(1);

    insertWatchedVideos(db, {
      anonymousId: "u4",
      sessionId: "s2",
      watchedAt: "2026-03-10T09:30:00+09:00",
      category: "게임",
      count: 5,
    });
    const second = await generateAndStoreTodayReview(db, {
      anonymousId: "u4",
      apiKey: undefined,
      now,
    });
    expect(second.genCount).toBe(2);

    const row = db
      .prepare("SELECT * FROM today_reviews WHERE anonymousId = ?")
      .get("u4");
    expect(row.genCount).toBe(2);
    expect(row.videoCount).toBe(7);
  });

  it("생성 시점의 유효 시청 영상 수를 저장한다(잠깐 본 영상 제외)", async () => {
    const db = createTestDb();
    const now = new Date("2026-03-10T20:00:00+09:00");
    insertWatchedVideos(db, {
      anonymousId: "u-valid",
      watchedAt: "2026-03-10T10:00:00+09:00",
      count: 2,
    });
    insertShortVideo(db, "u-valid", "2026-03-10T10:30:00+09:00");

    await generateAndStoreTodayReview(db, {
      anonymousId: "u-valid",
      apiKey: undefined,
      now,
    });

    const row = db
      .prepare("SELECT * FROM today_reviews WHERE anonymousId = ?")
      .get("u-valid");
    expect(row.videoCount).toBe(3);
    expect(row.validVideoCount).toBe(2);
  });

  it("오늘 영상이 모두 카테고리를 못 가져왔으면 Gemini 없이 폴백 리뷰를 저장한다(리뷰를 보류하지 않음)", async () => {
    const db = createTestDb();
    const now = new Date("2026-03-10T20:00:00+09:00");
    insertWatchedVideos(db, {
      anonymousId: "u5",
      watchedAt: "2026-03-10T10:00:00+09:00",
      category: null,
      count: 3,
    });
    global.fetch = vi.fn();

    const result = await generateAndStoreTodayReview(db, {
      anonymousId: "u5",
      apiKey: "fake-key",
      now,
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.source).toBe("fallback");
    expect(result.review).toContain("분석하지 못했습니다");
    const row = db
      .prepare("SELECT * FROM today_reviews WHERE anonymousId = ?")
      .get("u5");
    expect(row.videoCount).toBe(3);
  });

  it("카테고리를 못 가져온 영상이 일부만 섞여 있으면 그대로 Gemini를 부르고 그 제목도 넘긴다", async () => {
    const db = createTestDb();
    const now = new Date("2026-03-10T20:00:00+09:00");
    insertWatchedVideos(db, {
      anonymousId: "u6",
      watchedAt: "2026-03-10T10:00:00+09:00",
      count: 2,
    });
    insertWatchedVideos(db, {
      anonymousId: "u6",
      title: "분류 없는 영상",
      watchedAt: "2026-03-10T11:00:00+09:00",
      category: null,
    });
    global.fetch = vi.fn().mockResolvedValue({
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
    });

    const result = await generateAndStoreTodayReview(db, {
      anonymousId: "u6",
      apiKey: "fake-key",
      now,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("llm");
    const prompt = JSON.parse(global.fetch.mock.calls[0][1].body).contents[0]
      .parts[0].text;
    expect(prompt).toContain("분류 없는 영상");
  });
});

// 유효 시청 영상이 늘었을 때만 다시 만든다 — 근거가 같으면 Gemini 비용·중복 알림을 줄인다
describe("generateAndStoreTodayReview — 재생성 조건", () => {
  const NOW = new Date("2026-03-10T20:00:00+09:00");

  function geminiOk(feedback = "관찰 문장") {
    return vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ topic: "음악", feedback }) }],
            },
          },
        ],
      }),
    });
  }

  async function generate(db, anonymousId, extra = {}) {
    return generateAndStoreTodayReview(db, {
      anonymousId,
      apiKey: "fake-key",
      now: NOW,
      recordMetric: vi.fn(),
      ...extra,
    });
  }

  function storedRow(db, anonymousId) {
    return db
      .prepare("SELECT * FROM today_reviews WHERE anonymousId = ?")
      .get(anonymousId);
  }

  it("유효 시청 영상이 늘지 않았으면 Gemini 없이 건너뛰고 null을 반환한다(저장된 리뷰 유지)", async () => {
    const db = createTestDb();
    insertWatchedVideos(db, {
      anonymousId: "same",
      watchedAt: "2026-03-10T10:00:00+09:00",
      count: 2,
    });
    global.fetch = geminiOk("첫 리뷰");
    await generate(db, "same");

    const recordMetric = vi.fn();
    const result = await generate(db, "same", { recordMetric });

    expect(result).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(recordMetric).not.toHaveBeenCalled();
    expect(storedRow(db, "same")).toMatchObject({
      genCount: 1,
      review: "첫 리뷰",
      validVideoCount: 2,
    });
  });

  it("잠깐 본 영상만 늘었으면 건너뛴다", async () => {
    const db = createTestDb();
    insertWatchedVideos(db, {
      anonymousId: "short-only",
      watchedAt: "2026-03-10T10:00:00+09:00",
    });
    global.fetch = geminiOk();
    await generate(db, "short-only");

    insertShortVideo(db, "short-only", "2026-03-10T11:00:00+09:00");
    const result = await generate(db, "short-only");

    expect(result).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(storedRow(db, "short-only").videoCount).toBe(1);
  });

  it("유효 시청 영상이 1개라도 늘면 다시 생성한다", async () => {
    const db = createTestDb();
    insertWatchedVideos(db, {
      anonymousId: "plus-one",
      watchedAt: "2026-03-10T10:00:00+09:00",
    });
    global.fetch = geminiOk();
    await generate(db, "plus-one");

    insertWatchedVideos(db, {
      anonymousId: "plus-one",
      watchedAt: "2026-03-10T11:00:00+09:00",
    });
    const result = await generate(db, "plus-one");

    expect(result.genCount).toBe(2);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(storedRow(db, "plus-one").validVideoCount).toBe(2);
  });

  it("보는 중이던 영상의 시청 시간이 도착하면 다시 생성한다", async () => {
    const db = createTestDb();
    insertWatchedVideos(db, {
      anonymousId: "pending",
      watchedAt: "2026-03-10T10:00:00+09:00",
      count: 2,
    });
    db.prepare(
      `INSERT INTO video_events (eventId, anonymousId, videoId, sessionId, title, watchedAt, watchedSeconds)
       VALUES ('e-pending', 'pending', 'vid-pending', 's1', '보는 중', '2026-03-10T11:00:00+09:00', NULL)`,
    ).run();
    global.fetch = geminiOk();
    await generate(db, "pending");
    expect(storedRow(db, "pending").validVideoCount).toBe(2);

    // 다음 영상으로 넘어가며 시청 시간이 도착
    db.prepare(
      "UPDATE video_events SET watchedSeconds = 300 WHERE eventId = 'e-pending'",
    ).run();
    const result = await generate(db, "pending");

    expect(result.genCount).toBe(2);
    expect(storedRow(db, "pending").validVideoCount).toBe(3);
  });

  it("보는 중인 영상이 섞여도 대체 문구는 확인된 영상 수와 비중만 말한다", async () => {
    const db = createTestDb();
    insertWatchedVideos(db, {
      anonymousId: "fallback-pending",
      watchedAt: "2026-03-10T10:00:00+09:00",
      count: 2,
    });
    db.prepare(
      `INSERT INTO video_events (eventId, anonymousId, videoId, sessionId, title, watchedAt, watchedSeconds)
       VALUES ('e-fp', 'fallback-pending', 'vid-fp', 's1', '보는 중', '2026-03-10T11:00:00+09:00', NULL)`,
    ).run();

    const result = await generate(db, "fallback-pending", {
      apiKey: undefined,
    });

    expect(result.review).toBe(
      "오늘은 영상 2개를 보셨고, 시청 시간은 모두 음악이었어요.",
    );
  });

  it("지난 결과가 폴백이면 유효 영상이 늘지 않아도 다시 생성한다", async () => {
    const db = createTestDb();
    insertWatchedVideos(db, {
      anonymousId: "after-fallback",
      watchedAt: "2026-03-10T10:00:00+09:00",
    });
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "server error",
    });
    const first = await generate(db, "after-fallback");
    expect(first.llmStatus).toBe("fallback");

    global.fetch = geminiOk("다시 만든 리뷰");
    const second = await generate(db, "after-fallback");

    expect(second.llmStatus).toBe("success");
    expect(storedRow(db, "after-fallback")).toMatchObject({
      genCount: 2,
      review: "다시 만든 리뷰",
    });
  });

  // 같은 참여자의 세션 두 개가 거의 동시에 끝난 경우 — 생성을 한 줄로 세운다
  it("같은 참여자의 동시 호출은 순서대로 실행돼, 새 영상이 없으면 Gemini를 한 번만 부른다", async () => {
    const db = createTestDb();
    insertWatchedVideos(db, {
      anonymousId: "together",
      watchedAt: "2026-03-10T10:00:00+09:00",
    });
    global.fetch = geminiOk();

    const results = await Promise.all([
      generate(db, "together"),
      generate(db, "together"),
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(results[0].genCount).toBe(1);
    expect(results[1]).toBeNull();
    expect(storedRow(db, "together").genCount).toBe(1);
  });

  it("앞 생성 중에 유효 영상이 늘었으면 뒤 호출이 그 영상까지 넣어 다시 만든다", async () => {
    const db = createTestDb();
    insertWatchedVideos(db, {
      anonymousId: "added",
      watchedAt: "2026-03-10T10:00:00+09:00",
    });
    const respond = geminiOk();
    let calls = 0;
    // 첫 Gemini 호출 중에 다른 세션의 영상 기록이 도착한 상황
    global.fetch = vi.fn((...args) => {
      calls += 1;
      if (calls === 1) {
        insertWatchedVideos(db, {
          anonymousId: "added",
          watchedAt: "2026-03-10T11:00:00+09:00",
        });
      }
      return respond(...args);
    });

    const results = await Promise.all([
      generate(db, "added"),
      generate(db, "added"),
    ]);

    expect(results.map((r) => r.genCount)).toEqual([1, 2]);
    expect(storedRow(db, "added")).toMatchObject({
      genCount: 2,
      validVideoCount: 2,
    });
  });

  it("다른 참여자의 생성은 서로 기다리지 않는다", async () => {
    const db = createTestDb();
    for (const id of ["slow", "fast"]) {
      insertWatchedVideos(db, {
        anonymousId: id,
        watchedAt: "2026-03-10T10:00:00+09:00",
      });
    }
    let releaseSlow;
    const respond = geminiOk();
    global.fetch = vi.fn((url, init) => {
      // slow 참여자의 Gemini 응답만 붙잡아 둔다(제목으로 구분할 수 없어 첫 호출을 slow로 본다)
      if (global.fetch.mock.calls.length === 1) {
        return new Promise((resolve) => {
          releaseSlow = () => resolve(respond(url, init));
        });
      }
      return respond(url, init);
    });

    const slow = generate(db, "slow");
    const fast = await generate(db, "fast");

    expect(fast.genCount).toBe(1);
    releaseSlow();
    expect((await slow).genCount).toBe(1);
  });

  it("앞 생성이 오류로 끝나도 뒤 호출은 실행된다", async () => {
    const db = createTestDb();
    insertWatchedVideos(db, {
      anonymousId: "after-error",
      watchedAt: "2026-03-10T10:00:00+09:00",
    });
    global.fetch = geminiOk();
    const failing = vi.fn(() => {
      throw new Error("메트릭 기록 실패");
    });

    const [first, second] = await Promise.allSettled([
      generate(db, "after-error", { recordMetric: failing }),
      generate(db, "after-error"),
    ]);

    expect(first.status).toBe("rejected");
    expect(second.status).toBe("fulfilled");
    expect(second.value.genCount).toBe(1);
  });
});

describe("generateAndStoreTodayReview — LLM 호출 메트릭", () => {
  function seed(db, anonymousId) {
    insertWatchedVideos(db, {
      anonymousId,
      sessionId: `${anonymousId}-s1`,
      watchedAt: "2026-03-10T10:00:00+09:00",
      count: 3,
    });
  }
  const now = new Date("2026-03-10T20:00:00+09:00");

  it("Gemini 실패도 호출 1건으로 사유와 함께 기록하고, 참여자 정보는 넘기지 않는다", async () => {
    const db = createTestDb();
    seed(db, "m1");
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "quota",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const recordMetric = vi.fn();

    await generateAndStoreTodayReview(db, {
      anonymousId: "m1",
      apiKey: "fake-key",
      now,
      recordMetric,
    });
    vi.restoreAllMocks();

    expect(recordMetric).toHaveBeenCalledTimes(1);
    const [call] = recordMetric.mock.calls[0];
    expect(call).toEqual({
      kind: "today",
      llmStatus: "fallback",
      failureReason: "http_error",
      geminiMs: expect.any(Number),
      calledGemini: true,
    });
  });

  it("키가 없으면 calledGemini:false로 기록한다", async () => {
    const db = createTestDb();
    seed(db, "m2");
    const recordMetric = vi.fn();

    await generateAndStoreTodayReview(db, {
      anonymousId: "m2",
      apiKey: undefined,
      now,
      recordMetric,
    });

    expect(recordMetric.mock.calls[0][0]).toMatchObject({
      llmStatus: "fallback",
      calledGemini: false,
    });
  });

  it("오늘 본 영상이 없어 생성하지 않으면 기록하지 않는다", async () => {
    const db = createTestDb();
    const recordMetric = vi.fn();

    await generateAndStoreTodayReview(db, {
      anonymousId: "nobody",
      apiKey: "fake-key",
      now,
      recordMetric,
    });

    expect(recordMetric).not.toHaveBeenCalled();
  });
});
