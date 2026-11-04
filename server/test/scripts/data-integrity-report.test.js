import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  run,
  collectRecords,
  findSharedSessionIds,
  findMissingSessions,
  findUndeterminedSessions,
  findNearDuplicates,
  findSessionCountMismatches,
  classify,
  CHECK_LABELS,
  SETTLE_MS,
  RUN_INTERVAL_MS,
  NEAR_DUPLICATE_MS,
  formatIntegritySummary,
  reportToHealthchecks,
  sendIntegrityGauges,
  CHECK_TAGS,
  ALLOWED_TAGS,
  GAUGES,
} from "../../scripts/data-integrity-report.js";
import { formatMetric } from "../../monitoring/dogstatsd.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-10T00:00:00.000Z");

function event(overrides) {
  return {
    anonymousId: "u1",
    eventId: "e1",
    sessionId: "s1",
    videoId: "v1",
    resumedFromEventId: null,
    watchedMs: NOW - 3 * DAY,
    ...overrides,
  };
}

function session(overrides) {
  return {
    anonymousId: "u1",
    sessionId: "s1",
    videoCount: 1,
    distributionMissing: 0,
    endMs: NOW - 3 * DAY,
    createdMs: NOW - 3 * DAY,
    ...overrides,
  };
}

describe("classify — 하루 지난 것만 세고, 직전 실행 이후 창을 신규로 센다", () => {
  const settledBefore = NOW - SETTLE_MS;

  it("기준 시각이 아직 하루가 안 됐으면 세지 않는다", () => {
    expect(classify([{ refMs: settledBefore }], NOW).total).toBe(0);
  });

  it("하루가 막 지났으면 전체와 신규에 모두 든다", () => {
    const result = classify([{ refMs: settledBefore - 1 }], NOW);
    expect(result).toMatchObject({ total: 1, newCount: 1 });
  });

  it("신규 창의 앞 경계(지금 − 2일)는 신규, 그보다 이르면 전체에만 든다", () => {
    const edge = settledBefore - RUN_INTERVAL_MS;
    expect(classify([{ refMs: edge }], NOW).newCount).toBe(1);
    expect(classify([{ refMs: edge - 1 }], NOW)).toMatchObject({
      total: 1,
      newCount: 0,
    });
  });

  it("매일 실행하면 같은 이상은 한 번만 신규로 잡힌다", () => {
    const rows = [{ refMs: NOW - 1.5 * DAY }];
    const counts = [0, 1, 2].map(
      (day) => classify(rows, NOW + day * DAY).newCount,
    );
    expect(counts).toEqual([1, 0, 0]);
  });

  it("기준 시각을 읽을 수 없는 행은 세지 않는다", () => {
    expect(classify([{ refMs: NaN }], NOW).total).toBe(0);
  });
});

describe("findSharedSessionIds — 한 sessionId를 둘 이상의 참여자가 씀", () => {
  it("다른 참여자가 같은 sessionId를 쓰면 한 건으로 잡고, 기준 시각은 첫 기록이다", () => {
    const rows = findSharedSessionIds([
      event({ anonymousId: "u1", watchedMs: 2000 }),
      event({ anonymousId: "u2", eventId: "e2", watchedMs: 1000 }),
    ]);
    expect(rows).toEqual([{ sessionId: "s1", ownerCount: 2, refMs: 1000 }]);
  });

  it("같은 참여자의 여러 기록이나 sessionId가 없는 기록은 잡지 않는다", () => {
    expect(
      findSharedSessionIds([
        event({ eventId: "e1" }),
        event({ eventId: "e2" }),
        event({ anonymousId: "u2", eventId: "e3", sessionId: null }),
      ]),
    ).toEqual([]);
  });
});

