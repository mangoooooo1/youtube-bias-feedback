import { describe, it, expect } from "vitest";
import {
  redactHttpUrl,
  tagUserId,
  onRequestFinish,
  UNMATCHED_PATH,
} from "../tracing.js";

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

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

describe("tagUserId", () => {
  it("본문의 anonymousId를 정규화해 usr.id로 붙인다", () => {
    const span = createSpan({});

    tagUserId(span, {
      body: {
        anonymousId: `  ${UUID}
`,
      },
    });

    expect(span.tags["usr.id"]).toBe(UUID);
  });

  it("대문자 UUID도 바꾸지 않고 그대로 붙인다", () => {
    const span = createSpan({});

    tagUserId(span, { body: { anonymousId: UUID.toUpperCase() } });

    expect(span.tags["usr.id"]).toBe(UUID.toUpperCase());
  });

  it("본문이나 anonymousId가 없으면 태그를 붙이지 않는다", () => {
    const span = createSpan({});

    tagUserId(span, {});
    tagUserId(span, { body: {} });
    tagUserId(span, { body: { anonymousId: "" } });

    expect(span.tags).not.toHaveProperty("usr.id");
  });

  it("UUID 형식이 아니면 참여 코드 등이 새지 않게 태그를 붙이지 않는다", () => {
    const span = createSpan({});

    tagUserId(span, { body: { anonymousId: "VL-K7M2" } });
    tagUserId(span, { body: { anonymousId: `${UUID}x` } });
    tagUserId(span, { body: { anonymousId: { id: UUID } } });

    expect(span.tags).not.toHaveProperty("usr.id");
  });

  it("문자열이 아닌 anonymousId는 예외 없이 무시한다", () => {
    const span = createSpan({});
    // JSON 본문으로 보낼 수 있는 값들. toString이 null이면 정규화 중 예외가 나 APM 플러그인이 꺼진다
    const values = [JSON.parse('{"toString":null}'), 123, [UUID], true];

    for (const anonymousId of values) {
      expect(() => tagUserId(span, { body: { anonymousId } })).not.toThrow();
    }
    expect(span.tags).not.toHaveProperty("usr.id");
  });

  it("span이 없으면 아무것도 하지 않는다", () => {
    expect(() =>
      tagUserId(undefined, { body: { anonymousId: UUID } }),
    ).not.toThrow();
  });
});

describe("onRequestFinish", () => {
  it("usr.id를 붙이면서 http.url의 참여 코드는 계속 지운다", () => {
    const span = createSpan({
      "http.url": "http://viewlens.site/api/participants/validate?code=VL-K7M2",
      "http.route": "/api/participants/validate",
    });

    onRequestFinish(span, { body: { anonymousId: UUID } });

    expect(span.tags["usr.id"]).toBe(UUID);
    expect(span.tags["http.url"]).toBe(
      "http://viewlens.site/api/participants/validate",
    );
  });
});
