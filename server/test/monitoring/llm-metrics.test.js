import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  recordLlmCall,
  ALLOWED_TAGS,
  NO_API_KEY,
} from "../../monitoring/llm-metrics.js";
import { formatMetric } from "../../monitoring/dogstatsd.js";
import { FAILURE_REASONS } from "../../routes/sessions-validate.js";

const originalEnv = process.env.NODE_ENV;
let warnSpy;
beforeEach(() => {
  process.env.NODE_ENV = "production";
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env.NODE_ENV = originalEnv;
  warnSpy.mockRestore();
});

// 실제 허용 목록으로 한 줄을 만들어, 버려지는 태그 없이 그대로 나가는지까지 본다
function recordingClient() {
  const lines = [];
  return {
    lines,
    send: (name, value, type, tags) =>
      lines.push(formatMetric(name, value, type, tags, ALLOWED_TAGS)),
  };
}

describe("recordLlmCall", () => {
  it("성공 호출은 호출 수와 응답 시간을 보낸다", () => {
    const client = recordingClient();
    recordLlmCall(
      {
        kind: "today",
        llmStatus: "success",
        failureReason: null,
        geminiMs: 812,
        calledGemini: true,
      },
      client,
    );

    expect(client.lines).toEqual([
      "viewlens.llm.calls:1|c|#kind:today,status:success,env:production",
      "viewlens.llm.gemini_ms:812|d|#kind:today,env:production",
    ]);
  });

  it.each(FAILURE_REASONS)(
    "fallback 사유 %s가 허용 목록을 그대로 통과한다",
    (reason) => {
      const client = recordingClient();
      recordLlmCall(
        {
          kind: "period",
          llmStatus: "fallback",
          failureReason: reason,
          geminiMs: 10000,
          calledGemini: true,
        },
        client,
      );

      expect(client.lines[0]).toBe(
        `viewlens.llm.calls:1|c|#kind:period,status:fallback,failure_reason:${reason},env:production`,
      );
      expect(warnSpy).not.toHaveBeenCalled();
    },
  );

  it("키가 없어 호출하지 않았으면 사유를 no_api_key로 남기고 응답 시간은 보내지 않는다", () => {
    const client = recordingClient();
    recordLlmCall(
      {
        kind: "today",
        llmStatus: "fallback",
        failureReason: null,
        geminiMs: 0,
        calledGemini: false,
      },
      client,
    );

    expect(client.lines).toEqual([
      `viewlens.llm.calls:1|c|#kind:today,status:fallback,failure_reason:${NO_API_KEY},env:production`,
    ]);
  });

  it("참여자 정보를 같이 넘겨도 태그에 실리지 않는다", () => {
    const client = recordingClient();
    recordLlmCall(
      {
        kind: "today",
        llmStatus: "success",
        failureReason: null,
        geminiMs: 500,
        calledGemini: true,
        anonymousId: "3f2b8c1e-1111-4222-8333-444455556666",
        sessionId: "1759123456789",
      },
      client,
    );

    const sent = client.lines.join("\n");
    expect(sent).not.toContain("3f2b8c1e");
    expect(sent).not.toContain("1759123456789");
    expect(sent).not.toContain("anonymous");
  });

  it("production이 아니면 env 태그는 허용 목록에서 걸러진다", () => {
    process.env.NODE_ENV = "development";
    const client = recordingClient();
    recordLlmCall(
      {
        kind: "today",
        llmStatus: "success",
        failureReason: null,
        geminiMs: 1,
        calledGemini: true,
      },
      client,
    );

    expect(client.lines[0]).toBe(
      "viewlens.llm.calls:1|c|#kind:today,status:success",
    );
  });
});
