import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  run,
  collectRecords,
  isEligibleAt,
  classify,
  CHECK_LABELS,
  RUN_INTERVAL_MS,
  formatExposureSummary,
  reportToHealthchecks,
  sendExposureGauges,
  CHECK_TAGS,
  ALLOWED_TAGS,
  GAUGES,
} from "../../scripts/feedback-exposure-report.js";
import { formatMetric } from "../../monitoring/dogstatsd.js";

// 11-23 KST 설치 → 기준선은 11-23~11-26(KST), 11-27 00:00 KST부터 피드백 기간
const INSTALL = "2026-11-23T10:00:00+09:00";
const IN_BASELINE = "2026-11-26T23:00:00+09:00";
const AFTER_BASELINE = "2026-11-27T00:30:00+09:00";
const VERIFIED = "2027-01-05T10:00:00+09:00";
// 실행 시각. 신규 창은 그 전 하루다
const NOW = Date.parse("2026-11-28T09:30:00+09:00");
const IN_WINDOW = "2026-11-28 00:00:00"; // datetime('now') 형식(UTC)
const BEFORE_WINDOW = "2026-11-20 00:00:00";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL UNIQUE,
      group_code TEXT NOT NULL,
      installDate TEXT NOT NULL,
      studyEndCodeVerifiedAt TEXT
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      review TEXT,
      feedbackNotifiedAt TEXT,
      feedbackViewedAt TEXT,
      feedbackConfirmedAt TEXT,
      createdAt TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE popup_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId TEXT,
      anonymousId TEXT NOT NULL,
      todayFeedbackViewed INTEGER DEFAULT 0,
      periodFeedbackViewed INTEGER DEFAULT 0,
      pastDayReviewViews INTEGER,
      openedAt TEXT,
      createdAt TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function insertParticipant(db, anonymousId, groupCode, verifiedAt = null) {
  db.prepare(
    `INSERT INTO participants (anonymousId, group_code, installDate, studyEndCodeVerifiedAt)
     VALUES (?, ?, ?, ?)`,
  ).run(anonymousId, groupCode, INSTALL, verifiedAt);
}

function insertSession(db, row) {
  db.prepare(
    `INSERT INTO sessions (anonymousId, sessionId, review, feedbackNotifiedAt, feedbackViewedAt, feedbackConfirmedAt, createdAt)
     VALUES (@anonymousId, @sessionId, @review, @feedbackNotifiedAt, @feedbackViewedAt, @feedbackConfirmedAt, @createdAt)`,
  ).run({
    sessionId: "s1",
    review: null,
    feedbackNotifiedAt: null,
    feedbackViewedAt: null,
    feedbackConfirmedAt: null,
    createdAt: IN_WINDOW,
    ...row,
  });
}

function insertPopup(db, row) {
  db.prepare(
    `INSERT INTO popup_events (eventId, anonymousId, todayFeedbackViewed, periodFeedbackViewed, pastDayReviewViews, openedAt, createdAt)
     VALUES (@eventId, @anonymousId, @todayFeedbackViewed, @periodFeedbackViewed, @pastDayReviewViews, @openedAt, @createdAt)`,
  ).run({
    eventId: "p1",
    todayFeedbackViewed: 0,
    periodFeedbackViewed: 0,
    pastDayReviewViews: null,
    createdAt: IN_WINDOW,
    ...row,
  });
}

function runQuietly(db, now = NOW) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  return run(db, { now });
}

let db;
afterEach(() => {
  db?.close();
  db = undefined;
  vi.restoreAllMocks();
});

describe("isEligibleAt — 그 시각의 리뷰 열람 자격", () => {
  const exp = { group_code: "EXP", installDate: INSTALL };

  it("실험군은 기준선 마지막 날까지 자격이 없고, 다음 날 00:00 KST부터 있다", () => {
    expect(isEligibleAt(exp, Date.parse(IN_BASELINE))).toBe(false);
    expect(isEligibleAt(exp, Date.parse(AFTER_BASELINE))).toBe(true);
  });

  it("대조군은 연구 종료 코드 검증 시각부터 자격이 있다", () => {
    const con = { group_code: "CON", verifiedMs: Date.parse(VERIFIED) };
    expect(isEligibleAt(con, Date.parse(VERIFIED) - 1)).toBe(false);
    expect(isEligibleAt(con, Date.parse(VERIFIED))).toBe(true);
  });

  it("코드 검증 전인 대조군은 언제든 자격이 없다", () => {
    const con = { group_code: "CON", verifiedMs: null };
    expect(isEligibleAt(con, Date.parse("2027-12-31T00:00:00Z"))).toBe(false);
  });
});

