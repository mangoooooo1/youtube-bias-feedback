import { describe, it, expect } from "vitest";
import {
  extractErrorLines,
  fingerprint,
  summarizeAlertLine,
  buildAlertDetail,
  readNewText,
  decideAlerts,
  shouldPersistState,
  classifyTier,
} from "../../monitoring/error-monitor.js";

describe("extractErrorLines", () => {
  it("[Error] 접두사가 붙은 라인만 추출한다", () => {
    const text = [
      "[Error] POST /api/sessions : database is locked",
      "server listening on 3000",
      "[Error] GET /api/video-events : no such table",
      "",
    ].join("\n");

    expect(extractErrorLines(text)).toEqual([
      "[Error] POST /api/sessions : database is locked",
      "[Error] GET /api/video-events : no such table",
    ]);
  });

  it("Tier 2 접두사([youtube]/[today-review-llm])도 추출 대상에 포함된다", () => {
    const text = [
      "[youtube] API 오류: 403",
      "[youtube] 네트워크 오류: fetch failed",
      "[today-review-llm] API error body: quota exceeded",
      "[sessions] 오늘 리뷰 생성 오류: no such table",
      "그냥 일반 로그 라인",
    ].join("\n");

    expect(extractErrorLines(text)).toEqual([
      "[youtube] API 오류: 403",
      "[youtube] 네트워크 오류: fetch failed",
      "[today-review-llm] API error body: quota exceeded",
      "[sessions] 오늘 리뷰 생성 오류: no such table",
    ]);
  });

  it("[access] 접두사(app.js의 4xx 접근 로그)도 추출 대상에 포함된다", () => {
    const text = [
      "[access] POST /api/video-events 404 anonymousId=abc-123",
      "그냥 일반 로그 라인",
    ].join("\n");

    expect(extractErrorLines(text)).toEqual([
      "[access] POST /api/video-events 404 anonymousId=abc-123",
    ]);
  });

  it("[access-other](API 밖 경로의 4xx)는 추출하지 않는다", () => {
    const text = [
      "[access-other] GET /.env 404",
      "[access-other] POST / 404",
      "[access] POST /api/video-events 404 anonymousId=abc-123",
    ].join("\n");

    expect(extractErrorLines(text)).toEqual([
      "[access] POST /api/video-events 404 anonymousId=abc-123",
    ]);
  });

  it("에러 라인이 없으면 빈 배열을 반환한다", () => {
    expect(extractErrorLines("all good\nnothing here\n")).toEqual([]);
  });

  it("빈 텍스트에도 크래시하지 않는다", () => {
    expect(extractErrorLines("")).toEqual([]);
  });
});

describe("classifyTier", () => {
  it("[Error]·[sessions] 오늘 리뷰 생성 오류·[access]는 Tier 1이다", () => {
    expect(
      classifyTier("[Error] POST /api/sessions : database is locked"),
    ).toBe(1);
    expect(classifyTier("[sessions] 오늘 리뷰 생성 오류: no such table")).toBe(
      1,
    );
    expect(
      classifyTier("[access] POST /api/video-events 404 anonymousId=abc"),
    ).toBe(1);
  });

  it("[youtube]/[today-review-llm] 계열은 Tier 2다", () => {
    expect(classifyTier("[youtube] API 오류: 403")).toBe(2);
    expect(classifyTier("[youtube] 네트워크 오류: fetch failed")).toBe(2);
    expect(classifyTier("[today-review-llm] API error body: x")).toBe(2);
  });

  it("[client-error]는 Tier 1이다", () => {
    expect(
      classifyTier(
        '[client-error] code=QUEUE_CRASHED where=background.queue.sessions count=3 version=2.4.1 firstAt=2026-09-30T01:00:00.000Z lastAt=2026-09-30T01:10:00.000Z anonymousId="3f2b8c1e-1111-4222-8333-444455556666"',
      ),
    ).toBe(1);
  });

  it("알려지지 않은 접두사는 방어적으로 Tier 1로 취급한다", () => {
    expect(classifyTier("[뭔가 새로운 실패]")).toBe(1);
  });
});

