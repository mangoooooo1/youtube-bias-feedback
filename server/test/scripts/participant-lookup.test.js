import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import crypto from "crypto";
import {
  classifyInput,
  lookup,
  formatDetail,
  printResult,
} from "../../scripts/participant-lookup.js";

const UUID = "3f1c2b9a-7d4e-4c1a-9b2f-1e2d3c4b5a6f";
const NOW = new Date("2026-06-05T03:00:00Z"); // 2026-06-05 12:00 KST

function sha10(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 10);
}

function createTestDb({ withVersions = true } = {}) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE participants (
      anonymousId TEXT, participantCode TEXT, group_code TEXT, installDate TEXT,
      studyEndModalShownAt TEXT, studyEndReviewViewedAt TEXT, studyEndCodeVerifiedAt TEXT
    );
    CREATE TABLE video_events (anonymousId TEXT, watchedAt TEXT);
    CREATE TABLE sessions (anonymousId TEXT, createdAt TEXT);
    CREATE TABLE today_reviews (
      anonymousId TEXT, reviewDate TEXT, llmStatus TEXT, source TEXT, generatedAt TEXT
    );
    CREATE TABLE period_reviews (
      anonymousId TEXT, periodIndex INTEGER, periodStart TEXT, periodEnd TEXT,
      llmStatus TEXT, generatedAt TEXT
    );
    CREATE TABLE popup_events (anonymousId TEXT, openedAt TEXT);
  `);
  if (withVersions) {
    db.exec(
      "CREATE TABLE period_review_versions (anonymousId TEXT, periodIndex INTEGER, generatedAt TEXT)",
    );
  }
  return db;
}

function insertParticipant(
  db,
  { anonymousId = UUID, code = "VL-AB12", group = "EXP" } = {},
) {
  db.prepare(
    "INSERT INTO participants (anonymousId, participantCode, group_code, installDate) VALUES (?, ?, ?, ?)",
  ).run(anonymousId, code, group, "2026-06-01T00:00:00.000Z");
}

describe("classifyInput — 입력 판별", () => {
  it("UUID는 anonymousId로 본다", () => {
    expect(classifyInput(` ${UUID} `)).toEqual({
      type: "anonymousId",
      value: UUID,
    });
  });

  it("16진수 10자는 지문으로 보고 소문자로 맞춘다", () => {
    expect(classifyInput("AB12CD34EF")).toEqual({
      type: "fingerprint",
      value: "ab12cd34ef",
    });
  });

  it("그 밖의 값은 참여 코드로 보고 등록 때처럼 trim·대문자로 정규화한다", () => {
    expect(classifyInput(" vl-ab12 ")).toEqual({
      type: "participantCode",
      value: "VL-AB12",
    });
  });
});

describe("lookup — 참여자 찾기와 상태 모으기", () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("anonymousId·참여 코드·지문 어느 것으로도 같은 참여자를 찾는다", () => {
    insertParticipant(db);
    for (const raw of [
      UUID,
      UUID.toUpperCase(),
      "vl-ab12",
      sha10(UUID),
      sha10("VL-AB12"),
    ]) {
      const { matches } = lookup(db, raw, { now: NOW });
      expect(matches.map((m) => m.anonymousId)).toEqual([UUID]);
    }
  });

  it("찾는 참여자가 없으면 빈 목록이다", () => {
    expect(lookup(db, "VL-NONE", { now: NOW }).matches).toEqual([]);
  });

  it("연구 일차, 마지막 활동, 최근 7일 KST 날짜별 개수를 모은다", () => {
    insertParticipant(db);
    // 06-04 23:30 UTC = 06-05 08:30 KST
    db.prepare("INSERT INTO video_events VALUES (?, ?)").run(
      UUID,
      "2026-06-04T23:30:00Z",
    );
    db.prepare("INSERT INTO video_events VALUES (?, ?)").run(
      UUID,
      "2026-06-03T10:00:00+09:00",
    );
    db.prepare("INSERT INTO sessions VALUES (?, ?)").run(
      UUID,
      "2026-06-03 02:00:00",
    );

    const [d] = lookup(db, UUID, { now: NOW }).matches;

    expect(d.studyDay).toBe(5); // 설치 06-01 09:00 KST → 06-05가 5일차
    expect(d.studyEnded).toBe(false);
    expect(d.lastVideoAt).toBe("2026-06-04T23:30:00.000Z");
    expect(d.lastSessionAt).toBe("2026-06-03T02:00:00.000Z");
    expect(d.recentDays).toHaveLength(7);
    expect(d.recentDays.at(-1)).toEqual({
      date: "2026-06-05",
      videos: 1,
      sessions: 0,
    });
    expect(d.recentDays.find((r) => r.date === "2026-06-03")).toEqual({
      date: "2026-06-03",
      videos: 1,
      sessions: 1,
    });
  });

  it("활동이 없으면 마지막 활동은 null이고 날짜별 개수는 0이다", () => {
    insertParticipant(db);
    const [d] = lookup(db, UUID, { now: NOW }).matches;
    expect(d.lastVideoAt).toBeNull();
    expect(d.lastSessionAt).toBeNull();
    expect(d.recentDays.every((r) => r.videos === 0 && r.sessions === 0)).toBe(
      true,
    );
    expect(formatDetail(d)).toContain("(기록 없음)");
  });

  it("기간 리뷰마다 생성 이력 수를 붙인다", () => {
    insertParticipant(db);
    db.prepare(
      "INSERT INTO period_reviews VALUES (?, 1, '2026-06-01', '2026-06-04', 'success', 'g2')",
    ).run(UUID);
    db.prepare("INSERT INTO period_review_versions VALUES (?, 1, 'g1')").run(
      UUID,
    );
    db.prepare("INSERT INTO period_review_versions VALUES (?, 1, 'g2')").run(
      UUID,
    );

    const [d] = lookup(db, UUID, { now: NOW }).matches;

    expect(d.periodReviews).toEqual([
      expect.objectContaining({
        periodIndex: 1,
        llmStatus: "success",
        versions: 2,
      }),
    ]);
    expect(formatDetail(d)).toContain("(생성 2회)");
  });

  it("이력 테이블이 없는 DB(배포 전 백업)에서도 동작한다", () => {
    db.close();
    db = createTestDb({ withVersions: false });
    insertParticipant(db);
    db.prepare(
      "INSERT INTO period_reviews VALUES (?, 1, '2026-06-01', '2026-06-04', 'success', 'g1')",
    ).run(UUID);

    const [d] = lookup(db, UUID, { now: NOW }).matches;

    expect(d.periodReviews[0].versions).toBeNull();
    expect(formatDetail(d)).not.toContain("생성");
  });

  it("연구 종료 단계 시각을 출력하고, 없으면 기록 없음으로 표시한다", () => {
    insertParticipant(db, { group: "CON" });
    db.prepare(
      "UPDATE participants SET studyEndModalShownAt = ?, studyEndCodeVerifiedAt = ? WHERE anonymousId = ?",
    ).run("2026-06-13T00:10:00.000Z", "2026-06-13T00:12:00.000Z", UUID);

    const text = formatDetail(lookup(db, UUID, { now: NOW }).matches[0]);

    expect(text).toContain("종료 안내 표시   : 2026-06-13T00:10:00.000Z");
    expect(text).toContain("종료 코드 확인   : 2026-06-13T00:12:00.000Z");
    expect(text).toContain("누적 리뷰 열람   : (기록 없음)");
  });

  it("TEST 그룹은 분석·감시 대상이 아니라고 표시한다", () => {
    insertParticipant(db, { code: "TEST-EXP", group: "TEST-EXP" });
    const [d] = lookup(db, UUID, { now: NOW }).matches;
    expect(formatDetail(d)).toContain("TEST — 분석·감시 대상 아님");
  });

  it("출력 끝에 같은 참여자의 서버 로그를 찾는 grep 명령을 붙인다", () => {
    insertParticipant(db);
    const [d] = lookup(db, UUID, { now: NOW }).matches;
    expect(formatDetail(d)).toContain(`grep -h 'anonymousId="${UUID}"'`);
  });

  it("Datadog Logs·APM에서 같은 참여자를 찾는 검색식을 붙인다", () => {
    insertParticipant(db);
    const [d] = lookup(db, UUID, { now: NOW }).matches;
    const lines = formatDetail(d).split("\n");
    const logs = lines.find(
      (l) => l.includes(`"${UUID}"`) && l.includes("Logs"),
    );
    const apm = lines.find((l) => l.includes(`@usr.id:${UUID}`));
    // Agent 마스킹 해제는 Logs에만 해당하고, APM은 서버 배포 시점부터 조회된다
    expect(logs).toContain("Agent 마스킹 해제 이후");
    expect(apm).toContain("서버 배포 이후");
    expect(apm).toContain("보존 필터");
    expect(apm).not.toContain("마스킹");
  });
});

// 운영자가 참여자 문의를 처리할 때 터미널에서 보는 출력
describe("formatDetail·printResult — 터미널 출력", () => {
  let db;
  let logs;

  beforeEach(() => {
    db = createTestDb();
    logs = [];
    vi.spyOn(console, "log").mockImplementation((line) => logs.push(line));
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("참여 코드가 없으면 (없음), 연구 기간이 지났으면 연구 종료를 표시한다", () => {
    insertParticipant(db, { code: null });
    const [d] = lookup(db, UUID, {
      now: new Date("2026-07-01T03:00:00Z"),
    }).matches;

    const text = formatDetail(d);
    expect(text).toContain("참여 코드     : (없음)");
    expect(text).toContain("(연구 종료)");
  });

  it("최근 오늘 리뷰가 있으면 날짜·상태·출처·생성 시각을 한 줄로 보인다", () => {
    insertParticipant(db);
    db.prepare(
      "INSERT INTO today_reviews (anonymousId, reviewDate, llmStatus, source, generatedAt) VALUES (?, ?, ?, ?, ?)",
    ).run(UUID, "2026-06-04", "success", "llm", "2026-06-04T12:00:00.000Z");
    const [d] = lookup(db, UUID, { now: NOW }).matches;

    expect(formatDetail(d)).toContain(
      "오늘 리뷰(최근): 2026-06-04 success (llm) 2026-06-04T12:00:00.000Z",
    );
  });

  it("찾은 참여자가 없으면 입력 종류와 함께 알린다", () => {
    printResult(lookup(db, UUID, { now: NOW }));

    expect(logs).toEqual([
      "[participant-lookup] anonymousId로 찾은 참여자가 없습니다.",
    ]);
  });

  it("여러 명이 매칭되면 인원을 먼저 알리고 참여자 사이에 구분선을 넣는다", () => {
    const d = { ...lookupOne(db) };
    const input = { type: "fingerprint" };

    printResult({ input, matches: [d, d] });

    expect(logs[0]).toBe(
      "[participant-lookup] 2명이 매칭됐습니다(지문 충돌 가능).",
    );
    expect(logs[1]).toBe(formatDetail(d));
    expect(logs[2]).toBe(`\n${"-".repeat(40)}`);
    expect(logs[3]).toBe(formatDetail(d));
  });

  function lookupOne(database) {
    insertParticipant(database);
    return lookup(database, UUID, { now: NOW }).matches[0];
  }
});
