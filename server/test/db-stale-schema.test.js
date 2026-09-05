import { describe, it, expect, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";

// addColumn()을 소급 마이그레이션에 더 이상 쓰지 않기로 한 뒤,
// 예전 스키마 그대로인 DB 파일 위에 새 코드를 올리면 initializeDB()가
// "no such column" 같은 낯선 에러로 죽는다. 그 실패가 "배포 전 DB를
// 백업 후 삭제하라"는 실행 가능한 안내를 담고 있는지 별도 파일에서 검증한다.
// 별도 파일인 이유: db.js는 require 시점에 DB_PATH로 커넥션을 여는 모듈 싱글턴이라, 같은
// 프로세스에서 다른 DB_PATH로 다시 시도하려면 require 캐시가 없는 새 테스트 파일이 필요하다.
const require = createRequire(import.meta.url);
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `viewlens-db-stale-${process.pid}.db`,
);
fs.rmSync(TEST_DB_PATH, { force: true });

// db.js가 require되기 전에, "예전 스키마"를 흉내 낸 video_events 테이블을 미리 만들어둔다
// — eventId 컬럼이 없는 상태(addColumn으로만 추가되던 시절의 모습).
const seedDb = new Database(TEST_DB_PATH);
seedDb.pragma("cipher = 'sqlcipher'");
seedDb.key(Buffer.from("vitest-in-memory-only"));
seedDb.exec(`
  CREATE TABLE video_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    anonymousId TEXT    NOT NULL,
    videoId     TEXT    NOT NULL,
    title       TEXT,
    watchedAt   TEXT    NOT NULL,
    createdAt   TEXT    DEFAULT (datetime('now'))
  );
`);
seedDb.close();

process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
process.env.DB_PATH = TEST_DB_PATH;

const { db, initializeDB } = require("../db.js");

afterAll(() => {
  db.close();
  fs.rmSync(TEST_DB_PATH, { force: true });
});

describe("initializeDB — 예전 스키마 DB 위에서 실행되면(배포 전 백업·삭제를 잊은 경우)", () => {
  it("낯선 SQLite 에러 대신, 백업·삭제 절차를 안내하는 에러를 던진다", () => {
    expect(() => initializeDB()).toThrow(
      /DB 스키마 초기화 실패.*backup-db\.js.*백업한 뒤 삭제/s,
    );
  });
});