describe("fingerprint — 같은 종류의 에러는 동적 값이 달라도 같은 지문", () => {
  it("trace ID만 다른 줄은 같은 지문이다(16진수·10진수 모두)", () => {
    const base = '[Error] POST /api/sessions : DB 오류 anonymousId="a"';
    expect(
      fingerprint(
        `${base} dd.trace_id=69a1b2c3d4e5f60718293a4b5c6d7e8f dd.span_id=111`,
      ),
    ).toBe(
      fingerprint(
        `${base} dd.trace_id=ffeeddccbbaa99887766554433221100 dd.span_id=222`,
      ),
    );
    expect(fingerprint(`${base} dd.trace_id=123456789 dd.span_id=1`)).toBe(
      fingerprint(base),
    );
  });

  it("숫자만 다른 두 에러 메시지는 같은 지문을 갖는다", () => {
    const a = "[Error] PATCH /api/sessions/12345/feedback-viewed : no row";
    const b = "[Error] PATCH /api/sessions/98765/feedback-viewed : no row";

    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("UUID만 다른 두 에러 메시지는 같은 지문을 갖는다", () => {
    const a =
      "[Error] POST /api/video-events : dup eventId 11111111-1111-1111-1111-111111111111";
    const b =
      "[Error] POST /api/video-events : dup eventId 22222222-2222-2222-2222-222222222222";

    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("서로 다른 종류의 에러는 다른 지문을 갖는다", () => {
    const a = "[Error] POST /api/sessions : database is locked";
    const b = "[Error] GET /api/video-events : no such table";

    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it("UUID가 아닌 anonymousId만 다른 두 줄은 같은 지문을 갖는다", () => {
    const a = '[access] POST /api/video-events 404 anonymousId="abc-xyz"';
    const b = '[access] POST /api/video-events 404 anonymousId="a\\"b c"';

    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("경로의 참여 코드만 다른 두 줄은 대소문자·길이와 무관하게 같은 지문을 갖는다", () => {
    const a = "[access] GET /api/participants/QWE-K7M2 404";
    const b = "[access] GET /api/participants/asd-xyzw9 404";

    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("새 형식(VL) 참여 코드도 이전 코드와 같은 지문으로 지운다", () => {
    const a = "[access] GET /api/participants/VL-K7M2 404";
    const b = "[access] GET /api/participants/qwe-k7m2 404";

    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("참여 코드가 아닌 짧은 단어+하이픈 경로는 지우지 않는다", () => {
    const a = "[access] POST /api/participants/study-end-review-event 404";
    const b = "[access] POST /api/participants/study-foo-review-event 404";

    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it("식별자를 지운 뒤에도 경로가 다른 에러는 다른 지문을 갖는다", () => {
    const a = '[access] POST /api/video-events 404 anonymousId="abc"';
    const b = '[access] POST /api/popup-events 404 anonymousId="abc"';

    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
});

describe("[client-error] — 추출·지문", () => {
  it("추출 대상에 포함된다", () => {
    expect(
      extractErrorLines(
        '[client-error] code=QUEUE_CRASHED where=background.queue.sessions count=3 version=2.4.1 firstAt=2026-09-30T01:00:00.000Z lastAt=2026-09-30T01:10:00.000Z anonymousId="3f2b8c1e-1111-4222-8333-444455556666"\n일반 로그',
      ),
    ).toHaveLength(1);
  });

  it("참여자·횟수·시각만 다른 같은 오류는 같은 지문을 갖는다", () => {
    const a =
      '[client-error] code=QUEUE_CRASHED where=background.queue.sessions count=3 version=2.4.1 firstAt=2026-09-30T01:00:00.000Z lastAt=2026-09-30T01:10:00.000Z anonymousId="3f2b8c1e-1111-4222-8333-444455556666"';
    const b = a
      .replace("count=3", "count=17")
      .replace(/2026-09-30T01/g, "2026-10-02T13")
      .replace(/anonymousId=.*$/, 'anonymousId="other-user"');

    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("where가 다르면 다른 지문을 갖는다", () => {
    const a =
      '[client-error] code=QUEUE_CRASHED where=background.queue.sessions count=3 version=2.4.1 firstAt=2026-09-30T01:00:00.000Z lastAt=2026-09-30T01:10:00.000Z anonymousId="3f2b8c1e-1111-4222-8333-444455556666"';
    const b = a.replace("queue.sessions", "queue.watch_stats");

    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
});

describe("summarizeAlertLine — 외부 알림에는 안전한 항목만 남긴다", () => {
  it("확장 오류는 접두사·code·where만 남기고 anonymousId·시각은 버린다", () => {
    expect(
      summarizeAlertLine(
        '[client-error] code=QUEUE_CRASHED where=background.queue.sessions count=3 version=2.4.1 firstAt=2026-09-30T01:00:00.000Z lastAt=2026-09-30T01:10:00.000Z anonymousId="3f2b8c1e-1111-4222-8333-444455556666"',
      ),
    ).toBe("[client-error] code=QUEUE_CRASHED where=background.queue.sessions");
  });

  it("접근 로그는 접두사·메서드·상태 코드만 남긴다", () => {
    expect(
      summarizeAlertLine(
        '[access] PATCH /api/sessions/1759123456789/feedback-viewed 404 anonymousId="3f2b8c1e-1111-4222-8333-444455556666"',
      ),
    ).toBe("[access] PATCH 404");
  });

  it("에러 로그는 접두사·메서드만 남기고 에러 문구는 버린다", () => {
    expect(
      summarizeAlertLine(
        '[Error] POST /api/video-events : dup eventId 11111111-1111-1111-1111-111111111111 anonymousId="a\\"b c"',
      ),
    ).toBe("[Error] POST");
  });

  it("스택이 붙은 에러 로그도 스택 없이 접두사·메서드만 남긴다", () => {
    expect(
      summarizeAlertLine(
        '[Error] POST /api/sessions : DB 오류 stack="Error: DB 오류\\n    at handler (/home/ubuntu/youtube-bias-feedback/server/routes/sessions.js:120:11)"',
      ),
    ).toBe("[Error] POST");
  });

  it("trace ID는 외부 알림 요약에 나가지 않는다", () => {
    expect(
      summarizeAlertLine(
        "[access] POST /api/sessions 404 dd.trace_id=69a1b2c3d4e5f60718293a4b5c6d7e8f dd.span_id=111",
      ),
    ).toBe("[access] POST 404");
  });

  it("외부 API 실패는 상태 코드를 남긴다", () => {
    expect(summarizeAlertLine("[youtube] API 오류: 403")).toBe(
      "[youtube] API 오류: 403",
    );
  });

  it("메서드·상태 코드가 없는 줄은 접두사만 남긴다", () => {
    expect(
      summarizeAlertLine("[sessions] 오늘 리뷰 생성 오류: QWE-K7M2 처리 실패"),
    ).toBe("[sessions] 오늘 리뷰 생성 오류:");
  });

  it("알 수 없는 접두사는 원문 없이 (unknown)으로 표시한다", () => {
    expect(summarizeAlertLine("something QWE-K7M2 GET 500")).toBe(
      "(unknown) 500",
    );
  });
});

describe("buildAlertDetail — Healthchecks.io 본문에 식별자가 섞이지 않는다", () => {
  it("식별자가 담긴 원문으로 만든 본문에도 식별자가 없다", () => {
    const detail = buildAlertDetail([
      {
        fingerprint: "7d41f0c9a2",
        count: 3,
        isNew: true,
        message:
          '[access] GET /api/participants/QWE-K7M2 404 anonymousId="3f2b8c1e-1111-4222-8333-444455556666"',
      },
      {
        fingerprint: "3a9c1e02bd",
        count: 12,
        isNew: false,
        message:
          "[Error] PATCH /api/sessions/1759123456789/feedback-viewed : asd-3f9q 없음",
      },
    ]);

    for (const id of [
      "3f2b8c1e-1111-4222-8333-444455556666",
      "1759123456789",
      "QWE-K7M2",
      "asd-3f9q",
      "/api/",
    ]) {
      expect(detail).not.toContain(id);
    }
    expect(detail).toBe(
      "[신규 x3] [access] GET 404 (fp:7d41f0c9a2)\n[재발 x12] [Error] PATCH (fp:3a9c1e02bd)",
    );
  });
});

// fs 대신 가짜 fsImpl을 주입해, 실제 OS의 inode 재사용 여부와 무관하게
// 로테이션 감지 로직을 결정론적으로 검증한다.
function fakeFs({ exists = true, size, ino, content }) {
  return {
    existsSync: () => exists,
    statSync: () => ({ size, ino }),
    openSync: () => "fd",
    readSync: (_fd, buffer, _offset, length, position) => {
      const slice = Buffer.from(content, "utf8").subarray(
        position,
        position + length,
      );
      slice.copy(buffer);
      return slice.length;
    },
    closeSync: () => {},
  };
}

describe("readNewText — 커서 이후만 읽기 + 로테이션 대응", () => {
  it("파일이 없으면 ok:false와 이유를 반환한다(무음 성공 처리 방지)", () => {
    const fsImpl = fakeFs({ exists: false, size: 0, ino: 1, content: "" });

    const result = readNewText("/no/such/file.log", {}, fsImpl);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("/no/such/file.log");
    expect(result.text).toBe("");
    expect(result.cursor).toEqual({ inode: null, offset: 0 });
  });

  it("파일을 여는 도중 예외가 나도(권한 문제 등) ok:false로 안전하게 반환한다", () => {
    const fsImpl = fakeFs({ size: 10, ino: 100, content: "[Error] x\n" });
    fsImpl.openSync = () => {
      throw new Error("EACCES: permission denied");
    };

    const result = readNewText("/log", {}, fsImpl);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("permission denied");
  });

  it("커서가 없으면(최초 실행) 파일 전체를 읽는다", () => {
    const content = "[Error] first\n";
    const fsImpl = fakeFs({ size: content.length, ino: 100, content });

    const result = readNewText("/log", {}, fsImpl);

    expect(result.ok).toBe(true);
    expect(result.text).toBe(content);
    expect(result.cursor).toEqual({ inode: 100, offset: content.length });
  });

  it("커서 이후 추가된 바이트만 읽는다", () => {
    const content = "[Error] first\n[Error] second\n";
    const prevOffset = "[Error] first\n".length;
    const fsImpl = fakeFs({ size: content.length, ino: 100, content });

    const result = readNewText(
      "/log",
      { inode: 100, offset: prevOffset },
      fsImpl,
    );

    expect(result.text).toBe("[Error] second\n");
  });

  it("새로 추가된 내용이 없으면 빈 텍스트를 반환한다", () => {
    const content = "[Error] first\n";
    const fsImpl = fakeFs({ size: content.length, ino: 100, content });

    const result = readNewText(
      "/log",
      { inode: 100, offset: content.length },
      fsImpl,
    );

    expect(result.text).toBe("");
    expect(result.cursor.offset).toBe(content.length);
  });

  it("inode가 바뀌면(로그 로테이션) 커서를 0으로 리셋해 새 파일 전체를 읽는다", () => {
    const content = "[Error] after rotation\n";
    const fsImpl = fakeFs({ size: content.length, ino: 200, content });

    const result = readNewText("/log", { inode: 100, offset: 9999 }, fsImpl);

    expect(result.text).toBe(content);
    expect(result.cursor).toEqual({ inode: 200, offset: content.length });
  });

  it("저장된 offset이 현재 파일 크기보다 크면(로테이션 방증) 리셋한다", () => {
    const content = "[Error] short\n";
    const fsImpl = fakeFs({ size: content.length, ino: 100, content });

    const result = readNewText(
      "/log",
      { inode: 100, offset: content.length + 500 },
      fsImpl,
    );

    expect(result.text).toBe(content);
  });
});

describe("decideAlerts — 지문 + 쿨다운 기반 중복 알림 방지", () => {
  it("에러가 없으면 알림도 없고 기존 지문 상태를 그대로 유지한다", () => {
    const prev = { abc: { firstSeenAt: 0, lastAlertedAt: 0, count: 3 } };

    const { alerts, fingerprints } = decideAlerts([], prev, 1000);

    expect(alerts).toEqual([]);
    expect(fingerprints).toEqual(prev);
  });

  it("처음 보는 에러는 즉시 알림 대상이다", () => {
    const line = "[Error] POST /api/sessions : database is locked";

    const { alerts, fingerprints } = decideAlerts([line], {}, 1000);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ message: line, count: 1, isNew: true });
    expect(fingerprints[alerts[0].fingerprint]).toEqual({
      firstSeenAt: 1000,
      lastAlertedAt: 1000,
      count: 1,
    });
  });

  it("같은 실행 안에서 동일 에러가 여러 번 나오면 하나로 묶어 횟수만 합산한다", () => {
    const line = "[Error] POST /api/sessions : database is locked";

    const { alerts } = decideAlerts([line, line, line], {}, 1000);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].count).toBe(3);
  });

  it("쿨다운 안에서 같은 에러가 다시 나오면 알림을 억제하되 누적 횟수는 계속 센다", () => {
    const line = "[Error] POST /api/sessions : database is locked";
    const cooldownMs = 30 * 60 * 1000;
    const first = decideAlerts([line], {}, 0, cooldownMs);

    const second = decideAlerts(
      [line],
      first.fingerprints,
      cooldownMs - 1, // 쿨다운이 채 지나지 않은 시점
      cooldownMs,
    );

    expect(second.alerts).toEqual([]);
    const fp = Object.keys(second.fingerprints)[0];
    expect(second.fingerprints[fp].count).toBe(2);
    expect(second.fingerprints[fp].lastAlertedAt).toBe(0); // 갱신되지 않음
  });

  it("쿨다운이 지나 같은 에러가 다시 나오면 누적 횟수와 함께 재알림한다", () => {
    const line = "[Error] POST /api/sessions : database is locked";
    const cooldownMs = 30 * 60 * 1000;
    const first = decideAlerts([line], {}, 0, cooldownMs);
    const second = decideAlerts(
      [line],
      first.fingerprints,
      cooldownMs - 1,
      cooldownMs,
    ); // 쿨다운 내 억제, count=2 누적

    const third = decideAlerts(
      [line],
      second.fingerprints,
      cooldownMs + 1, // 쿨다운 경과
      cooldownMs,
    );

    expect(third.alerts).toHaveLength(1);
    expect(third.alerts[0]).toMatchObject({ count: 3, isNew: false });
  });

  it("서로 다른 에러는 독립적으로 판정된다", () => {
    const a = "[Error] POST /api/sessions : database is locked";
    const b = "[Error] GET /api/video-events : no such table";

    const { alerts } = decideAlerts([a, b], {}, 1000);

    expect(alerts).toHaveLength(2);
    expect(new Set(alerts.map((x) => x.fingerprint)).size).toBe(2);
  });

  describe("Tier 2(외부 API 실패) — 임계값 미만이면 알리지 않는다", () => {
    const line = "[youtube] API 오류: 403";

    it("이번 실행에서 임계값(기본 5회) 미만이면 알리지 않고 상태도 남기지 않는다", () => {
      const lines = Array(4).fill(line);

      const { alerts, fingerprints } = decideAlerts(lines, {}, 1000);

      expect(alerts).toEqual([]);
      expect(fingerprints).toEqual({});
    });

    it("이번 실행에서 임계값(기본 5회) 이상이면 즉시 알린다", () => {
      const lines = Array(5).fill(line);

      const { alerts } = decideAlerts(lines, {}, 1000);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ message: line, count: 5, isNew: true });
    });

    it("커스텀 임계값을 넘기면 그 값을 기준으로 판정한다", () => {
      const lines = Array(2).fill(line);

      const belowCustom = decideAlerts(lines, {}, 1000, 30 * 60 * 1000, 3);
      const atCustom = decideAlerts(
        Array(3).fill(line),
        {},
        1000,
        30 * 60 * 1000,
        3,
      );

      expect(belowCustom.alerts).toEqual([]);
      expect(atCustom.alerts).toHaveLength(1);
    });

    it("Tier 1([Error])은 개수와 무관하게 1건도 즉시 알린다", () => {
      const tier1Line = "[Error] POST /api/sessions : database is locked";

      const { alerts } = decideAlerts([tier1Line], {}, 1000);

      expect(alerts).toHaveLength(1);
      expect(alerts[0].isNew).toBe(true);
    });
  });
});

describe("shouldPersistState — ping이 진짜로 성공/스킵했을 때만 상태 저장을 허용", () => {
  it("전송에 성공하면(ok:true) 저장을 허용한다", () => {
    expect(shouldPersistState({ skipped: false, ok: true })).toBe(true);
  });

  it("ping URL이 없어 애초에 안 보냈으면(skipped:true) 저장을 허용한다", () => {
    expect(shouldPersistState({ skipped: true, ok: false })).toBe(true);
  });

  it("실제로 전송을 시도했다가 실패했으면(ok:false, skipped:false) 저장을 막는다", () => {
    expect(
      shouldPersistState({ skipped: false, ok: false, error: "network down" }),
    ).toBe(false);
  });
});
