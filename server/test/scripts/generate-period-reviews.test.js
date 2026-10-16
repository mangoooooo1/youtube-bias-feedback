import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import { run, shouldFail } from "../../scripts/generate-period-reviews.js";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL UNIQUE,
      group_code TEXT NOT NULL,
      installDate TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      categoryDistribution TEXT,
      videoCount INTEGER,
      endTime TEXT
    );
    CREATE TABLE video_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      videoId TEXT,
      title TEXT,
      watchedAt TEXT NOT NULL,
      watchedSeconds REAL
    );
    CREATE TABLE video_metadata (
      videoId TEXT PRIMARY KEY,
      categoryId TEXT,
      durationSeconds INTEGER
    );
    CREATE TABLE period_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      periodIndex INTEGER NOT NULL,
      periodStart TEXT NOT NULL,
      periodEnd TEXT NOT NULL,
      isBaseline INTEGER NOT NULL,
      sessionCount INTEGER,
      videoCount INTEGER,
      categoryDistribution TEXT,
      entropy REAL,
      weightedCategoryDistribution TEXT,
      weightedEntropy REAL,
      validVideoCount INTEGER,
      review TEXT,
      reviewTopic TEXT,
      source TEXT,
      promptVersion TEXT,
      llmStatus TEXT,
      failureReason TEXT,
      geminiMs INTEGER,
      generatedAt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_period_reviews_participant_period
      ON period_reviews(anonymousId, periodIndex);
    CREATE TABLE period_review_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      periodIndex INTEGER NOT NULL,
      periodStart TEXT NOT NULL,
      periodEnd TEXT NOT NULL,
      isBaseline INTEGER NOT NULL,
      sessionCount INTEGER,
      videoCount INTEGER,
      categoryDistribution TEXT,
      entropy REAL,
      weightedEntropy REAL,
      weightedCategoryDistribution TEXT,
      validVideoCount INTEGER,
      review TEXT,
      reviewTopic TEXT,
      source TEXT,
      promptVersion TEXT,
      llmStatus TEXT,
      failureReason TEXT,
      geminiMs INTEGER,
      generatedAt TEXT NOT NULL
    );
  `);
  return db;
}

// 기간 집계는 세션이 아니라 영상 기록(video_events)에서 직접 계산하므로, Gemini 호출을 기대하는
// 테스트는 운영처럼 세션과 함께 그 세션에서 본 영상 기록도 넣는다.
function insertWatchedVideo(db, anonymousId, watchedAt) {
  db.prepare(
    "INSERT OR IGNORE INTO video_metadata (videoId, categoryId, durationSeconds) VALUES ('vid-music', '10', 600)",
  ).run();
  db.prepare(
    "INSERT INTO video_events (anonymousId, videoId, title, watchedAt, watchedSeconds) VALUES (?, 'vid-music', '음악 영상', ?, 300)",
  ).run(anonymousId, watchedAt);
}

// 설치일로부터 이미 12일이 지난 것으로 고정 — 현재 구성(DAYS_PER_PERIOD=4, TOTAL_DAYS=12)
// 기준으로 3개 기간(베이스라인 1구간 + 일반 2구간) 전부 완료 대상이 된다.
const INSTALL_DATE = "2026-06-01T00:00:00+09:00";
const FIXED_NOW = new Date("2026-06-13T10:00:00+09:00");

describe("generate-period-reviews.js — run()", () => {
  let db;
  const originalFetch = global.fetch;

  beforeEach(() => {
    db = createTestDb();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    db.close();
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("대조군(CON, TEST-CON)도 실험군과 동일하게 처리 대상에 포함된다 (Story 10-10 사전 생성)", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'CON', ?)",
    ).run("con-user", INSTALL_DATE);
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'TEST-CON', ?)",
    ).run("test-con-user", INSTALL_DATE);

    global.fetch = vi.fn();
    await run(db, "fake-key");

    for (const anonymousId of ["con-user", "test-con-user"]) {
      const rows = db
        .prepare(
          "SELECT * FROM period_reviews WHERE anonymousId = ? ORDER BY periodIndex",
        )
        .all(anonymousId);
      expect(rows.length).toBe(3); // 1~3구간 — EXP와 동일하게 전부 생성됨
      expect(rows.every((r) => r.source === "fallback")).toBe(true);
    }
    // 세션이 없는 케이스라 Gemini 호출은 여전히 생략된다(기존 fallback 경로 재사용).
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("세션이 없는 기간은 Gemini 호출을 생략하고 fallback으로 저장한다", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run("empty-user", INSTALL_DATE);

    global.fetch = vi.fn();
    const summary = await run(db, "fake-key");

    const rows = db
      .prepare(
        "SELECT * FROM period_reviews WHERE anonymousId = ? ORDER BY periodIndex",
      )
      .all("empty-user");
    expect(rows.length).toBe(3); // 1~3일차
    expect(rows.every((r) => r.source === "fallback")).toBe(true);
    expect(
      rows.every((r) => r.review.includes("분석할 시청 기록이 없어요")),
    ).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();

    // 세션이 없어 Gemini 호출 자체를 생략한 fallback은 llmFailures로 세지 않는다.
    // 참여자가 그 기간에 안 본 것뿐이라 실패로 볼 이유가 없다(shouldFail 참고).
    expect(summary).toEqual({
      created: 0,
      fallback: 3,
      llmFailures: 0,
      skipped: 0,
    });
    expect(shouldFail(summary)).toBe(false);
  });

  it("기간 내 video_events의 시청시간을 가중해 weightedEntropy를 계산하고, 오클릭(클릭성 이탈) 영상은 걸러낸다", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run("weighted-user", INSTALL_DATE);
    db.prepare(
      "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
    ).run(
      "weighted-user",
      JSON.stringify({ 음악: 1 }),
      2,
      "2026-06-01T10:00:00+09:00",
    );
    db.prepare(
      "INSERT INTO video_metadata (videoId, categoryId, durationSeconds) VALUES (?, ?, ?)",
    ).run("vid-music", "10", 600);
    db.prepare(
      "INSERT INTO video_metadata (videoId, categoryId, durationSeconds) VALUES (?, ?, ?)",
    ).run("vid-news", "25", 600);
    // 음악 영상은 300초(길이 600초의 50%) 실제 시청 — 유효. 뉴스 영상은 5초 만에 이탈
    // (5초<30초, 5/600≈0.8%<25%) — 오클릭으로 간주돼 가중 계산에서 제외돼야 한다.
    db.prepare(
      "INSERT INTO video_events (anonymousId, videoId, title, watchedAt, watchedSeconds) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "weighted-user",
      "vid-music",
      "음악 영상",
      "2026-06-01T10:00:00+09:00",
      300,
    );
    db.prepare(
      "INSERT INTO video_events (anonymousId, videoId, title, watchedAt, watchedSeconds) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "weighted-user",
      "vid-news",
      "뉴스 영상",
      "2026-06-01T10:05:00+09:00",
      5,
    );

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '{"topic":"음악","feedback":"문장"}' }],
            },
          },
        ],
      }),
    });

    await run(db, "fake-key");

    const row = db
      .prepare(
        "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
      )
      .get("weighted-user");
    // 오클릭 영상(뉴스)이 걸러져 유효 영상은 음악 1건뿐 — 카테고리가 1개뿐이라 entropy=0
    expect(row.validVideoCount).toBe(1);
    expect(row.weightedEntropy).toBe(0);
    expect(JSON.parse(row.weightedCategoryDistribution)).toEqual({ 음악: 1 });
  });

  it("watchedSeconds 데이터가 없으면(구버전 확장) weighted 계열을 NULL로 남기고 1차 지표는 그대로 계산한다", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run("legacy-user", INSTALL_DATE);
    db.prepare(
      "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
    ).run(
      "legacy-user",
      JSON.stringify({ 음악: 1 }),
      1,
      "2026-06-01T10:00:00+09:00",
    );
    // watchedSeconds를 아예 보내지 않는 구버전 확장 상황을 재현 — 컬럼 자체를 채우지 않는다.
    db.prepare(
      "INSERT INTO video_events (anonymousId, videoId, title, watchedAt) VALUES (?, ?, ?, ?)",
    ).run("legacy-user", "vid-music", "음악 영상", "2026-06-01T10:00:00+09:00");

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '{"topic":"음악","feedback":"문장"}' }],
            },
          },
        ],
      }),
    });

    await run(db, "fake-key");

    const row = db
      .prepare(
        "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
      )
      .get("legacy-user");
    expect(row.entropy).not.toBeNull();
    expect(row.weightedEntropy).toBeNull();
    expect(row.weightedCategoryDistribution).toBeNull();
    // watchedSeconds를 몰라도(계측 실패) isValidWatch는 보수적으로 true를 반환하므로 영상 자체는 유효로 센다.
    expect(row.validVideoCount).toBe(1);
  });

  it("title이 없는 video_events도 가중 지표(validVideoCount/weightedEntropy) 계산에는 포함한다", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run("no-title-user", INSTALL_DATE);
    db.prepare(
      "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
    ).run(
      "no-title-user",
      JSON.stringify({ 음악: 1 }),
      1,
      "2026-06-01T10:00:00+09:00",
    );
    db.prepare(
      "INSERT INTO video_metadata (videoId, categoryId, durationSeconds) VALUES (?, ?, ?)",
    ).run("vid-no-title", "10", 600);
    // title 추출이 실패한(또는 아직 안 붙은) 상황을 재현 — title은 NULL이지만 watchedSeconds는 있다.
    db.prepare(
      "INSERT INTO video_events (anonymousId, videoId, title, watchedAt, watchedSeconds) VALUES (?, ?, NULL, ?, ?)",
    ).run("no-title-user", "vid-no-title", "2026-06-01T10:00:00+09:00", 300);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '{"topic":"음악","feedback":"문장"}' }],
            },
          },
        ],
      }),
    });

    await run(db, "fake-key");

    const row = db
      .prepare(
        "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
      )
      .get("no-title-user");
    // title이 없다는 이유로 가중 계산에서 제외되면 안 된다 — videoId/watchedSeconds만으로 계산 가능.
    expect(row.validVideoCount).toBe(1);
    expect(row.weightedEntropy).toBe(0);
    expect(JSON.parse(row.weightedCategoryDistribution)).toEqual({ 음악: 1 });
  });

  // 세션 분포를 전체 영상 수로 병합하던 방식은 이 예시를 음악 83% / 게임 17%로 만들었다
  it("유효 영상 비율이 다른 세션이 섞여도 기간 분포를 영상 기록에서 직접 계산한다(50/50)", async () => {
    const userId = "merge-user";
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run(userId, INSTALL_DATE);
    const insertSession = db.prepare(
      "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
    );
    // 세션 A: 전체 10개 중 유효 음악 2개(나머지 8개는 스포츠를 5초씩), 세션 B: 전체 2개 중 유효 게임 2개
    insertSession.run(
      userId,
      JSON.stringify({ 음악: 1 }),
      10,
      "2026-06-01T11:00:00+09:00",
    );
    insertSession.run(
      userId,
      JSON.stringify({ 게임: 1 }),
      2,
      "2026-06-02T11:00:00+09:00",
    );
    const insertMeta = db.prepare(
      "INSERT INTO video_metadata (videoId, categoryId, durationSeconds) VALUES (?, ?, 600)",
    );
    insertMeta.run("m-music", "10");
    insertMeta.run("m-sports", "17");
    insertMeta.run("m-game", "20");
    const insertEvent = db.prepare(
      "INSERT INTO video_events (anonymousId, videoId, title, watchedAt, watchedSeconds) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 2; i++)
      insertEvent.run(
        userId,
        "m-music",
        "음악",
        "2026-06-01T10:00:00+09:00",
        300,
      );
    for (let i = 0; i < 8; i++)
      insertEvent.run(
        userId,
        "m-sports",
        "스포츠",
        "2026-06-01T10:30:00+09:00",
        5,
      );
    for (let i = 0; i < 2; i++)
      insertEvent.run(
        userId,
        "m-game",
        "게임",
        "2026-06-02T10:00:00+09:00",
        300,
      );

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '{"topic":"음악","feedback":"문장"}' }],
            },
          },
        ],
      }),
    });

    await run(db, "fake-key");

    const row = db
      .prepare(
        "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
      )
      .get(userId);
    expect(JSON.parse(row.categoryDistribution)).toEqual({
      음악: 0.5,
      게임: 0.5,
    });
    expect(row.entropy).toBe(1);
    expect(row.validVideoCount).toBe(4);
    expect(row.videoCount).toBe(12); // 잠깐 본 영상까지 포함한 영상 기록 수
    expect(row.sessionCount).toBe(2);
  });

  // 결정 8 — 2구간부터 직전 구간 비교를 프롬프트에 넣고, 리뷰 첫 문장을 비교로 쓰게 한다
  describe("직전 구간 비교", () => {
    const userId = "compare-user";

    // 1구간(6/1~6/4) 음악만, 2구간(6/5~6/8) 음악·게임 반반, 3구간은 기록 없음
    function seedTwoPeriods() {
      db.prepare(
        "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
      ).run(userId, INSTALL_DATE);
      const insertMeta = db.prepare(
        "INSERT INTO video_metadata (videoId, categoryId, durationSeconds) VALUES (?, ?, 600)",
      );
      insertMeta.run("c-music", "10");
      insertMeta.run("c-game", "20");
      const insertEvent = db.prepare(
        "INSERT INTO video_events (anonymousId, videoId, title, watchedAt, watchedSeconds) VALUES (?, ?, ?, ?, 300)",
      );
      for (let i = 0; i < 8; i++)
        insertEvent.run(
          userId,
          "c-music",
          `음악 ${i}`,
          "2026-06-01T10:00:00+09:00",
        );
      for (let i = 0; i < 4; i++) {
        insertEvent.run(
          userId,
          "c-music",
          `음악 ${i}`,
          "2026-06-05T10:00:00+09:00",
        );
        insertEvent.run(
          userId,
          "c-game",
          `게임 ${i}`,
          "2026-06-06T10:00:00+09:00",
        );
      }
    }

    // 비교를 요청한 프롬프트(2구간부터)에는 비교 문장으로 시작하는 리뷰로 답한다
    function geminiAnswering(comparedFeedback) {
      return vi.fn(async (_url, opts) => {
        const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
        const answer = {
          topic: "음악",
          feedback: prompt.includes("feedback의 첫 문장은 직전 구간과의 비교")
            ? comparedFeedback
            : "관찰 문장",
        };
        return {
          ok: true,
          json: async () => ({
            candidates: [
              { content: { parts: [{ text: JSON.stringify(answer) }] } },
            ],
          }),
        };
      });
    }

    function rows() {
      return db
        .prepare(
          "SELECT periodIndex, llmStatus, failureReason, review FROM period_reviews WHERE anonymousId = ? ORDER BY periodIndex",
        )
        .all(userId);
    }

    it("2구간 프롬프트에 직전 구간 비교와 날짜별 비중을 넣고, 비교로 시작하는 리뷰를 저장한다", async () => {
      seedTwoPeriods();
      global.fetch = geminiAnswering(
        "직전 구간보다 게임 비중이 50%p 늘었어요. 시청 시간의 50%가 게임이었어요.",
      );

      await run(db, "fake-key");

      const prompts = global.fetch.mock.calls.map(
        ([, opts]) => JSON.parse(opts.body).contents[0].parts[0].text,
      );
      expect(prompts).toHaveLength(2); // 3구간은 기록이 없어 Gemini를 부르지 않는다
      expect(prompts[0]).not.toContain("[이전 구간과 비교]");
      expect(prompts[1]).toContain(
        "- 직전 구간(1구간) 시청 시간 비중: 음악 100% (영상 8개)",
      );
      expect(prompts[1]).toContain(
        "- 직전 구간 대비 변화(크기 순): 게임 +50%p (0% → 50%), 음악 -50%p (100% → 50%)",
      );
      expect(prompts[1]).toContain("- 새로 본 분야: 게임");
      // 이전 구간이 1구간 하나뿐이라 "이전 구간 전체" 목록은 넣지 않는다(직전 구간 줄과 중복)
      expect(prompts[1]).not.toContain("- 이전 구간 전체:");
      expect(prompts[1]).toContain("[이번 구간 날짜별 시청 시간 비중]\n- 6/5(");
      // 같은 분야 안의 소재 변화를 짚을 수 있게 직전 구간 제목도 넘긴다
      expect(prompts[1]).toContain(
        "- 직전 구간 분야별 영상 제목 (시청 시간이 많은 분야부터, 최근 본 순서, 괄호는 본 횟수):\n  [음악] 영상 8개",
      );

      expect(rows()).toEqual([
        {
          periodIndex: 1,
          llmStatus: "success",
          failureReason: null,
          review: "관찰 문장",
        },
        {
          periodIndex: 2,
          llmStatus: "success",
          failureReason: null,
          review:
            "직전 구간보다 게임 비중이 50%p 늘었어요. 시청 시간의 50%가 게임이었어요.",
        },
        {
          periodIndex: 3,
          llmStatus: "fallback",
          failureReason: null,
          review:
            "이 기간엔 분석할 시청 기록이 없어요. 다음 기간을 기대해 주세요!",
        },
      ]);
    });

    it("입력에 없는 숫자를 쓰면 number_mismatch 폴백이 되고, 대체 문구 첫 문장은 코드 비교 문장이다", async () => {
      seedTwoPeriods();
      global.fetch = geminiAnswering(
        "직전 구간보다 게임 비중이 37%p 늘었어요.",
      );
      vi.spyOn(console, "error").mockImplementation(() => {});

      const summary = await run(db, "fake-key");

      expect(rows()[1]).toEqual({
        periodIndex: 2,
        llmStatus: "fallback",
        failureReason: "number_mismatch",
        review:
          "직전 구간보다 게임 비중이 50%p 늘었어요. 이 기간에는 영상 8개를 보셨고, 전체 시청 시간 중 음악과 게임이 각각 50%로 가장 많았어요.",
      });
      // Gemini를 불렀다가 실패한 것으로 센다(1구간 성공이 있어 전량 실패는 아님)
      expect(summary.llmFailures).toBe(1);
      expect(summary.created).toBe(1);
    });
  });

  // 오늘 리뷰와 같은 기준 — 유효 영상 수, 시청 시간 비중, 분야별 제목 전부(잠깐 본 영상 제외)
  it("프롬프트에 유효 영상 수·시청 시간 비중·분야별 제목 전부를 넣고, 잠깐 본 영상 제목은 넣지 않는다", async () => {
    const userId = "prompt-input-user";
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run(userId, INSTALL_DATE);
    db.prepare(
      "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
    ).run(userId, JSON.stringify({ 음악: 1 }), 13, "2026-06-02T11:00:00+09:00");
    const insertMeta = db.prepare(
      "INSERT INTO video_metadata (videoId, categoryId, durationSeconds) VALUES (?, ?, 600)",
    );
    insertMeta.run("p-music", "10");
    insertMeta.run("p-game", "20");
    const insertEvent = db.prepare(
      "INSERT INTO video_events (anonymousId, videoId, title, watchedAt, watchedSeconds) VALUES (?, ?, ?, ?, ?)",
    );
    // 이전 프롬프트는 앞 10개만 넘겼다 — 12개를 넣어 전부 넘어가는지 본다
    for (let i = 0; i < 12; i++)
      insertEvent.run(
        userId,
        "p-music",
        `음악 ${i}`,
        `2026-06-01T10:${String(i).padStart(2, "0")}:00+09:00`,
        300,
      );
    insertEvent.run(
      userId,
      "p-game",
      "잘못 누른 게임",
      "2026-06-02T10:00:00+09:00",
      3,
    );

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '{"topic":"음악","feedback":"문장"}' }],
            },
          },
        ],
      }),
    });

    await run(db, "fake-key");

    const prompt = JSON.parse(global.fetch.mock.calls[0][1].body).contents[0]
      .parts[0].text;
    expect(prompt).toContain("이 기간(4일)에 시청한 영상 수: 12개");
    expect(prompt).toContain("분야별 시청 시간 비중:\n  · 음악: 100%");
    expect(prompt).toContain("  [음악] 영상 12개");
    for (let i = 0; i < 12; i++) expect(prompt).toContain(`  · 음악 ${i}\n`);
    expect(prompt).not.toContain("잘못 누른 게임");
    // 4일 구간 기준(8개) 이상이라 "영상이 적다" 지침이 없다
    expect(prompt).not.toContain("시청한 영상이 적어");

    const row = db
      .prepare(
        "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
      )
      .get(userId);
    // 저장값은 그대로 — 영상 기록 수는 잠깐 본 영상 포함
    expect(row.videoCount).toBe(13);
    expect(row.validVideoCount).toBe(12);
  });

  it("기간 제목 상한은 하루 상한 × 구간 일수라, 하루 상한(100)을 넘는 150개도 전부 넘긴다", async () => {
    const userId = "many-titles-user";
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run(userId, INSTALL_DATE);
    db.prepare(
      "INSERT INTO video_metadata (videoId, categoryId, durationSeconds) VALUES (?, ?, 600)",
    ).run("many-music", "10");
    const insertEvent = db.prepare(
      "INSERT INTO video_events (anonymousId, videoId, title, watchedAt, watchedSeconds) VALUES (?, 'many-music', ?, '2026-06-01T10:00:00+09:00', 300)",
    );
    for (let i = 0; i < 150; i++) insertEvent.run(userId, `쇼츠 ${i}`);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '{"topic":"음악","feedback":"문장"}' }],
            },
          },
        ],
      }),
    });

    await run(db, "fake-key");

    const prompt = JSON.parse(global.fetch.mock.calls[0][1].body).contents[0]
      .parts[0].text;
    expect(prompt.match(/ {2}· 쇼츠 \d+/g)).toHaveLength(150);
    expect(prompt).not.toContain("이 외");
  });

  it("프롬프트 영상 수는 시청 시간이 확인된 영상만 세고, 저장하는 validVideoCount는 분석 기준(시간 모름 포함) 그대로다", async () => {
    const userId = "pending-period-user";
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run(userId, INSTALL_DATE);
    db.prepare(
      "INSERT INTO video_metadata (videoId, categoryId, durationSeconds) VALUES (?, ?, 600)",
    ).run("pp-music", "10");
    const insertEvent = db.prepare(
      "INSERT INTO video_events (anonymousId, videoId, title, watchedAt, watchedSeconds) VALUES (?, 'pp-music', ?, '2026-06-01T10:00:00+09:00', ?)",
    );
    for (let i = 0; i < 8; i++) insertEvent.run(userId, `음악 ${i}`, 300);
    insertEvent.run(userId, "시간 모르는 영상", null);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '{"topic":"음악","feedback":"문장"}' }],
            },
          },
        ],
      }),
    });

    await run(db, "fake-key");

    const prompt = JSON.parse(global.fetch.mock.calls[0][1].body).contents[0]
      .parts[0].text;
    expect(prompt).toContain("이 기간(4일)에 시청한 영상 수: 8개");
    expect(prompt).not.toContain("시간 모르는 영상");
    const row = db
      .prepare(
        "SELECT validVideoCount FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
      )
      .get(userId);
    expect(row.validVideoCount).toBe(9);
  });

  it("Gemini가 실패하면 대체 문구도 유효 영상 수와 시청 시간 비중으로 적는다", async () => {
    const userId = "fallback-input-user";
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run(userId, INSTALL_DATE);
    db.prepare(
      "INSERT INTO video_metadata (videoId, categoryId, durationSeconds) VALUES (?, ?, 600)",
    ).run("f-music", "10");
    const insertEvent = db.prepare(
      "INSERT INTO video_events (anonymousId, videoId, title, watchedAt, watchedSeconds) VALUES (?, 'f-music', '음악', ?, ?)",
    );
    insertEvent.run(userId, "2026-06-01T10:00:00+09:00", 300);
    insertEvent.run(userId, "2026-06-01T11:00:00+09:00", 2); // 잠깐 본 영상
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server error",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await run(db, "fake-key");

    const row = db
      .prepare(
        "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
      )
      .get(userId);
    expect(row.llmStatus).toBe("fallback");
    expect(row.review).toBe(
      "이 기간에는 영상 1개를 보셨고, 시청 시간은 모두 음악이었어요. 영상이 적어 이 기간의 패턴을 정확히 말하기는 어려워요.",
    );
  });

  // 오늘 리뷰와 같은 기준. 근거 분포 없이 LLM을 부르지 않는다
  it("기간 유효 영상이 모두 카테고리를 못 가져왔으면 Gemini 없이 '분석하지 못했다' 폴백을 저장한다", async () => {
    const userId = "no-category-user";
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run(userId, INSTALL_DATE);
    db.prepare(
      "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
    ).run(userId, JSON.stringify({}), 2, "2026-06-01T11:00:00+09:00");
    // 메타데이터 행 없이 영상 기록만. 카테고리를 못 가져온 상태
    const insertEvent = db.prepare(
      "INSERT INTO video_events (anonymousId, videoId, title, watchedAt, watchedSeconds) VALUES (?, ?, ?, ?, 300)",
    );
    insertEvent.run(userId, "unknown-1", "영상 1", "2026-06-01T10:00:00+09:00");
    insertEvent.run(userId, "unknown-2", "영상 2", "2026-06-01T10:10:00+09:00");

    global.fetch = vi.fn();
    const recordMetric = vi.fn();
    const summary = await run(db, "fake-key", { recordMetric });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(recordMetric).not.toHaveBeenCalled();
    const row = db
      .prepare(
        "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
      )
      .get(userId);
    expect(row.llmStatus).toBe("fallback");
    expect(row.failureReason).toBeNull();
    expect(row.review).toContain("분석하지 못했어요");
    expect(row.validVideoCount).toBe(2);
    // 실패가 아닌 fallback으로 집계돼 크론이 실패로 끝나지 않는다
    expect(summary.llmFailures).toBe(0);
  });

  it("기간 시간 가중 분포도 영상 길이로 상한을 둔다", async () => {
    const userId = "cap-user";
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run(userId, INSTALL_DATE);
    db.prepare(
      "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
    ).run(
      userId,
      JSON.stringify({ 음악: 0.5, 게임: 0.5 }),
      2,
      "2026-06-01T11:00:00+09:00",
    );
    const insertMeta = db.prepare(
      "INSERT INTO video_metadata (videoId, categoryId, durationSeconds) VALUES (?, ?, ?)",
    );
    insertMeta.run("c-music", "10", 100);
    insertMeta.run("c-game", "20", 600);
    const insertEvent = db.prepare(
      "INSERT INTO video_events (anonymousId, videoId, title, watchedAt, watchedSeconds) VALUES (?, ?, ?, ?, ?)",
    );
    // 길이 100초 음악을 250초 본 것으로 기록 → 100초로 셈. 게임은 100초
    insertEvent.run(
      userId,
      "c-music",
      "음악",
      "2026-06-01T10:00:00+09:00",
      250,
    );
    insertEvent.run(userId, "c-game", "게임", "2026-06-01T10:10:00+09:00", 100);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '{"topic":"음악","feedback":"문장"}' }],
            },
          },
        ],
      }),
    });

    await run(db, "fake-key");

    const row = db
      .prepare(
        "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
      )
      .get(userId);
    expect(JSON.parse(row.weightedCategoryDistribution)).toEqual({
      음악: 0.5,
      게임: 0.5,
    });
    expect(row.weightedEntropy).toBe(1);
  });

  it("밀린 여러 기간을 오래된 순서로 순차 처리한다 (동시 호출 없음)", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run("active-user", INSTALL_DATE);

    // DAYS_PER_PERIOD=4 기준 각 기간(1구간 6/1-6/4, 2구간 6/5-6/8, 3구간 6/9-6/12)에
    // 하나씩 세션을 심어 3개 기간 모두 데이터가 있는 상태로 만든다.
    for (const [day, count] of [
      ["2026-06-01T10:00:00+09:00", 5],
      ["2026-06-05T10:00:00+09:00", 5],
      ["2026-06-09T10:00:00+09:00", 5],
    ]) {
      db.prepare(
        "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
      ).run("active-user", JSON.stringify({ 음악: 1 }), count, day);
      insertWatchedVideo(db, "active-user", day);
    }

    let inFlight = 0;
    let maxConcurrent = 0;
    const order = [];
    global.fetch = vi.fn(async (_url, opts) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      const body = JSON.parse(opts.body);
      order.push(body.contents[0].parts[0].text.length); // 호출 순서 기록용
      await Promise.resolve();
      inFlight--;
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
    });

    const summary = await run(db, "fake-key");

    expect(maxConcurrent).toBe(1); // 병렬 호출 없음 — 항상 하나씩만 진행 중
    expect(global.fetch).toHaveBeenCalledTimes(3);

    const rows = db
      .prepare(
        "SELECT * FROM period_reviews WHERE anonymousId = ? ORDER BY periodIndex",
      )
      .all("active-user");
    expect(rows.map((r) => r.periodIndex)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.source === "llm")).toBe(true);

    expect(summary).toEqual({
      created: 3,
      fallback: 0,
      llmFailures: 0,
      skipped: 0,
    });
    expect(shouldFail(summary)).toBe(false);
  });

  it("period_reviews에 이미 있는 기간은 건너뛰고, UNIQUE 제약으로 중복 행이 생기지 않는다", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run("repeat-user", INSTALL_DATE);
    db.prepare(
      "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
    ).run(
      "repeat-user",
      JSON.stringify({ 음악: 1 }),
      5,
      "2026-06-01T10:00:00+09:00",
    );

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: '{"topic":"음악","feedback":"문장"}' }],
            },
          },
        ],
      }),
    });

    await run(db, "fake-key"); // 1회차 실행
    await run(db, "fake-key"); // 재실행 — 이미 있는 기간은 건너뛰어야 함

    const rows = db
      .prepare("SELECT * FROM period_reviews WHERE anonymousId = ?")
      .all("repeat-user");
    // 1~3일차 각각 정확히 1건씩만 존재 (재실행으로 중복 생성되지 않음)
    expect(rows.length).toBe(3);
    const indexes = rows.map((r) => r.periodIndex).sort((a, b) => a - b);
    expect(indexes).toEqual([1, 2, 3]);
  });

  it("이력 기록이 실패하면 최신본도 저장하지 않는다(한 트랜잭션)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run("tx-user", INSTALL_DATE);
    // 이력 INSERT만 실패하게 만든다
    db.exec(`
      CREATE TRIGGER fail_version_insert BEFORE INSERT ON period_review_versions
      BEGIN SELECT RAISE(ABORT, 'version insert failed'); END;
    `);

    const summary = await run(db, "fake-key");

    const latest = db
      .prepare("SELECT COUNT(*) AS c FROM period_reviews WHERE anonymousId = ?")
      .get("tx-user").c;
    expect(latest).toBe(0);
    // 실패한 기간은 처리 실패로 집계돼 cron이 실패로 끝난다
    expect(summary.skipped).toBe(3);
  });

  it("Gemini 호출 실패 시 fallback으로 대체 저장하고 failureReason을 기록한다", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run("fail-user", INSTALL_DATE);
    db.prepare(
      "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
    ).run(
      "fail-user",
      JSON.stringify({ 음악: 1 }),
      5,
      "2026-06-01T10:00:00+09:00",
    );
    insertWatchedVideo(db, "fail-user", "2026-06-01T10:00:00+09:00");

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server error",
    });

    const summary = await run(db, "fake-key");

    const row = db
      .prepare(
        "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
      )
      .get("fail-user");
    expect(row.source).toBe("fallback");
    expect(row.llmStatus).toBe("fallback");
    expect(row.failureReason).toBe("http_error");

    // period 1은 세션이 있어 Gemini를 실제로 호출했다가 실패(llmFailures), 2·3은 세션이
    // 없어 애초에 호출을 생략한 정상 fallback. 이 참여자 하나뿐이라 created가 0이라,
    // "시도한 건 있는데 하나도 못 살렸다"는 패턴으로 실패 판정된다(P01·0 감사에서 찾은
    // 사각지대: 예전엔 이 경우도 exit code 0이었다).
    expect(summary).toEqual({
      created: 0,
      fallback: 2,
      llmFailures: 1,
      skipped: 0,
    });
    expect(shouldFail(summary)).toBe(true);
  });

  it("Gemini를 실제로 부른 기간만 메트릭으로 기록하고, 참여자 정보는 넘기지 않는다", async () => {
    db.prepare(
      "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
    ).run("metric-user", INSTALL_DATE);
    db.prepare(
      "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
    ).run(
      "metric-user",
      JSON.stringify({ 음악: 1 }),
      5,
      "2026-06-01T10:00:00+09:00",
    );
    insertWatchedVideo(db, "metric-user", "2026-06-01T10:00:00+09:00");
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "quota",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const recordMetric = vi.fn();

    await run(db, "fake-key", { recordMetric });

    // 1구간만 세션이 있어 호출했고, 2·3구간은 세션이 없어 호출을 생략했다
    expect(recordMetric).toHaveBeenCalledTimes(1);
    expect(recordMetric.mock.calls[0][0]).toEqual({
      kind: "period",
      llmStatus: "fallback",
      failureReason: "http_error",
      geminiMs: expect.any(Number),
      calledGemini: true,
    });
  });

  describe("fallback 재시도 정책 (periodEnd 기준 3일 이내)", () => {
    // 1구간(offset 0-3, periodEnd=2026-06-04) 하나만 완료되도록 고정 — 나머지 기간은
    // 이 테스트들과 무관하니 아직 진행 중인 채로 둔다.
    const P1_INSTALL_DATE = "2026-06-01T00:00:00+09:00";
    const P1_SESSION_AT = "2026-06-01T10:00:00+09:00";

    it("성공(llmStatus=success)한 기간은 재실행해도 다시 시도하지 않는다", async () => {
      vi.setSystemTime(new Date("2026-06-05T10:00:00+09:00"));
      db.prepare(
        "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
      ).run("locked-success-user", P1_INSTALL_DATE);
      db.prepare(
        "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
      ).run(
        "locked-success-user",
        JSON.stringify({ 음악: 1 }),
        5,
        P1_SESSION_AT,
      );
      insertWatchedVideo(db, "locked-success-user", P1_SESSION_AT);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: '{"topic":"음악","feedback":"문장"}' }],
              },
            },
          ],
        }),
      });

      await run(db, "fake-key");
      expect(global.fetch).toHaveBeenCalledTimes(1);

      await run(db, "fake-key"); // 재실행 — success는 다시 건드리지 않아야 함
      expect(global.fetch).toHaveBeenCalledTimes(1);

      const row = db
        .prepare(
          "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
        )
        .get("locked-success-user");
      expect(row.llmStatus).toBe("success");
      // 다시 생성하지 않았으니 이력도 1건이다
      const versions = db
        .prepare(
          "SELECT COUNT(*) AS c FROM period_review_versions WHERE anonymousId = ? AND periodIndex = 1",
        )
        .get("locked-success-user").c;
      expect(versions).toBe(1);
    });

    it("fallback 기간은 periodEnd로부터 3일 이내면 재시도해 성공으로 갱신될 수 있다", async () => {
      vi.setSystemTime(new Date("2026-06-05T10:00:00+09:00"));
      db.prepare(
        "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
      ).run("retry-user", P1_INSTALL_DATE);
      db.prepare(
        "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
      ).run("retry-user", JSON.stringify({ 음악: 1 }), 5, P1_SESSION_AT);
      insertWatchedVideo(db, "retry-user", P1_SESSION_AT);

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "server error",
      });
      await run(db, "fake-key"); // 1회차 — 실패 → fallback 저장 (periodEnd=6/4, 재시도 기한 6/7)

      let row = db
        .prepare(
          "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
        )
        .get("retry-user");
      expect(row.llmStatus).toBe("fallback");

      // 하루 뒤(재시도 기한 안) — 이번엔 성공하도록 변경 후 재실행
      vi.setSystemTime(new Date("2026-06-06T10:00:00+09:00"));
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: '{"topic":"음악","feedback":"복구된 리뷰"}' }],
              },
            },
          ],
        }),
      });
      await run(db, "fake-key");

      row = db
        .prepare(
          "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
        )
        .get("retry-user");
      expect(row.llmStatus).toBe("success");
      expect(row.review).toBe("복구된 리뷰");
      // OR REPLACE로 갱신돼도 같은 기간에 행이 여러 개 생기면 안 된다.
      const rows = db
        .prepare(
          "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
        )
        .all("retry-user");
      expect(rows.length).toBe(1);

      // 참여자가 먼저 봤을 수 있는 fallback 문장도 이력에는 남아 있어야 한다
      const versions = db
        .prepare(
          "SELECT llmStatus, review FROM period_review_versions WHERE anonymousId = ? AND periodIndex = 1 ORDER BY generatedAt, id",
        )
        .all("retry-user");
      expect(versions.map((v) => v.llmStatus)).toEqual(["fallback", "success"]);
      expect(versions[1].review).toBe("복구된 리뷰");
      expect(versions[0].review).not.toBe("복구된 리뷰");
    });

    it("fallback 기간이 재시도 기한(periodEnd+3일)을 지나면 더 이상 재시도하지 않는다", async () => {
      vi.setSystemTime(new Date("2026-06-05T10:00:00+09:00"));
      db.prepare(
        "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
      ).run("expired-user", P1_INSTALL_DATE);
      db.prepare(
        "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
      ).run("expired-user", JSON.stringify({ 음악: 1 }), 5, P1_SESSION_AT);
      insertWatchedVideo(db, "expired-user", P1_SESSION_AT);

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "server error",
      });
      await run(db, "fake-key"); // periodEnd=6/4, 재시도 기한 6/7

      // 기한(6/7)을 지난 시점 — 이제 성공하도록 바꿔도 더 이상 호출되면 안 된다.
      vi.setSystemTime(new Date("2026-06-08T10:00:00+09:00"));
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  { text: '{"topic":"음악","feedback":"너무 늦은 성공"}' },
                ],
              },
            },
          ],
        }),
      });
      await run(db, "fake-key");

      expect(global.fetch).not.toHaveBeenCalled();
      const row = db
        .prepare(
          "SELECT * FROM period_reviews WHERE anonymousId = ? AND periodIndex = 1",
        )
        .get("expired-user");
      expect(row.llmStatus).toBe("fallback");
    });
  });
});

describe("shouldFail — run() 집계로 실패 여부를 판정하는 순수 함수", () => {
  it("전부 정상(created만 있음)이면 실패가 아니다", () => {
    expect(
      shouldFail({ created: 3, fallback: 0, llmFailures: 0, skipped: 0 }),
    ).toBe(false);
  });

  it("세션이 없어 생긴 fallback만 있으면(llmFailures=0) 실패가 아니다", () => {
    expect(
      shouldFail({ created: 0, fallback: 5, llmFailures: 0, skipped: 0 }),
    ).toBe(false);
  });

  it("llmFailures가 있어도 created가 1 이상이면(부분 실패) 아직 실패로 보지 않는다", () => {
    expect(
      shouldFail({ created: 2, fallback: 0, llmFailures: 1, skipped: 0 }),
    ).toBe(false);
  });

  it("llmFailures가 있는데 created가 0이면(전량 실패) 실패다", () => {
    expect(
      shouldFail({ created: 0, fallback: 0, llmFailures: 1, skipped: 0 }),
    ).toBe(true);
  });

  it("skipped가 하나라도 있으면 다른 값과 무관하게 실패다", () => {
    expect(
      shouldFail({ created: 10, fallback: 0, llmFailures: 0, skipped: 1 }),
    ).toBe(true);
  });
});
