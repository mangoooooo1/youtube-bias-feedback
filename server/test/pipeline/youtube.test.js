import { describe, it, expect, afterEach, vi } from "vitest";
import {
  fetchVideoMetadata,
  fetchChannelMetadata,
  parseIso8601Duration,
  normalizeTopicCategories,
} from "../../pipeline/youtube.js";

describe("parseIso8601Duration", () => {
  it("시/분/초가 모두 있으면 초 단위로 변환한다", () => {
    expect(parseIso8601Duration("PT1H43M20S")).toBe(6200);
  });

  it("초만 있으면 그대로 변환한다(쇼츠 케이스)", () => {
    expect(parseIso8601Duration("PT45S")).toBe(45);
  });

  it("형식이 예상과 다르면 null을 반환한다", () => {
    expect(parseIso8601Duration("P0D")).toBeNull();
    expect(parseIso8601Duration(undefined)).toBeNull();
  });
});

describe("normalizeTopicCategories", () => {
  it("배열을 정렬한 뒤 JSON 문자열로 반환한다(채널마다 다른 순서 보정)", () => {
    const result = normalizeTopicCategories([
      "https://en.wikipedia.org/wiki/Pop_music",
      "https://en.wikipedia.org/wiki/Music",
    ]);
    expect(result).toBe(
      JSON.stringify([
        "https://en.wikipedia.org/wiki/Music",
        "https://en.wikipedia.org/wiki/Pop_music",
      ]),
    );
  });

  it("빈 배열/미존재면 null을 반환한다", () => {
    expect(normalizeTopicCategories([])).toBeNull();
    expect(normalizeTopicCategories(undefined)).toBeNull();
  });
});

describe("fetchVideoMetadata", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("snippet/contentDetails/statistics를 파싱해 videoId 기준 맵으로 반환한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "abc123",
            snippet: {
              categoryId: "25",
              title: "뉴스 영상",
              channelId: "chan1",
              description: "설명 원문",
            },
            contentDetails: { duration: "PT1H43M20S" },
            statistics: { viewCount: "1234" },
          },
        ],
      }),
    });

    const result = await fetchVideoMetadata(["abc123"], "test-key");

    expect(result).toEqual({
      abc123: {
        categoryId: "25",
        title: "뉴스 영상",
        durationSeconds: 6200,
        viewCount: 1234,
        channelId: "chan1",
        description: "설명 원문",
      },
    });
  });

  it("삭제/비공개 등으로 items에 없는 videoId는 null로 남는다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });

    const result = await fetchVideoMetadata(["deleted1"], "test-key");
    expect(result).toEqual({ deleted1: null });
  });

  it("50개 초과 videoId는 50개씩 나눠 여러 번 호출한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    global.fetch = fetchMock;

    const ids = Array.from({ length: 120 }, (_, i) => `v${i}`);
    await fetchVideoMetadata(ids, "test-key");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const firstUrl = fetchMock.mock.calls[0][0];
    const firstIdParam = new URL(firstUrl).searchParams.get("id");
    expect(firstIdParam.split(",")).toHaveLength(50);
  });

  it("중복 videoId는 API 호출 전에 제거된다", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    global.fetch = fetchMock;

    await fetchVideoMetadata(["dup", "dup", "dup"], "test-key");

    const url = fetchMock.mock.calls[0][0];
    expect(new URL(url).searchParams.get("id")).toBe("dup");
  });

  it("HTTP 오류 응답이면 요청한 모든 videoId를 null로 반환한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });

    const result = await fetchVideoMetadata(["v1", "v2"], "test-key");
    expect(result).toEqual({ v1: null, v2: null });
  });

  it("네트워크 오류(fetch reject)면 요청한 모든 videoId를 null로 반환한다", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("network down"));

    const result = await fetchVideoMetadata(["v1"], "test-key");
    expect(result).toEqual({ v1: null });
  });
});

describe("fetchChannelMetadata", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("snippet/statistics/topicDetails/brandingSettings를 파싱해 channelId 기준 맵으로 반환한다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "chan1",
            snippet: { title: "SBS 뉴스" },
            statistics: { subscriberCount: "1000000", videoCount: "500" },
            topicDetails: {
              topicCategories: [
                "https://en.wikipedia.org/wiki/Society",
                "https://en.wikipedia.org/wiki/Politics",
              ],
            },
            brandingSettings: {
              channel: { keywords: "뉴스 SBS 리포트" },
            },
          },
        ],
      }),
    });

    const result = await fetchChannelMetadata(["chan1"], "test-key");

    expect(result).toEqual({
      chan1: {
        channelTitle: "SBS 뉴스",
        subscriberCount: 1000000,
        videoCount: 500,
        topicCategories: JSON.stringify(
          [
            "https://en.wikipedia.org/wiki/Politics",
            "https://en.wikipedia.org/wiki/Society",
          ].sort(),
        ),
        keywords: "뉴스 SBS 리포트",
      },
    });
  });

  it("구독자 수 비공개 채널(hiddenSubscriberCount)은 subscriberCount가 null이다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "chan2",
            snippet: { title: "비공개 구독자 채널" },
            statistics: { hiddenSubscriberCount: true, videoCount: "10" },
          },
        ],
      }),
    });

    const result = await fetchChannelMetadata(["chan2"], "test-key");
    expect(result.chan2.subscriberCount).toBeNull();
  });

  it("존재하지 않는 channelId는 null로 남는다", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });

    const result = await fetchChannelMetadata(["nope"], "test-key");
    expect(result).toEqual({ nope: null });
  });
});