describe("findMissingSessions — 영상 기록은 있는데 세션 행이 없음", () => {
  it("세션 행이 있으면 잡지 않는다", () => {
    expect(findMissingSessions([event({})], [session({})])).toEqual([]);
  });

  it("다른 참여자의 같은 sessionId 세션 행은 이 참여자의 세션으로 치지 않는다", () => {
    const rows = findMissingSessions(
      [event({ anonymousId: "u1" })],
      [session({ anonymousId: "u2" })],
    );
    expect(rows).toHaveLength(1);
  });

  it("그 뒤 같은 참여자의 영상 기록이 있으면 누락 의심이고, 기준 시각은 그 세션의 마지막 기록이다", () => {
    const [row] = findMissingSessions(
      [
        event({ eventId: "e1", watchedMs: 1000 }),
        event({ eventId: "e2", watchedMs: 2000 }),
        event({ eventId: "e3", sessionId: "s2", watchedMs: 5000 }),
      ],
      [session({ sessionId: "s2" })],
    );
    expect(row).toMatchObject({
      sessionId: "s1",
      videoCount: 2,
      refMs: 2000,
      laterActivity: true,
    });
  });

  it("그 뒤 같은 참여자의 세션 행 저장이 있어도 누락 의심이다", () => {
    const [row] = findMissingSessions(
      [event({ watchedMs: 1000 })],
      [session({ sessionId: "s0", createdMs: 3000 })],
    );
    expect(row.laterActivity).toBe(true);
  });

  it("그 뒤 활동이 없으면 전송 대기 의심이다", () => {
    const [row] = findMissingSessions(
      [event({ watchedMs: 1000 })],
      [session({ sessionId: "s0", createdMs: 500 })],
    );
    expect(row.laterActivity).toBe(false);
  });

  it("다른 참여자의 활동은 이후 활동으로 치지 않는다", () => {
    const [row] = findMissingSessions(
      [
        event({ watchedMs: 1000 }),
        event({
          anonymousId: "u2",
          eventId: "e2",
          sessionId: "s9",
          watchedMs: 9000,
        }),
      ],
      [session({ anonymousId: "u2", sessionId: "s9" })],
    );
    expect(row.laterActivity).toBe(false);
  });
});

describe("findUndeterminedSessions — 분포가 비어 있는 세션", () => {
  it("분포가 비어 있는 세션만 잡고, 기준 시각은 종료 시각이다", () => {
    const rows = findUndeterminedSessions([
      session({ sessionId: "s1", distributionMissing: 1, endMs: 1234 }),
      session({ sessionId: "s2", distributionMissing: 0 }),
    ]);
    expect(rows).toEqual([{ anonymousId: "u1", sessionId: "s1", refMs: 1234 }]);
  });
});

describe("findNearDuplicates — 같은 참여자·같은 영상이 10초 안에 다시 기록됨", () => {
  it("사이에 다른 영상이 있어도(A → B → A) 같은 영상의 바로 앞 기록과 비교해 잡는다", () => {
    const rows = findNearDuplicates([
      event({ eventId: "a1", videoId: "A", watchedMs: 0 }),
      event({ eventId: "b1", videoId: "B", watchedMs: 4000 }),
      event({ eventId: "a2", videoId: "A", watchedMs: 9000 }),
    ]);
    expect(rows).toEqual([
      { anonymousId: "u1", sessionId: "s1", gapMs: 9000, refMs: 9000 },
    ]);
  });

  it("정확히 10초는 잡고, 10초를 넘으면 잡지 않는다", () => {
    const at = (ms) => [
      event({ eventId: "a1", watchedMs: 0 }),
      event({ eventId: "a2", watchedMs: ms }),
    ];
    expect(findNearDuplicates(at(NEAR_DUPLICATE_MS))).toHaveLength(1);
    expect(findNearDuplicates(at(NEAR_DUPLICATE_MS + 1))).toHaveLength(0);
  });

  it("세 번이 이어지면 앞 기록을 뺀 두 건을 센다", () => {
    const rows = findNearDuplicates(
      [0, 5000, 9000].map((ms, i) =>
        event({ eventId: `a${i}`, watchedMs: ms }),
      ),
    );
    expect(rows).toHaveLength(2);
  });

  it("다른 참여자가 같은 영상을 본 것은 잡지 않는다", () => {
    expect(
      findNearDuplicates([
        event({ anonymousId: "u1", watchedMs: 0 }),
        event({ anonymousId: "u2", eventId: "e2", watchedMs: 1000 }),
      ]),
    ).toEqual([]);
  });

  it("기록 순서가 섞여 들어와도 시각 순으로 비교한다", () => {
    const rows = findNearDuplicates([
      event({ eventId: "a2", watchedMs: 60000 }),
      event({ eventId: "a1", watchedMs: 0 }),
      event({ eventId: "a3", watchedMs: 65000 }),
    ]);
    expect(rows.map((r) => r.refMs)).toEqual([65000]);
  });
});

