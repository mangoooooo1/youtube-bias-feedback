import { describe, it, expect } from "vitest";
import {
  groupTitlesByCategory,
  UNCATEGORIZED_GROUP,
} from "../../pipeline/review-titles.js";

const MUSIC = "10";
const SPORTS = "17";
const GAME = "20";

let minute = 0;
function video({
  title = "영상",
  categoryId = MUSIC,
  watchedSeconds = 300,
  durationSeconds = 600,
  watchedAt,
} = {}) {
  minute += 1;
  return {
    title,
    categoryId,
    watchedSeconds,
    durationSeconds,
    watchedAt:
      watchedAt ?? new Date(Date.UTC(2026, 2, 10, 0, minute)).toISOString(),
  };
}

describe("groupTitlesByCategory", () => {
  it("잠깐 본 영상의 제목은 넣지 않는다", () => {
    const groups = groupTitlesByCategory([
      video({ title: "끝까지 본 영상" }),
      video({ title: "잘못 누른 영상", watchedSeconds: 3 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].titles).toEqual([{ title: "끝까지 본 영상", count: 1 }]);
  });

  it("시청 시간이 많은 카테고리부터, 분야 미확인 묶음은 맨 끝에 둔다", () => {
    const groups = groupTitlesByCategory([
      video({
        title: "분류 없음",
        categoryId: null,
        watchedSeconds: 3000,
        durationSeconds: 3000,
      }),
      video({ title: "게임", categoryId: GAME, watchedSeconds: 100 }),
      video({ title: "스포츠", categoryId: SPORTS, watchedSeconds: 500 }),
    ]);

    expect(groups.map((g) => g.category)).toEqual([
      "스포츠",
      "게임",
      UNCATEGORIZED_GROUP,
    ]);
  });

  it("시청 시간을 아직 모르는 영상의 제목은 넣지 않는다(잠깐 보고 끈 영상일 수도 있음)", () => {
    const groups = groupTitlesByCategory([
      video({ title: "다 본 음악" }),
      video({
        title: "보는 중인 게임",
        categoryId: GAME,
        watchedSeconds: null,
      }),
    ]);

    expect(groups).toEqual([
      {
        category: "음악",
        videoCount: 1,
        titles: [{ title: "다 본 음악", count: 1 }],
        omittedCount: 0,
      },
    ]);
  });

  it("시청 시간이 영상 길이를 넘으면 길이만큼만 세서 순서를 정한다", () => {
    const groups = groupTitlesByCategory([
      video({ categoryId: GAME, watchedSeconds: 9000, durationSeconds: 60 }),
      video({ categoryId: SPORTS, watchedSeconds: 300, durationSeconds: 600 }),
    ]);

    expect(groups.map((g) => g.category)).toEqual(["스포츠", "게임"]);
  });

  it("묶음 안은 최근에 본 순서이고, 다시 본 제목은 횟수와 함께 한 줄로 합친다", () => {
    const groups = groupTitlesByCategory([
      video({ title: "A", watchedAt: "2026-03-10T09:00:00+09:00" }),
      video({ title: "B", watchedAt: "2026-03-10T10:00:00+09:00" }),
      video({ title: "A", watchedAt: "2026-03-10T11:00:00+09:00" }),
      video({ title: "A", watchedAt: "2026-03-10T08:00:00+09:00" }),
    ]);

    expect(groups[0].titles).toEqual([
      { title: "A", count: 3 },
      { title: "B", count: 1 },
    ]);
    expect(groups[0].videoCount).toBe(4);
  });

  it("제목이 없는 영상은 제목 목록에서만 빠지고 영상 수에는 들어간다", () => {
    const groups = groupTitlesByCategory([
      video({ title: "있음" }),
      video({ title: null }),
      video({ title: "   " }),
    ]);

    expect(groups[0].titles).toEqual([{ title: "있음", count: 1 }]);
    expect(groups[0].videoCount).toBe(3);
  });

  it("상한을 넘으면 묶음 크기에 비례해 줄이고, 묶음마다 최소 1개와 줄인 수를 남긴다", () => {
    const entries = [
      ...Array.from({ length: 90 }, (_, i) =>
        video({ title: `음악 ${i}`, categoryId: MUSIC, watchedSeconds: 600 }),
      ),
      ...Array.from({ length: 29 }, (_, i) =>
        video({ title: `게임 ${i}`, categoryId: GAME, watchedSeconds: 300 }),
      ),
      video({ title: "스포츠 하나", categoryId: SPORTS, watchedSeconds: 60 }),
    ];

    const groups = groupTitlesByCategory(entries, { maxTitles: 100 });
    const kept = groups.reduce((sum, g) => sum + g.titles.length, 0);
    const omitted = groups.reduce((sum, g) => sum + g.omittedCount, 0);

    expect(kept).toBe(100);
    expect(omitted).toBe(20);
    expect(groups.find((g) => g.category === "스포츠").titles).toHaveLength(1);
    // 비례 배분: 음악 90 → 75, 게임 29 → 24
    expect(groups.find((g) => g.category === "음악").titles).toHaveLength(75);
    expect(groups.find((g) => g.category === "게임").titles).toHaveLength(24);
  });

  it("상한으로 줄일 때는 오래 전에 본 제목부터 뺀다", () => {
    const groups = groupTitlesByCategory(
      [
        video({ title: "옛날", watchedAt: "2026-03-10T08:00:00+09:00" }),
        video({ title: "중간", watchedAt: "2026-03-10T09:00:00+09:00" }),
        video({ title: "최근", watchedAt: "2026-03-10T10:00:00+09:00" }),
      ],
      { maxTitles: 2 },
    );

    expect(groups[0].titles.map((t) => t.title)).toEqual(["최근", "중간"]);
    expect(groups[0].omittedCount).toBe(1);
  });

  it("상한 이하이면 전부 넘기고 줄인 수는 0이다", () => {
    const groups = groupTitlesByCategory(
      Array.from({ length: 30 }, (_, i) => video({ title: `영상 ${i}` })),
    );

    expect(groups[0].titles).toHaveLength(30);
    expect(groups[0].omittedCount).toBe(0);
  });

  it("유효 시청 영상이 없으면 빈 배열", () => {
    expect(groupTitlesByCategory([video({ watchedSeconds: 1 })])).toEqual([]);
  });
});
