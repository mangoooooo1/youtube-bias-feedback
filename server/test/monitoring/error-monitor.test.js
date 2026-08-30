import { describe, it, expect } from "vitest";
import {
  extractErrorLines,
  fingerprint,
  readNewText,
  decideAlerts,
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

  it("에러 라인이 없으면 빈 배열을 반환한다", () => {
    expect(extractErrorLines("all good\nnothing here\n")).toEqual([]);
  });

  it("빈 텍스트에도 크래시하지 않는다", () => {
    expect(extractErrorLines("")).toEqual([]);
  });
});

describe("fingerprint — 같은 종류의 에러는 동적 값이 달라도 같은 지문", () => {
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
  it("파일이 없으면 빈 텍스트와 offset 0을 반환한다", () => {
    const fsImpl = fakeFs({ exists: false, size: 0, ino: 1, content: "" });

    const result = readNewText("/no/such/file.log", {}, fsImpl);

    expect(result).toEqual({ text: "", cursor: { inode: null, offset: 0 } });
  });

  it("커서가 없으면(최초 실행) 파일 전체를 읽는다", () => {
    const content = "[Error] first\n";
    const fsImpl = fakeFs({ size: content.length, ino: 100, content });

    const result = readNewText("/log", {}, fsImpl);

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

    const result = readNewText(
      "/log",
      { inode: 100, offset: 9999 },
      fsImpl,
    );

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
});