describe("findSessionCountMismatches — 세션 영상 수와 기록 기준 시청 수 비교", () => {
  it("같은 세션 안에서 앞 기록에 이어진 기록은 빼고 세므로 불일치가 아니다", () => {
    const rows = findSessionCountMismatches(
      [
        event({ eventId: "a1" }),
        event({ eventId: "a2", resumedFromEventId: "a1" }),
      ],
      [session({ videoCount: 1 })],
    );
    expect(rows).toEqual([]);
  });

  it("앞 기록이 다른 세션에 있으면 이 세션에서는 새 시청으로 센다", () => {
    const rows = findSessionCountMismatches(
      [
        event({ eventId: "a1", sessionId: "s1" }),
        event({ eventId: "a2", sessionId: "s2", resumedFromEventId: "a1" }),
      ],
      [
        session({ sessionId: "s1", videoCount: 1 }),
        session({ sessionId: "s2", videoCount: 1 }),
      ],
    );
    expect(rows).toEqual([]);
  });

  it("세션 영상 수가 기록보다 적으면 불일치로 잡는다(로컬 중복 합치기)", () => {
    const events = [0, 1, 2].map((i) => event({ eventId: `e${i}` }));
    const [row] = findSessionCountMismatches(events, [
      session({ videoCount: 2, endMs: 777 }),
    ]);
    expect(row).toMatchObject({ videoCount: 2, watches: 3, refMs: 777 });
  });

  it("세션 행은 있는데 그 세션의 영상 기록이 없으면 불일치로 잡는다", () => {
    const [row] = findSessionCountMismatches([], [session({ videoCount: 2 })]);
    expect(row).toMatchObject({ videoCount: 2, watches: 0 });
  });

  it("다른 참여자의 같은 sessionId 기록은 세지 않는다", () => {
    const rows = findSessionCountMismatches(
      [event({ anonymousId: "u2", eventId: "x" }), event({ eventId: "e1" })],
      [session({ videoCount: 1 })],
    );
    expect(rows).toEqual([]);
  });

  it("세션 영상 수가 비어 있으면(구버전 확장) 비교하지 않는다", () => {
    expect(
      findSessionCountMismatches([], [session({ videoCount: null })]),
    ).toEqual([]);
  });
});

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL UNIQUE,
      group_code TEXT NOT NULL
    );
    CREATE TABLE video_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId TEXT,
      anonymousId TEXT NOT NULL,
      videoId TEXT NOT NULL,
      watchedAt TEXT NOT NULL,
      sessionId TEXT,
      resumedFromEventId TEXT
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      endTime TEXT NOT NULL,
      videoCount INTEGER,
      categoryDistribution TEXT,
      createdAt TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function insertParticipant(db, anonymousId, groupCode = "EXP") {
  db.prepare(
    "INSERT INTO participants (anonymousId, group_code) VALUES (?, ?)",
  ).run(anonymousId, groupCode);
}

function insertEvent(db, row) {
  db.prepare(
    `INSERT INTO video_events (eventId, anonymousId, videoId, watchedAt, sessionId, resumedFromEventId)
     VALUES (@eventId, @anonymousId, @videoId, @watchedAt, @sessionId, @resumedFromEventId)`,
  ).run({ resumedFromEventId: null, sessionId: "s1", videoId: "v1", ...row });
}

