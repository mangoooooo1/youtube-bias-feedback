import { describe, it, expect, afterEach, afterAll } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import crypto from "crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// requireParticipant.js가 최상단에서 실제 server/db.js를 require하고, db.js는 모듈 로드
// 시점에 즉시 암호화 DB 커넥션을 여는 구조라(server/test/routes/*.wiring.test.js와 동일한
// 이유), import보다 먼저 DB_ENCRYPTION_KEY/DB_PATH를 임시 파일로 지정해야 한다.
const require = createRequire(import.meta.url);
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `viewlens-require-participant-${process.pid}.db`,
);
fs.rmSync(TEST_DB_PATH, { force: true });
process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
process.env.DB_PATH = TEST_DB_PATH;

const { checkParticipant, issueParticipantToken } = require(
  "../../middleware/requireParticipant.js",
);
const { db: realDb } = require("../../db.js");

afterAll(() => {
  realDb.close();
  fs.rmSync(TEST_DB_PATH, { force: true });
});

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL UNIQUE
    );
  `);
  return db;
}

function computeToken(anonymousId, secret) {
  return crypto.createHmac("sha256", secret).update(anonymousId).digest("hex");
}

describe("checkParticipant", () => {
  it("anonymousId가 없으면 missing_anonymous_id", () => {
    const db = createTestDb();
    expect(checkParticipant(db, "secret", "", null)).toBe(
      "missing_anonymous_id",
    );
    expect(checkParticipant(db, "secret", "   ", null)).toBe(
      "missing_anonymous_id",
    );
  });

  it("등록되지 않은 anonymousId는 secret 설정 여부와 무관하게 not_found", () => {
    const db = createTestDb();
    expect(checkParticipant(db, null, "ghost", null)).toBe("not_found");
    expect(checkParticipant(db, "secret", "ghost", "anything")).toBe(
      "not_found",
    );
  });

  it("secret 미설정이면 등록된 참여자는 토큰 없이도 ok(기존 동작과 100% 동일)", () => {
    const db = createTestDb();
    db.prepare("INSERT INTO participants (anonymousId) VALUES (?)").run(
      "user-1",
    );
    expect(checkParticipant(db, null, "user-1", null)).toBe("ok");
    expect(checkParticipant(db, null, "user-1", "garbage-token")).toBe("ok");
  });

  it("secret 설정 시 올바른 토큰이면 ok", () => {
    const db = createTestDb();
    db.prepare("INSERT INTO participants (anonymousId) VALUES (?)").run(
      "user-1",
    );
    const token = computeToken("user-1", "top-secret");
    expect(checkParticipant(db, "top-secret", "user-1", token)).toBe("ok");
  });

  it("secret 설정 시 토큰이 없으면 invalid_token — '토큰 없으면 통과'는 없다", () => {
    const db = createTestDb();
    db.prepare("INSERT INTO participants (anonymousId) VALUES (?)").run(
      "user-1",
    );
    expect(checkParticipant(db, "top-secret", "user-1", null)).toBe(
      "invalid_token",
    );
    expect(checkParticipant(db, "top-secret", "user-1", "")).toBe(
      "invalid_token",
    );
  });

  it("secret 설정 시 틀린 토큰(다른 참여자 것 포함)이면 invalid_token", () => {
    const db = createTestDb();
    db.prepare(
      "INSERT INTO participants (anonymousId) VALUES (?), (?)",
    ).run("user-1", "user-2");
    const otherUsersToken = computeToken("user-2", "top-secret");

    expect(
      checkParticipant(db, "top-secret", "user-1", otherUsersToken),
    ).toBe("invalid_token");
    expect(
      checkParticipant(db, "top-secret", "user-1", "not-even-hex!!"),
    ).toBe("invalid_token");
  });

  it("secret 설정 시 다른 secret으로 계산된 토큰(비밀키 로테이션 등)은 invalid_token", () => {
    const db = createTestDb();
    db.prepare("INSERT INTO participants (anonymousId) VALUES (?)").run(
      "user-1",
    );
    const staleToken = computeToken("user-1", "old-secret");
    expect(checkParticipant(db, "new-secret", "user-1", staleToken)).toBe(
      "invalid_token",
    );
  });
});

describe("issueParticipantToken", () => {
  const originalSecret = process.env.PARTICIPANT_TOKEN_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.PARTICIPANT_TOKEN_SECRET;
    } else {
      process.env.PARTICIPANT_TOKEN_SECRET = originalSecret;
    }
  });

  it("PARTICIPANT_TOKEN_SECRET 미설정이면 null(발급 안 함)", () => {
    delete process.env.PARTICIPANT_TOKEN_SECRET;
    expect(issueParticipantToken("user-1")).toBeNull();
  });

  it("설정돼 있으면 checkParticipant가 인정하는 유효한 토큰을 발급한다", () => {
    process.env.PARTICIPANT_TOKEN_SECRET = "top-secret";
    const db = createTestDb();
    db.prepare("INSERT INTO participants (anonymousId) VALUES (?)").run(
      "user-1",
    );

    const token = issueParticipantToken("user-1");
    expect(checkParticipant(db, "top-secret", "user-1", token)).toBe("ok");
  });

  it("같은 anonymousId·같은 secret이면 매번 같은 토큰(결정적, 상태 저장 불필요)", () => {
    process.env.PARTICIPANT_TOKEN_SECRET = "top-secret";
    expect(issueParticipantToken("user-1")).toBe(
      issueParticipantToken("user-1"),
    );
  });

  it("anonymousId가 다르면 토큰도 다르다", () => {
    process.env.PARTICIPANT_TOKEN_SECRET = "top-secret";
    expect(issueParticipantToken("user-1")).not.toBe(
      issueParticipantToken("user-2"),
    );
  });
});
