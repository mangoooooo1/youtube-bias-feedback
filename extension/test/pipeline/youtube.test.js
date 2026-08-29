import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchVideoCategories } from "../../pipeline/youtube.js";

function ids(n, prefix = "v") {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

function idsFromUrl(url) {
  const params = new URL(url).searchParams;
  return params.get("id").split(",");
}

function itemsResponse(idList, categoryId = "10") {
  return {
    ok: true,
    json: async () => ({
      items: idList.map((id) => ({ id, snippet: { categoryId } })),
    }),
  };
}

describe("fetchVideoCategories — 배치 분할 및 실패 폴백", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("50개 이하면 fetch를 1회만 호출하고 각 id에 categoryId를 매핑한다", async () => {
    const videoIds = ids(30);
    global.fetch = vi.fn().mockResolvedValue(itemsResponse(videoIds));

    const result = await fetchVideoCategories(videoIds);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      Object.fromEntries(videoIds.map((id) => [id, "10"])),
    );
  });

  it("정확히 50개(배치 경계)면 단일 배치로 처리한다", async () => {
    const videoIds = ids(50);
    global.fetch = vi.fn().mockResolvedValue(itemsResponse(videoIds));

    await fetchVideoCategories(videoIds);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(idsFromUrl(global.fetch.mock.calls[0][0])).toHaveLength(50);
  });

  it("51개면 50개/1개, 두 번의 배치로 나눠 호출한다", async () => {
    const videoIds = ids(51);
    global.fetch = vi.fn().mockImplementation(async (url) => {
      const requested = idsFromUrl(url);
      return itemsResponse(requested);
    });

    const result = await fetchVideoCategories(videoIds);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(idsFromUrl(global.fetch.mock.calls[0][0])).toHaveLength(50);
    expect(idsFromUrl(global.fetch.mock.calls[1][0])).toHaveLength(1);
    expect(Object.keys(result)).toHaveLength(51);
  });

  it("빈 배열이면 fetch를 호출하지 않고 빈 객체를 반환한다", async () => {
    global.fetch = vi.fn();

    const result = await fetchVideoCategories([]);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it("API 응답에 일부 id만 있으면(삭제/비공개 영상) 나머지는 null로 유지한다", async () => {
    const videoIds = ["a", "b", "c"];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { id: "a", snippet: { categoryId: "10" } },
          { id: "c", snippet: { categoryId: "20" } },
        ],
      }),
    });

    const result = await fetchVideoCategories(videoIds);

    expect(result).toEqual({ a: "10", b: null, c: "20" });
  });

  it("response.ok가 false면 해당 청크의 모든 id를 null로 채운다", async () => {
    const videoIds = ["a", "b"];
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });

    const result = await fetchVideoCategories(videoIds);

    expect(result).toEqual({ a: null, b: null });
  });

  it("fetch 자체가 reject되면(네트워크 오류) 해당 청크의 모든 id를 null로 채운다", async () => {
    const videoIds = ["a", "b"];
    global.fetch = vi.fn().mockRejectedValue(new TypeError("network down"));

    const result = await fetchVideoCategories(videoIds);

    expect(result).toEqual({ a: null, b: null });
  });

  it("한 배치가 실패해도 다른 배치는 독립적으로 정상 처리된다", async () => {
    const videoIds = ids(51);
    global.fetch = vi.fn().mockImplementation(async (url) => {
      const requested = idsFromUrl(url);
      if (requested.length === 50) {
        return { ok: false, status: 500 };
      }
      return itemsResponse(requested);
    });

    const result = await fetchVideoCategories(videoIds);

    for (let i = 0; i < 50; i++) expect(result[`v${i}`]).toBeNull();
    expect(result.v50).toBe("10");
  });
});