function insertSession(db, row) {
  db.prepare(
    `INSERT INTO sessions (anonymousId, sessionId, endTime, videoCount, categoryDistribution, createdAt)
     VALUES (@anonymousId, @sessionId, @endTime, @videoCount, @categoryDistribution, @createdAt)`,
  ).run({ videoCount: 1, categoryDistribution: "{}", ...row });
}

describe("collectRecords — DB 조회", () => {
  let db;
  afterEach(() => db?.close());

  it("TEST 그룹 참여자의 기록과 세션은 빼고 읽는다", () => {
    db = createTestDb();
    insertParticipant(db, "real", "CON");
    insertParticipant(db, "tester", "TEST-EXP");
    insertEvent(db, {
      eventId: "e1",
      anonymousId: "real",
      watchedAt: "2026-11-01T00:00:00.000Z",
    });
    insertEvent(db, {
      eventId: "e2",
      anonymousId: "tester",
      watchedAt: "2026-11-01T00:00:00.000Z",
    });
    insertSession(db, {
      anonymousId: "tester",
      sessionId: "s1",
      endTime: "2026-11-01T00:10:00.000Z",
      createdAt: "2026-11-01 00:10:00",
    });

    const { events, sessions } = collectRecords(db);
    expect(events.map((e) => e.anonymousId)).toEqual(["real"]);
    expect(sessions).toEqual([]);
  });

  it("저장 형식이 달라도 같은 시각은 같은 ms로 읽는다", () => {
    db = createTestDb();
    insertParticipant(db, "u1");
    insertEvent(db, {
      eventId: "z",
      anonymousId: "u1",
      watchedAt: "2026-11-01T09:00:00.000Z",
    });
    insertEvent(db, {
      eventId: "k",
      anonymousId: "u1",
      watchedAt: "2026-11-01T18:00:00+09:00",
    });
    insertSession(db, {
      anonymousId: "u1",
      sessionId: "s1",
      endTime: "2026-11-01T09:00:00Z",
      createdAt: "2026-11-01 09:00:00",
    });

    const { events, sessions } = collectRecords(db);
    const expected = Date.parse("2026-11-01T09:00:00.000Z");
    for (const e of events) expect(Math.round(e.watchedMs)).toBe(expected);
    expect(Math.round(sessions[0].endMs)).toBe(expected);
    expect(Math.round(sessions[0].createdMs)).toBe(expected);
  });

  it("시각을 읽을 수 없는 영상 기록은 뺀다", () => {
    db = createTestDb();
    insertParticipant(db, "u1");
    insertEvent(db, {
      eventId: "bad",
      anonymousId: "u1",
      watchedAt: "not-a-date",
    });
    expect(collectRecords(db).events).toEqual([]);
  });
});

describe("run — 점검 전체", () => {
  let db;
  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
  });

  it("점검마다 전체·신규 건수를 내고, 출력에 anonymousId 원본을 남기지 않는다", () => {
    db = createTestDb();
    const secretId = "11111111-2222-3333-4444-555555555555";
    insertParticipant(db, secretId);
    const day2 = "2026-11-08T12:00:00.000Z"; // 신규 창 안
    // 세션 행 없는 세션 + 이후 활동 → 누락 의심
    insertEvent(db, {
      eventId: "m1",
      anonymousId: secretId,
      sessionId: "lost",
      watchedAt: day2,
    });
    // 같은 영상 9초 뒤 다시 기록, 세션 영상 수는 1 → 중복·불일치
    insertEvent(db, {
      eventId: "d1",
      anonymousId: secretId,
      sessionId: "dup",
      videoId: "A",
      watchedAt: "2026-11-08T13:00:00.000Z",
    });
    insertEvent(db, {
      eventId: "d2",
      anonymousId: secretId,
      sessionId: "dup",
      videoId: "A",
      watchedAt: "2026-11-08T13:00:09.000Z",
    });
    insertSession(db, {
      anonymousId: secretId,
      sessionId: "dup",
      endTime: "2026-11-08T13:10:09.000Z",
      videoCount: 1,
      categoryDistribution: null,
      createdAt: "2026-11-08 13:10:10",
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = run(db, { now: NOW });

    expect(Object.keys(result)).toEqual(Object.keys(CHECK_LABELS));
    expect(result.sharedSessionIds).toMatchObject({ total: 0, newCount: 0 });
    expect(result.missingSuspected).toMatchObject({ total: 1, newCount: 1 });
    expect(result.missingPending).toMatchObject({ total: 0 });
    expect(result.undeterminedDistribution).toMatchObject({
      total: 1,
      newCount: 1,
    });
    expect(result.nearDuplicates).toMatchObject({ total: 1, newCount: 1 });
    expect(result.sessionCountMismatches).toMatchObject({
      total: 1,
      newCount: 1,
    });

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain(
      "세션 행 누락 의심(이후 활동 있음): 전체 1건, 신규 1건",
    );
    expect(output).not.toContain(secretId);
  });

  it("기록이 하나도 없으면 모든 점검이 0건이다", () => {
    db = createTestDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const result = run(db, { now: NOW });
    for (const name of Object.keys(CHECK_LABELS)) {
      expect(result[name]).toMatchObject({ total: 0, newCount: 0 });
    }
  });
});

