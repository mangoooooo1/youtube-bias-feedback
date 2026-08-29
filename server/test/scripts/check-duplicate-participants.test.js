import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import crypto from "crypto";
import {
  run,
  fingerprint,
} from "../../scripts/check-duplicate-participants.js";

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

function sha10(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 10);
}

describe("fingerprint", () => {
  it("같은 입력에 대해 항상 같은 지문을 반환한다", () => {
    expect(fingerprint("QWE-K7M2")).toBe(fingerprint("QWE-K7M2"));
  });

  it("다른 입력에 대해 다른 지문을 반환한다", () => {
    expect(fingerprint("QWE-K7M2")).not.toBe(fingerprint("ASD-9X3P"));
  });

  it("SHA-256 해시의 앞 10자와 일치한다", () => {
    expect(fingerprint("QWE-K7M2")).toBe(sha10("QWE-K7M2"));
  });

  it.each([null, undefined, ""])(
    "빈 값(%s)은 (none)을 반환한다",
    (value) => {
      expect(fingerprint(value)).toBe("(none)");
    },
  );
});

describe("run", () => {
  let db;
  let logSpy;

  beforeEach(() => {
    db = createTestDb();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    db.close();
    logSpy.mockRestore();
  });

  function loggedOutput() {
    return logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
  }

  it("중복이 없으면 통과 메시지만 출력한다", () => {
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

    run(db);

    expect(loggedOutput()).toContain("중복 등록 없음");
  });

  it("participantCode가 NULL인 행은 서로 다른 참여자여도 중복으로 잡히지 않는다", () => {
    insertParticipant(db, {
      anonymousId: "user-1",
      participantCode: null,
      groupCode: "EXP",
      installDate: "2026-06-01T00:00:00+09:00",
    });
    insertParticipant(db, {
      anonymousId: "user-2",
      participantCode: null,
      groupCode: "CON",
      installDate: "2026-06-02T00:00:00+09:00",
    });

    run(db);

    expect(loggedOutput()).toContain("중복 등록 없음");
  });

  it("같은 participantCode로 여러 번 등록된 경우 건수와 지문을 출력한다", () => {
    insertParticipant(db, {
      anonymousId: "user-earliest",
      participantCode: "QWE-K7M2",
      groupCode: "EXP",
      installDate: "2026-06-01T00:00:00+09:00",
    });
    insertParticipant(db, {
      anonymousId: "user-later",
      participantCode: "QWE-K7M2",
      groupCode: "EXP",
      installDate: "2026-06-10T00:00:00+09:00",
    });

    run(db);

    const output = loggedOutput();
    expect(output).toContain("중복 참여코드 1건 발견");
    expect(output).toContain(`participantCode(지문)=${sha10("QWE-K7M2")}`);
    expect(output).toContain("(2건)");
  });

  it("출력에 원본 participantCode/anonymousId가 그대로 노출되지 않는다", () => {
    insertParticipant(db, {
      anonymousId: "sensitive-anon-id-1",
      participantCode: "SECRET-CODE-1",
      groupCode: "EXP",
      installDate: "2026-06-01T00:00:00+09:00",
    });
    insertParticipant(db, {
      anonymousId: "sensitive-anon-id-2",
      participantCode: "SECRET-CODE-1",
      groupCode: "EXP",
      installDate: "2026-06-05T00:00:00+09:00",
    });

    run(db);

    const output = loggedOutput();
    // 탐지 자체가 안 됐거나 조용히 실패해 원본이 우연히 안 찍힌 경우를 걸러내기 위해,
    // 지문/건수가 실제로 출력됐는지부터 확인한 뒤에 원본 미노출을 검증한다.
    expect(output).toContain("중복 참여코드 1건 발견");
    expect(output).toContain(`participantCode(지문)=${sha10("SECRET-CODE-1")}`);
    expect(output).toContain(sha10("sensitive-anon-id-1"));
    expect(output).toContain(sha10("sensitive-anon-id-2"));

    expect(output).not.toContain("SECRET-CODE-1");
    expect(output).not.toContain("sensitive-anon-id-1");
    expect(output).not.toContain("sensitive-anon-id-2");
  });

  it("installDate는 마스킹하지 않고 그대로 출력한다", () => {
    insertParticipant(db, {
      anonymousId: "user-earliest",
      participantCode: "QWE-K7M2",
      groupCode: "EXP",
      installDate: "2026-06-01T00:00:00+09:00",
    });
    insertParticipant(db, {
      anonymousId: "user-later",
      participantCode: "QWE-K7M2",
      groupCode: "EXP",
      installDate: "2026-06-10T00:00:00+09:00",
    });

    run(db);

    const output = loggedOutput();
    expect(output).toContain("2026-06-01T00:00:00+09:00");
    expect(output).toContain("2026-06-10T00:00:00+09:00");
  });

  it("서로 다른 participantCode의 중복은 각각 별도로 집계된다", () => {
    insertParticipant(db, {
      anonymousId: "user-1",
      participantCode: "AAA-1111",
      groupCode: "EXP",
      installDate: "2026-06-01T00:00:00+09:00",
    });
    insertParticipant(db, {
      anonymousId: "user-2",
      participantCode: "AAA-1111",
      groupCode: "EXP",
      installDate: "2026-06-02T00:00:00+09:00",
    });
    insertParticipant(db, {
      anonymousId: "user-3",
      participantCode: "BBB-2222",
      groupCode: "CON",
      installDate: "2026-06-03T00:00:00+09:00",
    });
    insertParticipant(db, {
      anonymousId: "user-4",
      participantCode: "BBB-2222",
      groupCode: "CON",
      installDate: "2026-06-04T00:00:00+09:00",
    });

    run(db);

    const output = loggedOutput();
    expect(output).toContain("중복 참여코드 2건 발견");
    expect(output).toContain(`participantCode(지문)=${sha10("AAA-1111")}`);
    expect(output).toContain(`participantCode(지문)=${sha10("BBB-2222")}`);
  });
});
