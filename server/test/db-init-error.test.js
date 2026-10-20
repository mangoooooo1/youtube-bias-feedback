import { describe, it, expect, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// initializeDB는 예전 스키마("no such column/table") 오류에만 백업·삭제 안내를 붙인다.
// 다른 오류에 그 안내가 붙으면 운영자가 멀쩡한 DB를 지우게 될 수 있어, 그대로 다시 던지는지 확인한다.
// 별도 파일인 이유: db.js는 require 시점에 연결을 여는 모듈 싱글턴이라 이 파일에서만 연결을 닫는다.
const require = createRequire(import.meta.url);
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `viewlens-db-init-error-${process.pid}.db`,
);
fs.rmSync(TEST_DB_PATH, { force: true });
process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
process.env.DB_PATH = TEST_DB_PATH;

const { db, initializeDB } = require("../db.js");

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
});

describe("initializeDB — 스키마 문제가 아닌 오류", () => {
  it("백업·삭제 안내를 붙이지 않고 원래 오류를 그대로 던진다", () => {
    db.close();

    expect(() => initializeDB()).toThrow("The database connection is not open");
    expect(() => initializeDB()).not.toThrow(/DB 스키마 초기화 실패/);
  });
});
