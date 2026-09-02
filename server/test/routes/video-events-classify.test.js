import { describe, it, expect } from "vitest";
import { classifyReferrerType } from "../../routes/video-events-classify.js";

describe("classifyReferrerType — entryPath 자체가 없는 경우", () => {
  it.each([
    [null, null],
    ["www.youtube.com", null], // entryHost만 있고 entryPath가 없는 비정상 조합도 unknown 우선
  ])("entryHost=%s, entryPath=%s이면 unknown을 반환한다", (entryHost, entryPath) => {
    expect(classifyReferrerType(entryHost, entryPath, null)).toEqual({
      referrerType: "unknown",
      relatedTrigger: null,
    });
  });
});

describe("classifyReferrerType — 외부 유입", () => {
  it("유튜브가 아닌 도메인이면 external을 반환한다", () => {
    expect(
      classifyReferrerType("www.google.com", "/search", null),
    ).toEqual({ referrerType: "external", relatedTrigger: null });
  });

  it("entryPath는 있는데 entryHost가 없으면 external로 본다(도메인 불명은 유튜브로 보지 않음)", () => {
    expect(classifyReferrerType(null, "/some-path", null)).toEqual({
      referrerType: "external",
      relatedTrigger: null,
    });
  });
});

describe("classifyReferrerType — 직접 검색", () => {
  it("/results면 direct_search를 반환한다", () => {
    expect(
      classifyReferrerType("www.youtube.com", "/results", null),
    ).toEqual({ referrerType: "direct_search", relatedTrigger: null });
  });
});

describe("classifyReferrerType — 홈 화면 추천", () => {
  it("/(루트)면 home_feed를 반환한다", () => {
    expect(classifyReferrerType("www.youtube.com", "/", null)).toEqual({
      referrerType: "home_feed",
      relatedTrigger: null,
    });
  });
});

describe("classifyReferrerType — 관련 동영상 추천(자동재생/클릭 구분)", () => {
  it("/watch + navigationTrigger='ended'면 related/autoplay를 반환한다", () => {
    expect(
      classifyReferrerType("www.youtube.com", "/watch", "ended"),
    ).toEqual({ referrerType: "related", relatedTrigger: "autoplay" });
  });

  it("/watch + navigationTrigger='interaction'이면 related/click을 반환한다", () => {
    expect(
      classifyReferrerType("www.youtube.com", "/watch", "interaction"),
    ).toEqual({ referrerType: "related", relatedTrigger: "click" });
  });

  it("/watch + navigationTrigger=null이면 related/unknown을 반환한다", () => {
    expect(classifyReferrerType("www.youtube.com", "/watch", null)).toEqual({
      referrerType: "related",
      relatedTrigger: "unknown",
    });
  });

  it("/shorts/도 같은 방식으로 분류한다", () => {
    expect(
      classifyReferrerType("www.youtube.com", "/shorts/abc123", "ended"),
    ).toEqual({ referrerType: "related", relatedTrigger: "autoplay" });
  });
});

describe("classifyReferrerType — 4분류 밖의 경로", () => {
  it.each(["/feed/subscriptions", "/channel/UCxxxx", "/@someChannel"])(
    "%s처럼 매핑되지 않는 경로는 unknown을 반환한다",
    (entryPath) => {
      expect(
        classifyReferrerType("www.youtube.com", entryPath, null),
      ).toEqual({ referrerType: "unknown", relatedTrigger: null });
    },
  );
});