describe("대조군 세션 피드백 알림·열람", () => {
  it("대조군 세션의 알림·열람·확인 시각은 각각 한 건으로 잡고, 칸마다 도착 시각으로 신규를 센다", () => {
    db = createTestDb();
    insertParticipant(db, "con", "CON");
    // 알림은 세션 저장(신규 창 안)과 함께, 열람은 그보다 앞서 서버에 도착했다
    insertSession(db, {
      anonymousId: "con",
      feedbackNotifiedAt: AFTER_BASELINE,
      feedbackViewedAt: "2026-11-25T01:00:00.000Z",
    });
    const result = runQuietly(db);
    expect(result.controlSessionFeedback.total).toBe(2);
    expect(result.controlSessionFeedback.newRows.map((r) => r.item)).toEqual([
      "feedbackNotifiedAt",
    ]);
  });

  it("실험군 세션의 피드백 기록은 여기서 잡지 않는다", () => {
    db = createTestDb();
    insertParticipant(db, "exp", "EXP");
    insertSession(db, { anonymousId: "exp", feedbackViewedAt: AFTER_BASELINE });
    expect(runQuietly(db).controlSessionFeedback.total).toBe(0);
  });
});

describe("실험군 기준선 중 세션 피드백", () => {
  it("기준선 마지막 날 밤의 알림은 위반, 다음 날 00:30의 열람은 위반이 아니다", () => {
    db = createTestDb();
    insertParticipant(db, "exp", "EXP");
    insertSession(db, {
      anonymousId: "exp",
      feedbackNotifiedAt: IN_BASELINE,
      feedbackViewedAt: AFTER_BASELINE,
    });
    const result = runQuietly(db);
    expect(result.baselineSessionFeedback.total).toBe(1);
    expect(result.baselineSessionFeedback.newRows[0]).toMatchObject({
      item: "feedbackNotifiedAt",
      atMs: Date.parse(IN_BASELINE),
    });
  });
});

describe("자격 밖 팝업 리뷰 열람", () => {
  it("실험군이 기준선 중에 연 팝업에서 오늘 리뷰를 봤으면 위반이다", () => {
    db = createTestDb();
    insertParticipant(db, "exp", "EXP");
    insertPopup(db, {
      anonymousId: "exp",
      todayFeedbackViewed: 1,
      openedAt: IN_BASELINE,
    });
    const { ineligiblePopupViews } = runQuietly(db);
    expect(ineligiblePopupViews.total).toBe(1);
    expect(ineligiblePopupViews.newRows[0].item).toBe("todayFeedbackViewed");
  });

  it("기준선이 끝난 뒤 지난 날(기준선 날짜) 리뷰를 본 것은 위반이 아니다", () => {
    db = createTestDb();
    insertParticipant(db, "exp", "EXP");
    insertPopup(db, {
      anonymousId: "exp",
      pastDayReviewViews: 2,
      openedAt: AFTER_BASELINE,
    });
    expect(runQuietly(db).ineligiblePopupViews.total).toBe(0);
  });

  it("대조군은 코드 검증 전에 본 기간·지난 날 리뷰가 위반이고, 검증 뒤에 본 것은 아니다", () => {
    db = createTestDb();
    insertParticipant(db, "con", "CON", VERIFIED);
    insertPopup(db, {
      eventId: "before",
      anonymousId: "con",
      periodFeedbackViewed: 1,
      pastDayReviewViews: 1,
      openedAt: AFTER_BASELINE,
    });
    insertPopup(db, {
      eventId: "after",
      anonymousId: "con",
      todayFeedbackViewed: 1,
      openedAt: "2027-01-05T11:00:00+09:00",
    });
    const { ineligiblePopupViews } = runQuietly(db);
    expect(ineligiblePopupViews.total).toBe(1);
    expect(ineligiblePopupViews.newRows[0]).toMatchObject({
      popupEventId: "before",
      item: "periodFeedbackViewed,pastDayReviewViews",
    });
  });

  it("리뷰를 보지 않은 팝업은 읽지 않는다", () => {
    db = createTestDb();
    insertParticipant(db, "con", "CON");
    insertPopup(db, { anonymousId: "con", openedAt: IN_BASELINE });
    expect(collectRecords(db).popups).toEqual([]);
  });

  it("연 시각이 없는 기록은 위반이 아니라 판정 불가로 센다", () => {
    db = createTestDb();
    insertParticipant(db, "con", "CON");
    insertPopup(db, {
      anonymousId: "con",
      todayFeedbackViewed: 1,
      openedAt: null,
    });
    const result = runQuietly(db);
    expect(result.ineligiblePopupViews.total).toBe(0);
    expect(result.unjudgedPopupViews.total).toBe(1);
  });
});

