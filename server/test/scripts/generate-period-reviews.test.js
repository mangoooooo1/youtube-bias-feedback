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
  `);
  return db;
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
    });

    it("fallback 기간은 periodEnd로부터 3일 이내면 재시도해 성공으로 갱신될 수 있다", async () => {
      vi.setSystemTime(new Date("2026-06-05T10:00:00+09:00"));
      db.prepare(
        "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
      ).run("retry-user", P1_INSTALL_DATE);
      db.prepare(
        "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
      ).run("retry-user", JSON.stringify({ 음악: 1 }), 5, P1_SESSION_AT);

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
    });

    it("fallback 기간이 재시도 기한(periodEnd+3일)을 지나면 더 이상 재시도하지 않는다", async () => {
      vi.setSystemTime(new Date("2026-06-05T10:00:00+09:00"));
      db.prepare(
        "INSERT INTO participants (anonymousId, group_code, installDate) VALUES (?, 'EXP', ?)",
      ).run("expired-user", P1_INSTALL_DATE);
      db.prepare(
        "INSERT INTO sessions (anonymousId, categoryDistribution, videoCount, endTime) VALUES (?, ?, ?, ?)",
      ).run("expired-user", JSON.stringify({ 음악: 1 }), 5, P1_SESSION_AT);

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
