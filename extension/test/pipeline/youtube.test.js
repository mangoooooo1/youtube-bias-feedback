import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchVideoCategories } from "../../pipeline/youtube.js";

describe("fetchVideoCategories", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("part=snippet,topicDetails로 요청한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });

    await fetchVideoCategories(["v1"]);

    const requestedUrl = global.fetch.mock.calls[0][0];
    expect(requestedUrl).toContain("part=snippet%2CtopicDetails");
  });

  it("categoryId/topicCategories를 영상별로 반환한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "v1",
            snippet: { categoryId: "10" },
            topicDetails: {
              topicCategories: ["https://en.wikipedia.org/wiki/Music"],
            },
          },
        ],
      }),
    });

    const result = await fetchVideoCategories(["v1"]);
    expect(result).toEqual({
      v1: {
        categoryId: "10",
        topicCategories: ["https://en.wikipedia.org/wiki/Music"],
      },
    });
  });

  it("삭제/비공개 등 응답에 없는 영상은 null/빈 배열 기본값을 반환한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });

    const result = await fetchVideoCategories(["missing"]);
    expect(result).toEqual({
      missing: { categoryId: null, topicCategories: [] },
    });
  });

  it("HTTP 오류 응답이면 기본값 맵을 반환한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });

    const result = await fetchVideoCategories(["v1"]);
    expect(result.v1).toEqual({ categoryId: null, topicCategories: [] });
  });

  it("네트워크 오류면 기본값 맵을 반환한다", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("network down"));

    const result = await fetchVideoCategories(["v1"]);
    expect(result.v1).toEqual({ categoryId: null, topicCategories: [] });
  });

  it("topicDetails가 없는 영상은 topicCategories를 빈 배열로 반환한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ id: "v1", snippet: { categoryId: "20" } }],
      }),
    });

    const result = await fetchVideoCategories(["v1"]);
    expect(result.v1.topicCategories).toEqual([]);
  });
});
