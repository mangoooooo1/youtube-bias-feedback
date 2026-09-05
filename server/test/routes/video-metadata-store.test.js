import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";
import {
  ensureVideoMetadata,
  findMissingVideoIds,
  findMissingChannelIds,
  upsertChannelMetadata,
  upsertVideoMetadata,
} from "../../routes/video-metadata-store.js";

// video-metadata-store.js는 CommonJS require()로 pipeline/youtube.js를 불러오는데,
// 이 저장소의 vitest 설정에서는 require() 호출이 vi.mock()의 가로채기를 우회한다
// 그래서 today-review-generate.test.js와 동일하게 global.fetch를 스텁해 실제 모듈이 그 스텁을 타고 동작하게 한다.
function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE channel_metadata (
      channelId       TEXT PRIMARY KEY,
      channelTitle    TEXT,
      subscriberCount INTEGER,
      videoCount      INTEGER,
      topicCategories TEXT,
      keywords        TEXT
    );
    CREATE TABLE video_metadata (
      videoId         TEXT PRIMARY KEY,
      categoryId      TEXT,
      title           TEXT,
      durationSeconds INTEGER,
      viewCount       INTEGER,
      channelId       TEXT,
      description     TEXT,
      FOREIGN KEY (channelId) REFERENCES channel_metadata(channelId)
    );
  `);
  return db;
}

describe("findMissingVideoIds / findMissingChannelIds", () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });

  it("캐시에 없는 id만 반환한다", () => {
    upsertChannelMetadata(db, "chan1", { channelTitle: "채널1" });
    upsertVideoMetadata(db, "v1", { categoryId: "10", channelId: "chan1" });

    expect(findMissingVideoIds(db, ["v1", "v2"])).toEqual(["v2"]);
    expect(findMissingChannelIds(db, ["chan1", "chan2"])).toEqual(["chan2"]);
  });

  it("중복 id는 한 번만 결과에 담는다", () => {
    expect(findMissingVideoIds(db, ["v1", "v1", "v2"])).toEqual(["v1", "v2"]);
  });
});

describe("upsertChannelMetadata / upsertVideoMetadata", () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });

  it("data가 null이면 id만 있는 빈 행을 남긴다(확정 결측)", () => {
    upsertChannelMetadata(db, "chan1", null);
    const row = db
      .prepare("SELECT * FROM channel_metadata WHERE channelId = ?")
      .get("chan1");
    expect(row).toEqual({
      channelId: "chan1",
      channelTitle: null,
      subscriberCount: null,
      videoCount: null,
      topicCategories: null,
      keywords: null,
    });
  });

  it("이미 존재하는 id를 다시 upsert해도 덮어쓰지 않는다(스냅샷 고정, 동시 요청 안전)", () => {
    upsertVideoMetadata(db, "v1", { categoryId: "10", title: "원본" });
    upsertVideoMetadata(db, "v1", {
      categoryId: "99",
      title: "덮어쓰기 시도",
    });

    const row = db
      .prepare("SELECT categoryId, title FROM video_metadata WHERE videoId = ?")
      .get("v1");
    expect(row).toEqual({ categoryId: "10", title: "원본" });
  });

  it("channel_metadata에 없는 channelId를 참조하는 video_metadata는 FK 위반으로 거부된다", () => {
    expect(() =>
      upsertVideoMetadata(db, "v1", {
        categoryId: "10",
        channelId: "no-such-channel",
      }),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe("ensureVideoMetadata", () => {
  let db;
  const originalFetch = global.fetch;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("apiKey가 없으면 아무 것도 하지 않는다(fetch 호출 안 함)", async () => {
    global.fetch = vi.fn();
    await ensureVideoMetadata(db, ["v1"], undefined);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("이미 캐시된 videoId만 있으면 API를 호출하지 않는다", async () => {
    upsertChannelMetadata(db, "chan1", { channelTitle: "채널1" });
    upsertVideoMetadata(db, "v1", { categoryId: "10", channelId: "chan1" });
    global.fetch = vi.fn();

    await ensureVideoMetadata(db, ["v1"], "test-key");

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("정상 케이스 — channel_metadata를 먼저 넣고 video_metadata를 넣는다(FK 순서)", async () => {
    global.fetch = vi.fn((url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/videos")) {
        return Promise.resolve(
          jsonResponse({
            items: [
              {
                id: "v1",
                snippet: {
                  categoryId: "10",
                  title: "영상1",
                  channelId: "chan1",
                },
                contentDetails: { duration: "PT5M" },
                statistics: { viewCount: "100" },
              },
            ],
          }),
        );
      }
      if (path.endsWith("/channels")) {
        return Promise.resolve(
          jsonResponse({
            items: [{ id: "chan1", snippet: { title: "채널1" } }],
          }),
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });

    await ensureVideoMetadata(db, ["v1"], "test-key");

    // videos.list가 channels.list보다 먼저 호출됐는지(호출 순서) 확인
    const calledPaths = global.fetch.mock.calls.map(
      ([url]) => new URL(url).pathname,
    );
    expect(calledPaths).toEqual(["/youtube/v3/videos", "/youtube/v3/channels"]);

    const channelRow = db
      .prepare("SELECT channelTitle FROM channel_metadata WHERE channelId = ?")
      .get("chan1");
    expect(channelRow.channelTitle).toBe("채널1");

    const videoRow = db
      .prepare(
        "SELECT categoryId, channelId FROM video_metadata WHERE videoId = ?",
      )
      .get("v1");
    expect(videoRow).toEqual({ categoryId: "10", channelId: "chan1" });
  });

  it("이미 캐시된 channelId를 참조하면 channels.list를 다시 호출하지 않는다", async () => {
    upsertChannelMetadata(db, "chan1", { channelTitle: "기존 채널" });
    global.fetch = vi.fn((url) => {
      if (new URL(url).pathname.endsWith("/channels")) {
        throw new Error("channels.list가 호출되면 안 된다");
      }
      return Promise.resolve(
        jsonResponse({
          items: [
            { id: "v1", snippet: { categoryId: "10", channelId: "chan1" } },
          ],
        }),
      );
    });

    await ensureVideoMetadata(db, ["v1"], "test-key");

    const videoRow = db
      .prepare("SELECT channelId FROM video_metadata WHERE videoId = ?")
      .get("v1");
    expect(videoRow.channelId).toBe("chan1");
  });

  it("확정 결측(null) videoId는 channelId 없이 빈 행으로 캐싱한다", async () => {
    global.fetch = vi.fn((url) => {
      if (new URL(url).pathname.endsWith("/channels")) {
        throw new Error("channels.list가 호출되면 안 된다");
      }
      return Promise.resolve(jsonResponse({ items: [] }));
    });

    await ensureVideoMetadata(db, ["deleted1"], "test-key");

    const row = db
      .prepare("SELECT * FROM video_metadata WHERE videoId = ?")
      .get("deleted1");
    expect(row.channelId).toBeNull();
  });

  it("videos.list 청크 전체가 실패하면 아무 것도 캐싱하지 않는다 — 다음에 재시도", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });

    await ensureVideoMetadata(db, ["v1"], "test-key");

    const row = db
      .prepare("SELECT * FROM video_metadata WHERE videoId = ?")
      .get("v1");
    expect(row).toBeUndefined();
  });

  it("channels.list 청크 전체가 실패하면 그 채널을 참조하는 videoId는 이번엔 캐싱하지 않는다(다른 이미 캐시된 채널의 영상은 정상 캐싱)", async () => {
    // chan_ok는 이미 캐시돼 있어 channels.list 대상에서 제외되고, chan_fail만 조회 대상이 된다.
    upsertChannelMetadata(db, "chan_ok", { channelTitle: "정상 채널" });

    global.fetch = vi.fn((url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/videos")) {
        return Promise.resolve(
          jsonResponse({
            items: [
              {
                id: "v1",
                snippet: { categoryId: "10", channelId: "chan_fail" },
              },
              {
                id: "v2",
                snippet: { categoryId: "20", channelId: "chan_ok" },
              },
            ],
          }),
        );
      }
      // chan_fail 조회(channels.list) 자체가 실패
      return Promise.resolve({ ok: false, status: 500 });
    });

    await ensureVideoMetadata(db, ["v1", "v2"], "test-key");

    const v1Row = db
      .prepare("SELECT * FROM video_metadata WHERE videoId = ?")
      .get("v1");
    expect(v1Row).toBeUndefined();

    const v2Row = db
      .prepare("SELECT channelId FROM video_metadata WHERE videoId = ?")
      .get("v2");
    expect(v2Row.channelId).toBe("chan_ok");
  });

  it("channelId가 없는 영상(null)은 채널 조회 없이 바로 캐싱한다", async () => {
    global.fetch = vi.fn((url) => {
      if (new URL(url).pathname.endsWith("/channels")) {
        throw new Error("channels.list가 호출되면 안 된다");
      }
      return Promise.resolve(
        jsonResponse({
          items: [{ id: "v1", snippet: { categoryId: "10" } }],
        }),
      );
    });

    await ensureVideoMetadata(db, ["v1"], "test-key");

    const row = db
      .prepare("SELECT channelId FROM video_metadata WHERE videoId = ?")
      .get("v1");
    expect(row.channelId).toBeNull();
  });
});
