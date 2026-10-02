import { describe, it, expect, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

//  실제 server/db.js를 그대로 로드해 addColumn의 멱등성·에러 전파를 검증한다.
// DB_PATH를 임시 파일로 오버라이드해 운영 DB를 열 위험 없이 실제 파일을 require한다.
const require = createRequire(import.meta.url);
const TEST_DB_PATH = path.join(os.tmpdir(), `viewlens-db-${process.pid}.db`);
fs.rmSync(TEST_DB_PATH, { force: true });
process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
process.env.DB_PATH = TEST_DB_PATH;

const { db, initializeDB, addColumn } = require("../db.js");

afterAll(() => {
  db.close();
  fs.rmSync(TEST_DB_PATH, { force: true });
});

describe("initializeDB — 반복 실행 안전성(서버 재기동 시나리오)", () => {
  it("여러 번 호출해도 예외 없이 통과한다", () => {
    expect(() => initializeDB()).not.toThrow();
    expect(() => initializeDB()).not.toThrow();
    expect(() => initializeDB()).not.toThrow();
  });
});

describe("addColumn", () => {
  it("컬럼이 없는 테이블에 새 컬럼을 추가한다", () => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS add_column_new_test (id INTEGER PRIMARY KEY)",
    );

    addColumn("add_column_new_test", "newCol", "TEXT");

    const columns = db.prepare("PRAGMA table_info(add_column_new_test)").all();
    expect(columns.some((c) => c.name === "newCol")).toBe(true);
  });

  it("이미 컬럼이 있는 테이블에 같은 컬럼을 다시 추가해도 예외 없이 조용히 통과한다(멱등성)", () => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS add_column_idempotent_test (id INTEGER PRIMARY KEY)",
    );
    addColumn("add_column_idempotent_test", "col", "TEXT");

    expect(() =>
      addColumn("add_column_idempotent_test", "col", "TEXT"),
    ).not.toThrow();
    // 반복 실행돼도 컬럼이 중복 생성되지 않는지 확인
    const columns = db
      .prepare("PRAGMA table_info(add_column_idempotent_test)")
      .all();
    expect(columns.filter((c) => c.name === "col")).toHaveLength(1);
  });

  it("컬럼 추가가 아닌 다른 이유(테이블 없음)로 실패하면 에러를 삼키지 않고 그대로 전파한다", () => {
    expect(() => addColumn("no_such_table_at_all", "col", "TEXT")).toThrow(
      /no such table/i,
    );
  });
});

describe("period_review_versions — 기간 리뷰 생성 이력(append-only)", () => {
  function upsertLatest(anonymousId, { review, llmStatus, generatedAt }) {
    db.prepare(
      `INSERT OR REPLACE INTO period_reviews
         (anonymousId, periodIndex, periodStart, periodEnd, isBaseline, review, llmStatus, generatedAt)
       VALUES (?, 1, '2026-06-01', '2026-06-04', 1, ?, ?, ?)`,
    ).run(anonymousId, review, llmStatus, generatedAt);
  }

  function versions(anonymousId) {
    return db
      .prepare(
        "SELECT review, llmStatus, generatedAt FROM period_review_versions WHERE anonymousId = ? ORDER BY generatedAt",
      )
      .all(anonymousId);
  }

  it("이력에 없는 최신본을 옮기고, 여러 번 기동해도 중복으로 넣지 않는다", () => {
    upsertLatest("backfill-user", {
      review: "기존 리뷰",
      llmStatus: "success",
      generatedAt: "2026-06-05T04:00:00.000Z",
    });

    initializeDB();
    initializeDB();

    expect(versions("backfill-user")).toEqual([
      {
        review: "기존 리뷰",
        llmStatus: "success",
        generatedAt: "2026-06-05T04:00:00.000Z",
      },
    ]);
  });

  it("최신본이 덮어써져도 이전 버전은 이력에 남는다", () => {
    upsertLatest("replaced-user", {
      review: "fallback 문장",
      llmStatus: "fallback",
      generatedAt: "2026-06-05T04:00:00.000Z",
    });
    initializeDB();
    upsertLatest("replaced-user", {
      review: "복구된 리뷰",
      llmStatus: "success",
      generatedAt: "2026-06-06T04:00:00.000Z",
    });
    initializeDB();

    const latest = db
      .prepare("SELECT COUNT(*) AS c FROM period_reviews WHERE anonymousId = ?")
      .get("replaced-user").c;
    expect(latest).toBe(1);
    expect(versions("replaced-user").map((v) => v.review)).toEqual([
      "fallback 문장",
      "복구된 리뷰",
    ]);
  });
});