// 점검마다 다른 건수와, 식별자가 담긴 신규 행을 둔다
function sampleResult() {
  const secret = "11111111-2222-3333-4444-555555555555";
  return Object.fromEntries(
    Object.keys(CHECK_LABELS).map((name, i) => [
      name,
      {
        total: i + 10,
        newCount: i,
        newRows: [{ anonymousId: secret, sessionId: "1793084950187" }],
      },
    ]),
  );
}

describe("formatIntegritySummary — Healthchecks 본문", () => {
  it("점검마다 전체·신규 건수를 담고, 식별자는 담지 않는다", () => {
    const body = formatIntegritySummary(sampleResult());
    for (const label of Object.values(CHECK_LABELS)) {
      expect(body).toContain(label);
    }
    expect(body).toContain("세션 ID 공유 10(신규 0)");
    expect(body).not.toContain("11111111");
    expect(body).not.toContain("1793084950187");
  });
});

describe("reportToHealthchecks — 실행 완료 알림", () => {
  it("이상이 있어도 success를 POST로 보내고 본문에 건수를 싣는다", async () => {
    const ping = { pingSuccess: vi.fn().mockResolvedValue({ ok: true }) };
    const result = sampleResult();
    await reportToHealthchecks(result, { ping });
    expect(ping.pingSuccess).toHaveBeenCalledWith("DATA_INTEGRITY_PING_URL", {
      method: "POST",
      body: formatIntegritySummary(result),
    });
  });
});

describe("sendIntegrityGauges — Datadog gauge", () => {
  it("점검마다 전체·신규 gauge를 check 태그로 하나씩 보낸다", () => {
    const client = { send: vi.fn() };
    sendIntegrityGauges(sampleResult(), client);
    expect(client.send).toHaveBeenCalledTimes(
      Object.keys(CHECK_TAGS).length * Object.keys(GAUGES).length,
    );
    expect(client.send).toHaveBeenCalledWith(GAUGES.total, 10, "g", {
      check: "shared_session_ids",
    });
    expect(client.send).toHaveBeenCalledWith(GAUGES.newCount, 1, "g", {
      check: "missing_suspected",
    });
  });

  it("모든 점검에 태그가 있고, 보내는 줄은 형식 검증과 태그 허용 목록을 통과한다", () => {
    expect(Object.keys(CHECK_TAGS)).toEqual(Object.keys(CHECK_LABELS));
    const client = {
      send: (name, value, type, tags) =>
        expect(formatMetric(name, value, type, tags, ALLOWED_TAGS)).toBe(
          `${name}:${value}|g|#check:${tags.check}`,
        ),
    };
    sendIntegrityGauges(sampleResult(), client);
  });

  it("허용 목록 밖 check 값은 태그에서 버린다", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      formatMetric(GAUGES.total, 1, "g", { check: "anon-123" }, ALLOWED_TAGS),
    ).toBe(`${GAUGES.total}:1|g`);
    vi.restoreAllMocks();
  });
});
