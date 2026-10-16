process.env.TZ = "Asia/Seoul";

import { describe, it, expect } from "vitest";
import { aggregateTodayCumulative } from "../../pipeline/today-boundaries.js";

// "오늘" 집계는 세션 분포를 병합하지 않고 영상 기록(video_events + video_metadata)에서 직접
// 계산한다. 날짜는 영상을 본 시각(watchedAt, KST) 기준이다.
// (이전 버전은 세션 endTime 기준으로 세션 분포를 영상 수로 병합했다 — git 이력 참고)

// 유튜브 categoryId — 10 음악, 17 스포츠, 20 게임, 27 교육
const MUSIC = "10";
const SPORTS = "17";
const GAME = "20";
const EDU = "27";

function video({
  sessionId = "s1",
  title = "영상",
  watchedAt,
  categoryId = MUSIC,
  watchedSeconds = 300,
  durationSeconds = 600,
}) {
  return {
    sessionId,
    title,
    watchedAt,
    categoryId,
    watchedSeconds,
    durationSeconds,
  };
}
const NOW = new Date("2026-03-10T22:00:00+09:00");

describe("aggregateTodayCumulative", () => {
  it("오늘 본 영상이 없으면 null을 반환한다", () => {
    const result = aggregateTodayCumulative({
      events: [video({ watchedAt: "2026-03-09T20:00:00+09:00" })],
      now: NOW,
    });
    expect(result).toBeNull();
  });

  it("오늘 본 영상이 모두 잠깐 본 영상이면 null을 반환한다", () => {
    const result = aggregateTodayCumulative({
      events: [
        video({ watchedAt: "2026-03-10T09:00:00+09:00", watchedSeconds: 3 }),
        video({ watchedAt: "2026-03-10T10:00:00+09:00", watchedSeconds: 5 }),
      ],
      now: NOW,
    });
    expect(result).toBeNull();
  });

  // 세션 분포를 영상 수로 병합하던 방식은 이 예시를 음악 83% / 게임 17%로 만들었다
  it("오늘 여러 세션의 영상을 세션 병합 없이 영상 단위로 집계한다", () => {
    const sessionA = [
      video({
        sessionId: "s-a",
        title: "음악 1",
        watchedAt: "2026-03-10T10:00:00+09:00",
      }),
      video({
        sessionId: "s-a",
        title: "음악 2",
        watchedAt: "2026-03-10T10:10:00+09:00",
      }),
      ...Array.from({ length: 8 }, (_, i) =>
        video({
          sessionId: "s-a",
          title: `스포츠 ${i}`,
          watchedAt: "2026-03-10T10:20:00+09:00",
          categoryId: SPORTS,
          watchedSeconds: 5,
        }),
      ),
    ];
    const sessionB = [
      video({
        sessionId: "s-b",
        title: "게임 1",
        watchedAt: "2026-03-10T21:00:00+09:00",
        categoryId: GAME,
      }),
      video({
        sessionId: "s-b",
        title: "게임 2",
        watchedAt: "2026-03-10T21:10:00+09:00",
        categoryId: GAME,
      }),
    ];

    const result = aggregateTodayCumulative({
      events: [...sessionA, ...sessionB],
      now: NOW,
    });

    expect(result.reviewDate).toBe("2026-03-10");
    expect(result.categoryDistribution).toEqual({ 음악: 0.5, 게임: 0.5 });
    expect(result.entropy).toBe(1);
    expect(result.videoCount).toBe(12); // 잠깐 본 영상까지 포함한 영상 기록 수
    expect(result.validVideoCount).toBe(4); // 잠깐 본 스포츠 8개 제외
    expect(result.sessionCount).toBe(2);
    expect(result.sessionIds).toEqual(["s-a", "s-b"]);
    expect(result.videoTitles).toHaveLength(12);
  });

  it("오늘 날짜가 아닌 영상 제목은 videoTitles에서 제외한다", () => {
    const result = aggregateTodayCumulative({
      events: [
        video({ title: "어제 영상", watchedAt: "2026-03-09T20:00:00+09:00" }),
        video({ title: "오늘 영상", watchedAt: "2026-03-10T10:00:00+09:00" }),
      ],
      now: NOW,
    });
    expect(result.videoTitles).toEqual(["오늘 영상"]);
  });

  it("자정을 넘긴 세션의 영상은 세션이 끝난 날이 아니라 영상을 본 날로 나뉜다", () => {
    // 같은 세션이 3/9 23:50에 시작해 3/10 00:20에 끝남
    const result = aggregateTodayCumulative({
      events: [
        video({
          sessionId: "s-night",
          title: "어제 밤 음악",
          watchedAt: "2026-03-09T23:50:00+09:00",
        }),
        video({
          sessionId: "s-night",
          title: "오늘 새벽 게임",
          watchedAt: "2026-03-10T00:10:00+09:00",
          categoryId: GAME,
        }),
      ],
      now: NOW,
    });

    expect(result.categoryDistribution).toEqual({ 게임: 1 });
    expect(result.videoTitles).toEqual(["오늘 새벽 게임"]);
    expect(result.prevEntropy).toBe(0); // 어제는 음악만
  });

  it("카테고리를 못 가져온 영상은 분포에서만 빠지고 영상 수·제목에는 들어간다", () => {
    const result = aggregateTodayCumulative({
      events: [
        video({ title: "음악", watchedAt: "2026-03-10T10:00:00+09:00" }),
        video({
          title: "분류 없음",
          watchedAt: "2026-03-10T11:00:00+09:00",
          categoryId: null,
        }),
      ],
      now: NOW,
    });

    expect(result.categoryDistribution).toEqual({ 음악: 1 });
    expect(result.videoCount).toBe(2);
    expect(result.videoTitles).toEqual(["음악", "분류 없음"]);
  });

  // 저장·분석용 분포는 사전등록 정의 — 시청 시간을 아직 모르는 영상(보고 있는 영상 등)도 넣는다
  it("시청 시간을 아직 모르는 영상도 저장되는 분포와 다양성에 포함한다", () => {
    const result = aggregateTodayCumulative({
      events: [
        video({ watchedAt: "2026-03-10T10:00:00+09:00" }),
        video({
          watchedAt: "2026-03-10T21:50:00+09:00",
          categoryId: GAME,
          watchedSeconds: null,
        }),
      ],
      now: NOW,
    });

    expect(result.categoryDistribution).toEqual({ 음악: 0.5, 게임: 0.5 });
    expect(result.entropy).toBe(1);
  });

  it("직전 시청일이 없으면 prevEntropy는 null이다", () => {
    const result = aggregateTodayCumulative({
      events: [
        video({ watchedAt: "2026-03-10T11:00:00+09:00", categoryId: SPORTS }),
      ],
      now: NOW,
    });
    expect(result.prevEntropy).toBeNull();
  });

  it("가장 최근 직전 날짜만 prevEntropy에 반영한다(더 오래된 과거 영상은 제외)", () => {
    const result = aggregateTodayCumulative({
      events: [
        // 2일 전 — 음악 단독(entropy 0)
        video({ watchedAt: "2026-03-08T20:00:00+09:00" }),
        // 어제 — 게임/교육 반반(entropy 1)
        video({ watchedAt: "2026-03-09T20:00:00+09:00", categoryId: GAME }),
        video({ watchedAt: "2026-03-09T20:30:00+09:00", categoryId: EDU }),
        video({ watchedAt: "2026-03-10T09:00:00+09:00", categoryId: SPORTS }),
      ],
      now: NOW,
    });
    expect(result.prevEntropy).toBe(1);
  });

  it("직전 날짜에 잠깐 본 영상만 있으면 그 전 시청일을 쓴다", () => {
    const result = aggregateTodayCumulative({
      events: [
        // 2일 전 — 게임/교육 반반(entropy 1)
        video({ watchedAt: "2026-03-08T20:00:00+09:00", categoryId: GAME }),
        video({ watchedAt: "2026-03-08T20:30:00+09:00", categoryId: EDU }),
        // 어제 — 잠깐 본 영상뿐
        video({ watchedAt: "2026-03-09T20:00:00+09:00", watchedSeconds: 2 }),
        video({ watchedAt: "2026-03-10T09:00:00+09:00", categoryId: SPORTS }),
      ],
      now: NOW,
    });
    expect(result.prevEntropy).toBe(1);
  });

  it("단말 시계가 앞서 있어 미래 날짜 영상이 섞여도 prevEntropy에 반영하지 않는다", () => {
    const result = aggregateTodayCumulative({
      events: [
        video({ watchedAt: "2026-03-09T20:00:00+09:00", categoryId: GAME }),
        video({ watchedAt: "2026-03-09T20:30:00+09:00", categoryId: EDU }),
        video({ watchedAt: "2026-03-10T09:00:00+09:00", categoryId: SPORTS }),
        // 단말 시계 오류로 미래로 찍힌 영상(음악 단독, entropy 0)
        video({ watchedAt: "2026-03-15T09:00:00+09:00" }),
      ],
      now: NOW,
    });
    expect(result.prevEntropy).toBe(1);
  });

  it("파싱할 수 없는 watchedAt을 가진 영상은 오늘·직전 시청일 계산에서 제외한다", () => {
    const result = aggregateTodayCumulative({
      events: [
        video({ watchedAt: "2026-03-09T20:00:00+09:00", categoryId: GAME }),
        video({ watchedAt: "not-a-date" }),
        video({ watchedAt: "2026-03-10T09:00:00+09:00", categoryId: SPORTS }),
      ],
      now: NOW,
    });
    expect(result.prevEntropy).toBe(0);
    expect(result.videoCount).toBe(1);
  });

  it("제목이 없는 영상도 집계는 되고 videoTitles에서만 빠진다", () => {
    const result = aggregateTodayCumulative({
      events: [
        video({ title: null, watchedAt: "2026-03-10T09:00:00+09:00" }),
        video({ title: null, watchedAt: "2026-03-10T09:30:00+09:00" }),
      ],
      now: NOW,
    });
    expect(result.videoCount).toBe(2);
    expect(result.videoTitles).toEqual([]);
  });
});
