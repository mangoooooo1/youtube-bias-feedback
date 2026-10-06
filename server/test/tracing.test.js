import { describe, it, expect } from "vitest";
import { redactHttpUrl, UNMATCHED_PATH } from "../tracing.js";

function createSpan(tags, { withGetTag = true } = {}) {
  const context = withGetTag ? { getTag: (key) => tags[key] } : {};
  return {
    tags,
    context: () => context,
    setTag(key, value) {
      tags[key] = value;
    },
  };
}

describe("redactHttpUrl", () => {
  it("쿼리스트링의 참여 코드를 지우고 라우트 패턴만 남긴다", () => {
    const span = createSpan({
      "http.url": "http://viewlens.site/api/participants/validate?code=ABC123",
      "http.route": "/api/participants/validate",
    });

    redactHttpUrl(span);

    expect(span.tags["http.url"]).toBe(
      "http://viewlens.site/api/participants/validate",
    );
  });

  it("경로 속 sessionId를 라우트 패턴으로 바꾼다", () => {
    const span = createSpan({
      "http.url":
        "http://viewlens.site/api/sessions/1759123456789/feedback-viewed",
      "http.route": "/api/sessions/:sessionId/feedback-viewed",
    });

    redactHttpUrl(span);

    expect(span.tags["http.url"]).toBe(
      "http://viewlens.site/api/sessions/:sessionId/feedback-viewed",
    );
  });

  it("매칭된 라우트가 없으면 실제 경로를 남기지 않는다", () => {
    const span = createSpan({
      "http.url": "http://viewlens.site/unknown/abc-123?x=1",
    });

    redactHttpUrl(span);

    expect(span.tags["http.url"]).toBe(`http://viewlens.site${UNMATCHED_PATH}`);
  });

  it("원본 URL을 파싱할 수 없으면 origin 없이 라우트 패턴만 남긴다", () => {
    const span = createSpan({ "http.route": "/api/popup-events" });

    redactHttpUrl(span);

    expect(span.tags["http.url"]).toBe("/api/popup-events");
  });

  it("span context에서 태그를 읽을 수 없으면 경로 없이 기록한다", () => {
    const span = createSpan(
      { "http.url": "http://viewlens.site/api/participants/validate?code=X" },
      { withGetTag: false },
    );

    redactHttpUrl(span);

    expect(span.tags["http.url"]).toBe(UNMATCHED_PATH);
  });

  it("span이 없으면 아무것도 하지 않는다", () => {
    expect(() => redactHttpUrl(undefined)).not.toThrow();
  });
});
