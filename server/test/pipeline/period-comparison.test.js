import { describe, it, expect } from "vitest";
import { buildPeriodComparison } from "../../pipeline/period-comparison.js";

const MUSIC = "10";
const SPORTS = "17";
const GAME = "20";

// 영상 길이를 넉넉히(10000초) 둬 길이 상한 없이 watchedSeconds가 그대로 비중이 된다
function watch(categoryId, seconds, date = "2026-03-01", title = "영상") {
  return {
    title,
    categoryId,
    watchedSeconds: seconds,
    durationSeconds: 10000,
    watchedAt: `${date}T10:00:00+09:00`,
  };
}

// 4일 구간: 1구간 3/1~3/4, 2구간 3/5~3/8, …
function period(index, entries) {
  const start = new Date(Date.UTC(2026, 2, 1 + (index - 1) * 4));
  const end = new Date(Date.UTC(2026, 2, 4 + (index - 1) * 4));
  const iso = (d) => d.toISOString().slice(0, 10);
  return {
    periodIndex: index,
    periodStart: iso(start),
    periodEnd: iso(end),
    entries: entries.map((e) => ({
      ...e,
      watchedAt: e.watchedAt.replace("2026-03-01", iso(start)),
    })),
  };
}

// 영상 수가 적은 구간으로 판정되지 않게(4일 → 8개 이상) 같은 비중을 여러 개로 나눈다.
// 1%당 60초라 5% 분야도 300초로 유효 시청(30초 이상)이다
function shares(spec, count = 10) {
  return Object.entries(spec).flatMap(([categoryId, percent]) =>
    Array.from({ length: count }, () => watch(categoryId, percent * 60)),
  );
}

describe("buildPeriodComparison — 직전 구간 대비 변화", () => {
  it("1구간은 비교할 직전 구간이 없다", () => {
    const result = buildPeriodComparison([period(1, shares({ [MUSIC]: 100 }))]);

    expect(result.previousPeriods).toEqual([]);
    expect(result.changeFromPrevious).toBeNull();
    expect(result.usualChange).toBeNull();
    expect(result.previousTitleGroups).toBeNull();
  });

  it("분야별 변화를 반올림한 정수 퍼센트끼리 빼서 크기 순으로 준다", () => {
    const result = buildPeriodComparison([
      period(1, shares({ [MUSIC]: 60, [GAME]: 40 })),
      period(2, shares({ [MUSIC]: 45, [GAME]: 55 })),
    ]);

    expect(result.previousPeriods[0].shares).toEqual([
      { category: "음악", percent: 60 },
      { category: "게임", percent: 40 },
    ]);
    expect(result.changeFromPrevious).toMatchObject({
      previousPeriodIndex: 1,
      changes: [
        { category: "게임", from: 40, to: 55, delta: 15 },
        { category: "음악", from: 60, to: 45, delta: -15 },
      ],
      largest: { category: "게임", delta: 15 },
    });
  });

  it("줄어든 폭이 늘어난 폭보다 크면 줄어든 분야가 가장 큰 변화다(부호가 아니라 크기 순)", () => {
    const result = buildPeriodComparison([
      period(1, shares({ [MUSIC]: 60, [GAME]: 40 })),
      period(2, shares({ [MUSIC]: 30, [GAME]: 50, [SPORTS]: 20 })),
    ]);

    expect(result.changeFromPrevious.changes.map((c) => c.delta)).toEqual([
      -30, 20, 10,
    ]);
    expect(result.changeFromPrevious.largest.category).toBe("음악");
  });

  it("변화가 없는 분야는 목록에 넣지 않고, 모두 같으면 가장 큰 변화도 없다", () => {
    const result = buildPeriodComparison([
      period(1, shares({ [MUSIC]: 100 })),
      period(2, shares({ [MUSIC]: 100 })),
    ]);

    expect(result.changeFromPrevious.changes).toEqual([]);
    expect(result.changeFromPrevious.largest).toBeNull();
  });

  it("직전 0% → 이번 5% 이상은 새로 본 분야, 직전 5% 이상 → 이번 0%는 보지 않은 분야", () => {
    const result = buildPeriodComparison([
      period(1, shares({ [MUSIC]: 90, [GAME]: 5, [SPORTS]: 5 })),
      period(2, shares({ [MUSIC]: 91, [GAME]: 9 })),
    ]);
    const withNew = buildPeriodComparison([
      period(1, shares({ [MUSIC]: 100 })),
      period(2, shares({ [MUSIC]: 95, [SPORTS]: 5 })),
    ]);
    const belowThreshold = buildPeriodComparison([
      period(1, shares({ [MUSIC]: 100 })),
      period(2, shares({ [MUSIC]: 96, [SPORTS]: 4 })),
    ]);

    expect(result.changeFromPrevious.droppedCategories).toEqual(["스포츠"]);
    expect(withNew.changeFromPrevious.newCategories).toEqual(["스포츠"]);
    expect(belowThreshold.changeFromPrevious.newCategories).toEqual([]);
  });

  it("이전 구간 중 영상이 적은 구간(일수 × 2개 미만)을 표시한다", () => {
    const result = buildPeriodComparison([
      period(1, shares({ [MUSIC]: 100 }, 7)),
      period(2, shares({ [MUSIC]: 100 }, 8)),
      period(3, shares({ [MUSIC]: 100 })),
    ]);

    expect(result.previousPeriods.map((p) => p.isFew)).toEqual([true, false]);
    expect(result.previousPeriods.map((p) => p.validVideoCount)).toEqual([
      7, 8,
    ]);
  });
});