describe("대조군 세션 리뷰 생성", () => {
  it("대조군 세션에 리뷰 문장이 있으면 잡고, 실험군 세션의 리뷰는 잡지 않는다", () => {
    db = createTestDb();
    insertParticipant(db, "con", "CON");
    insertParticipant(db, "exp", "EXP");
    insertSession(db, { anonymousId: "con", sessionId: "c1", review: "…" });
    insertSession(db, { anonymousId: "exp", sessionId: "e1", review: "…" });
    const { controlSessionReviews } = runQuietly(db);
    expect(controlSessionReviews.total).toBe(1);
    expect(controlSessionReviews.newRows[0].sessionId).toBe("c1");
  });
});

describe("classify — 서버 도착 시각으로 신규를 센다", () => {
  const now = NOW;

  it("직전 실행 이후 하루 안에 도착한 것만 신규다", () => {
    const rows = [
      { arrivalMs: now - RUN_INTERVAL_MS },
      { arrivalMs: now - RUN_INTERVAL_MS - 1 },
      { arrivalMs: now },
    ];
    expect(classify(rows, now)).toMatchObject({ total: 3, newCount: 1 });
  });

  it("도착 시각을 읽을 수 없으면 전체에만 든다", () => {
    expect(classify([{ arrivalMs: null }], now)).toMatchObject({
      total: 1,
      newCount: 0,
    });
  });

  it("며칠 전에 본 팝업 기록이 늦게 도착해도, 도착한 다음 실행에서 신규로 잡힌다", () => {
    db = createTestDb();
    insertParticipant(db, "exp", "EXP");
    insertPopup(db, {
      anonymousId: "exp",
      todayFeedbackViewed: 1,
      openedAt: "2026-11-24T20:00:00+09:00",
      createdAt: IN_WINDOW,
    });
    expect(runQuietly(db).ineligiblePopupViews.newCount).toBe(1);
  });

  it("예전에 도착한 위반은 전체에만 든다", () => {
    db = createTestDb();
    insertParticipant(db, "con", "CON");
    insertSession(db, {
      anonymousId: "con",
      review: "…",
      createdAt: BEFORE_WINDOW,
    });
    expect(runQuietly(db).controlSessionReviews).toMatchObject({
      total: 1,
      newCount: 0,
    });
  });
});

describe("collectRecords — DB 조회", () => {
  it("TEST 그룹 참여자의 기록은 빼고 읽는다", () => {
    db = createTestDb();
    insertParticipant(db, "tester", "TEST-CON");
    insertSession(db, { anonymousId: "tester", review: "…" });
    insertPopup(db, {
      anonymousId: "tester",
      todayFeedbackViewed: 1,
      openedAt: IN_BASELINE,
    });
    const { participants, sessions, popups } = collectRecords(db);
    expect(participants.size).toBe(0);
    expect(sessions).toEqual([]);
    expect(popups).toEqual([]);
  });

  it("저장 형식이 달라도 같은 시각은 같은 ms로 읽는다", () => {
    db = createTestDb();
    insertParticipant(db, "con", "CON", "2026-11-27T00:00:00.000Z");
    insertSession(db, {
      anonymousId: "con",
      feedbackViewedAt: "2026-11-27T09:00:00+09:00",
      createdAt: "2026-11-27 00:00:00",
    });
    const { participants, sessions } = collectRecords(db);
    const expected = Date.parse("2026-11-27T00:00:00.000Z");
    expect(Math.round(participants.get("con").verifiedMs)).toBe(expected);
    expect(Math.round(sessions[0].viewedMs)).toBe(expected);
    expect(Math.round(sessions[0].createdMs)).toBe(expected);
  });
});

