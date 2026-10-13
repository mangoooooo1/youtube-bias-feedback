import { describe, it, expect } from "vitest";
import {
  buildAllowedOrigins,
  isAllowedOrigin,
} from "../../middleware/corsPolicy.js";

// 상수를 불러오지 않고 직접 적어, 게시 확장 ID가 바뀌면 테스트가 잡아내게 한다
const VIEWLENS_ORIGIN = "chrome-extension://hdoachgdmhdlbgbacaffihocdjagjecp";

describe("isAllowedOrigin — 기본 허용 목록", () => {
  const allowed = buildAllowedOrigins({ NODE_ENV: "production" });

  it("origin이 없는 요청(curl, 헬스체크)은 허용한다", () => {
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
  });

  it("게시된 ViewLens 확장은 허용한다", () => {
    expect(isAllowedOrigin(VIEWLENS_ORIGIN, allowed)).toBe(true);
  });

  it("다른 확장 ID는 거부한다", () => {
    expect(
      isAllowedOrigin(
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        allowed,
      ),
    ).toBe(false);
  });

  it.each([
    "https://www.youtube.com",
    "https://m.youtube.com",
    "https://youtube.com",
  ])("유튜브 출처 %s는 허용한다", (origin) => {
    expect(isAllowedOrigin(origin, allowed)).toBe(true);
  });

  it("http 스킴의 유튜브는 거부한다", () => {
    expect(isAllowedOrigin("http://www.youtube.com", allowed)).toBe(false);
  });

  it.each([
    "https://evil-youtube.com",
    "https://youtube.com.evil.com",
    "https://www.youtube.com:8443",
  ])("유튜브를 흉내 낸 출처 %s는 거부한다", (origin) => {
    expect(isAllowedOrigin(origin, allowed)).toBe(false);
  });

  it("자체 도메인 viewlens.site는 허용한다", () => {
    expect(isAllowedOrigin("https://viewlens.site", allowed)).toBe(true);
  });
});

describe("buildAllowedOrigins — DEV_EXTENSION_ID", () => {
  const DEV_ORIGIN = "chrome-extension://abc";

  it("development에서는 개발용 확장 ID를 허용한다", () => {
    const allowed = buildAllowedOrigins({
      NODE_ENV: "development",
      DEV_EXTENSION_ID: "abc",
    });
    expect(isAllowedOrigin(DEV_ORIGIN, allowed)).toBe(true);
  });

  it("production에서는 개발용 확장 ID를 거부한다", () => {
    const allowed = buildAllowedOrigins({
      NODE_ENV: "production",
      DEV_EXTENSION_ID: "abc",
    });
    expect(isAllowedOrigin(DEV_ORIGIN, allowed)).toBe(false);
  });

  // 현재 동작 기록: production이 아니면 허용하므로 NODE_ENV 없이 실행한 로컬 서버도 허용한다
  it("NODE_ENV가 없으면 개발용 확장 ID를 허용한다", () => {
    const allowed = buildAllowedOrigins({ DEV_EXTENSION_ID: "abc" });
    expect(isAllowedOrigin(DEV_ORIGIN, allowed)).toBe(true);
  });
});