describe("buildPeriodComparison — 평소 변화 폭", () => {
  it("3구간까지는 이전 구간 쌍이 2개 미만이라 평소 변화 폭이 없다", () => {
    const result = buildPeriodComparison([
      period(1, shares({ [MUSIC]: 60, [GAME]: 40 })),
      period(2, shares({ [MUSIC]: 50, [GAME]: 50 })),
      period(3, shares({ [MUSIC]: 20, [GAME]: 80 })),
    ]);

    expect(result.usualChange).toBeNull();
  });

  it("이전 구간끼리 연속한 쌍마다 가장 크게 달라진 %p의 평균이다(이번 구간 변화는 넣지 않음)", () => {
    const result = buildPeriodComparison([
      period(1, shares({ [MUSIC]: 60, [GAME]: 40 })),
      period(2, shares({ [MUSIC]: 52, [GAME]: 48 })), // 가장 큰 변화 8
      period(3, shares({ [MUSIC]: 64, [GAME]: 36 })), // 가장 큰 변화 12
      period(4, shares({ [MUSIC]: 10, [GAME]: 90 })), // 이번 구간 — 평소 폭 계산에서 제외
    ]);

    expect(result.usualChange).toEqual({
      pairCount: 2,
      averageLargestDelta: 10,
    });
    expect(result.changeFromPrevious.largest).toMatchObject({ delta: 54 });
  });

  it("구간이 늘면 쌍도 늘어난다(6구간 → 4쌍)", () => {
    const result = buildPeriodComparison(
      [70, 60, 70, 60, 70, 10].map((m, i) =>
        period(i + 1, shares({ [MUSIC]: m, [GAME]: 100 - m })),
      ),
    );

    expect(result.usualChange).toEqual({
      pairCount: 4,
      averageLargestDelta: 10,
    });
  });
});

describe("buildPeriodComparison — 구간 안의 날짜별 비중", () => {
  it("구간의 모든 날짜를 넣고, 기록 없는 날·적은 날·잠깐 본 영상을 구분한다", () => {
    const result = buildPeriodComparison([
      period(1, [
        watch(MUSIC, 300, "2026-03-01"),
        watch(GAME, 300, "2026-03-01"),
        watch(MUSIC, 300, "2026-03-02"), // 하루 1개 — 적은 날
        watch(SPORTS, 3, "2026-03-03"), // 잠깐 본 영상뿐 — 기록 없음과 같음
      ]),
    ]);

    expect(result.dailyShares).toEqual([
      {
        date: "2026-03-01",
        validVideoCount: 2,
        noRecord: false,
        isFew: false,
        shares: [
          { category: "음악", percent: 50 },
          { category: "게임", percent: 50 },
        ],
      },
      {
        date: "2026-03-02",
        validVideoCount: 1,
        noRecord: false,
        isFew: true,
        shares: [{ category: "음악", percent: 100 }],
      },
      {
        date: "2026-03-03",
        validVideoCount: 0,
        noRecord: true,
        isFew: false,
        shares: [],
      },
      {
        date: "2026-03-04",
        validVideoCount: 0,
        noRecord: true,
        isFew: false,
        shares: [],
      },
    ]);
  });

  it("날짜는 본 시각의 KST 날짜로 나눈다", () => {
    const result = buildPeriodComparison([
      period(1, [
        // UTC로는 3/1이지만 KST로는 3/2 00:30
        { ...watch(MUSIC, 300), watchedAt: "2026-03-01T15:30:00Z" },
      ]),
    ]);

    expect(result.dailyShares[0].noRecord).toBe(true);
    expect(result.dailyShares[1].validVideoCount).toBe(1);
  });
});

describe("buildPeriodComparison — 직전 구간 제목", () => {
  it("같은 분야 안에서 소재가 바뀐 것을 짚을 수 있게 직전 구간 제목 묶음을 넘긴다", () => {
    const result = buildPeriodComparison([
      period(1, [watch(SPORTS, 300, "2026-03-01", "축구 하이라이트")]),
      period(2, [watch(SPORTS, 300, "2026-03-01", "야구 하이라이트")]),
      period(3, [watch(SPORTS, 300, "2026-03-01", "농구 하이라이트")]),
    ]);

    // 직전(2구간) 하나만
    expect(result.previousTitleGroups).toEqual([
      {
        category: "스포츠",
        videoCount: 1,
        titles: [{ title: "야구 하이라이트", count: 1 }],
        omittedCount: 0,
      },
    ]);
  });
});
