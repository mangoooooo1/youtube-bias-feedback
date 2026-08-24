import { describe, it, expect, afterEach, beforeEach } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  TEST_CODES,
  isPreviouslyRegistered,
  findEarliestParticipant,
} from "../../routes/participant-recovery.js";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL UNIQUE,
      participantCode TEXT,
      group_code TEXT NOT NULL,
      installDate TEXT NOT NULL
    );
  `);
  return db;
}

function insertParticipant(
  db,
  { anonymousId, participantCode, groupCode, installDate },
) {
  db.prepare(
    "INSERT INTO participants (anonymousId, participantCode, group_code, installDate) VALUES (?, ?, ?, ?)",
  ).run(anonymousId, participantCode, groupCode, installDate);
}

describe("isPreviouslyRegistered", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("처음 등록하는 코드는 false를 반환한다", () => {
    expect(isPreviouslyRegistered(db, "QWE-K7M2")).toBe(false);
  });

  it("이미 등록된 코드는 true를 반환한다", () => {
    insertParticipant(db, {
      anonymousId: "user-1",
      participantCode: "QWE-K7M2",
      groupCode: "EXP",
      installDate: "2026-06-01T00:00:00+09:00",
    });
    expect(isPreviouslyRegistered(db, "QWE-K7M2")).toBe(true);
  });

  it.each([...TEST_CODES])(
    "%s는 등록 이력과 무관하게 항상 false를 반환한다",
    (code) => {
      insertParticipant(db, {
        anonymousId: "researcher-1",
        participantCode: code,
        groupCode: code,
        installDate: "2026-06-01T00:00:00+09:00",
      });
      expect(isPreviouslyRegistered(db, code)).toBe(false);
    },
  );
});

describe("findEarliestParticipant", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("등록 이력이 없으면 null을 반환한다", () => {
    expect(findEarliestParticipant(db, "QWE-K7M2")).toBeNull();
  });

  it("빈 코드나 TEST 코드는 조회 없이 null을 반환한다", () => {
    expect(findEarliestParticipant(db, "")).toBeNull();
    expect(findEarliestParticipant(db, null)).toBeNull();
    expect(findEarliestParticipant(db, "TEST-EXP")).toBeNull();
    expect(findEarliestParticipant(db, "TEST-CON")).toBeNull();
  });

  it("등록된 참여자의 anonymousId/installDate/group_code를 반환한다", () => {
    insertParticipant(db, {
      anonymousId: "user-1",
      participantCode: "QWE-K7M2",
      groupCode: "EXP",
      installDate: "2026-06-01T00:00:00+09:00",
    });

    const row = findEarliestParticipant(db, "QWE-K7M2");

    expect(row).toEqual({
      anonymousId: "user-1",
      installDate: "2026-06-01T00:00:00+09:00",
      group_code: "EXP",
    });
  });

  it("같은 참여코드로 중복 등록된 경우 installDate가 가장 이른 행을 반환한다", () => {
    insertParticipant(db, {
      anonymousId: "user-later",
      participantCode: "QWE-K7M2",
      groupCode: "EXP",
      installDate: "2026-06-10T00:00:00+09:00",
    });
    insertParticipant(db, {
      anonymousId: "user-earliest",
      participantCode: "QWE-K7M2",
      groupCode: "EXP",
      installDate: "2026-06-01T00:00:00+09:00",
    });
    insertParticipant(db, {
      anonymousId: "user-middle",
      participantCode: "QWE-K7M2",
      groupCode: "EXP",
      installDate: "2026-06-05T00:00:00+09:00",
    });

    const row = findEarliestParticipant(db, "QWE-K7M2");

    expect(row.anonymousId).toBe("user-earliest");
  });

  it("다른 참여코드의 등록 이력은 섞이지 않는다", () => {
    insertParticipant(db, {
      anonymousId: "user-1",
      participantCode: "QWE-K7M2",
      groupCode: "EXP",
      installDate: "2026-06-01T00:00:00+09:00",
    });
    insertParticipant(db, {
      anonymousId: "user-2",
      participantCode: "ASD-9X3P",
      groupCode: "CON",
      installDate: "2026-06-01T00:00:00+09:00",
    });

    const row = findEarliestParticipant(db, "ASD-9X3P");

    expect(row.anonymousId).toBe("user-2");
  });
});