describe("run — 감사 전체", () => {
  it("항목마다 전체·신규 건수를 내고, 출력에 anonymousId 원본을 남기지 않는다", () => {
    db = createTestDb();
    const secretId = "11111111-2222-3333-4444-555555555555";
    insertParticipant(db, secretId, "CON");
    insertSession(db, {
      anonymousId: secretId,
      sessionId: "1793084950187",
      review: "…",
      feedbackNotifiedAt: AFTER_BASELINE,
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = run(db, { now: NOW });

    expect(Object.keys(result)).toEqual(Object.keys(CHECK_LABELS));
    expect(result.controlSessionFeedback).toMatchObject({
      total: 1,
      newCount: 1,
    });
    expect(result.controlSessionReviews).toMatchObject({
      total: 1,
      newCount: 1,
    });
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("대조군 세션 리뷰 생성: 전체 1건, 신규 1건");
    expect(output).toContain("그룹=CON sessionId=1793084950187 항목=review");
    expect(output).not.toContain(secretId);
  });

  it("기록이 하나도 없으면 모든 항목이 0건이다", () => {
    db = createTestDb();
    const result = runQuietly(db);
    for (const name of Object.keys(CHECK_LABELS)) {
      expect(result[name]).toMatchObject({ total: 0, newCount: 0 });
    }
  });
});

// 항목마다 다른 건수와, 식별자가 담긴 신규 행을 둔다
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

describe("formatExposureSummary — Healthchecks 본문", () => {
  it("항목마다 전체·신규 건수를 담고, 식별자는 담지 않는다", () => {
    const body = formatExposureSummary(sampleResult());
    for (const label of Object.values(CHECK_LABELS)) {
      expect(body).toContain(label);
    }
    expect(body).toContain("대조군 세션 피드백 알림·열람 10(신규 0)");
    expect(body).not.toContain("11111111");
    expect(body).not.toContain("1793084950187");
  });
});

describe("reportToHealthchecks — 실행 완료 알림", () => {
  it("위반이 있어도 success를 POST로 보내고 본문에 건수를 싣는다", async () => {
    const ping = { pingSuccess: vi.fn().mockResolvedValue({ ok: true }) };
    const result = sampleResult();
    await reportToHealthchecks(result, { ping });
    expect(ping.pingSuccess).toHaveBeenCalledWith(
      "FEEDBACK_EXPOSURE_PING_URL",
      { method: "POST", body: formatExposureSummary(result) },
    );
  });
});

describe("sendExposureGauges — Datadog gauge", () => {
  it("항목마다 전체·신규 gauge를 check 태그로 하나씩 보낸다", () => {
    const client = { send: vi.fn() };
    sendExposureGauges(sampleResult(), client);
    expect(client.send).toHaveBeenCalledTimes(
      Object.keys(CHECK_TAGS).length * Object.keys(GAUGES).length,
    );
    expect(client.send).toHaveBeenCalledWith(GAUGES.total, 10, "g", {
      check: "control_session_feedback",
    });
    expect(client.send).toHaveBeenCalledWith(GAUGES.newCount, 1, "g", {
      check: "baseline_session_feedback",
    });
  });

  it("모든 항목에 태그가 있고, 보내는 줄은 형식 검증과 태그 허용 목록을 통과한다", () => {
    expect(Object.keys(CHECK_TAGS)).toEqual(Object.keys(CHECK_LABELS));
    const client = {
      send: (name, value, type, tags) =>
        expect(formatMetric(name, value, type, tags, ALLOWED_TAGS)).toBe(
          `${name}:${value}|g|#check:${tags.check}`,
        ),
    };
    sendExposureGauges(sampleResult(), client);
  });
});
