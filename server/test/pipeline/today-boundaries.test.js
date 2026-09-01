process.env.TZ = "Asia/Seoul";

import { describe, it, expect } from "vitest";
import { aggregateTodayCumulative } from "../../pipeline/today-boundaries.js";

// 이 파일은 원래 extension/pipeline/analysis.js에서 확장 프로그램이 로컬로 집계하던
// "오늘 하루" 로직을 서버로 이식한 것이다(연구 무결성 점검 항목 1 후속 조치, Stage 2a).
// 확장 프로그램 쪽 원본은 Stage 2c에서 완전히 제거됐으므로(더 이상 클라이언트가 집계하지
// 않음), 지금부터는 서버 버전 단독으로 집계 로직을 검증한다(이식 당시의 동치성은 git
// 이력의 이전 버전에 남아 있다).
function session({ sessionId, endTime, categoryDistribution, videoCount }) {
  return { sessionId, endTime, categoryDistribution, videoCount };
}

describe("aggregateTodayCumulative", () => {
  it("오늘 세션이 없으면 null을 반환한다", () => {
    const result = aggregateTodayCumulative({
      sessions: [
        session({
          sessionId: "s-yesterday",
          endTime: "2026-03-09T20:00:00+09:00",
          categoryDistribution: { 음악: 1 },
          videoCount: 3,
        }),
      ],
      titles: [],
      now: new Date("2026-03-10T10:00:00+09:00"),
    });
    expect(result).toBeNull();
  });

  it("categoryDistribution이 없거나 빈 세션은 집계에서 제외한다", () => {
    const result = aggregateTodayCumulative({
      sessions: [
        session({
          sessionId: "s1",
          endTime: "2026-03-10T09:00:00+09:00",
          categoryDistribution: {},
          videoCount: 3,
        }),
        session({
          sessionId: "s2",
          endTime: "2026-03-10T10:00:00+09:00",
          categoryDistribution: null,
          videoCount: 1,
        }),
      ],
      titles: [],
      now: new Date("2026-03-10T20:00:00+09:00"),
    });
    expect(result).toBeNull();
  });

  it("오늘 세션 여러 개를 videoCount 가중 평균으로 병합한다", () => {
    const result = aggregateTodayCumulative({
      sessions: [
        session({
          sessionId: "s-today-1",
          endTime: "2026-03-10T10:00:00+09:00",
          categoryDistribution: { 음악: 1 },
          videoCount: 1,
        }),
        session({
          sessionId: "s-today-2",
          endTime: "2026-03-10T21:00:00+09:00",
          categoryDistribution: { 게임: 1 },
          videoCount: 3,
        }),
      ],
      titles: [
        { title: "음악 영상", watchedAt: "2026-03-10T10:00:00+09:00" },
        { title: "게임 영상", watchedAt: "2026-03-10T21:00:00+09:00" },
      ],
      now: new Date("2026-03-10T22:00:00+09:00"),
    });

    expect(result.reviewDate).toBe("2026-03-10");
    // 가중 평균: 음악 1*(1/4) + 게임 1*(3/4)
    expect(result.categoryDistribution).toEqual({ 음악: 0.25, 게임: 0.75 });
    expect(result.entropy).toBe(0.81);
    expect(result.videoCount).toBe(4);
    expect(result.sessionCount).toBe(2);
    expect(result.sessionIds).toEqual(["s-today-1", "s-today-2"]);
    expect(result.videoTitles).toEqual(["음악 영상", "게임 영상"]);
  });

  it("오늘 날짜가 아닌 영상 제목은 videoTitles에서 제외한다", () => {
    const result = aggregateTodayCumulative({
      sessions: [
        session({
          sessionId: "s-today",
          endTime: "2026-03-10T10:00:00+09:00",
          categoryDistribution: { 음악: 1 },
          videoCount: 1,
        }),
      ],
      titles: [
        { title: "어제 영상", watchedAt: "2026-03-09T20:00:00+09:00" },
        { title: "오늘 영상", watchedAt: "2026-03-10T10:00:00+09:00" },
      ],
      now: new Date("2026-03-10T20:00:00+09:00"),
    });
    expect(result.videoTitles).toEqual(["오늘 영상"]);
  });

  it("직전 시청일이 없으면 prevEntropy는 null이다", () => {
    const result = aggregateTodayCumulative({
      sessions: [
        session({
          sessionId: "s-today",
          endTime: "2026-03-10T11:00:00+09:00",
          categoryDistribution: { 스포츠: 1 },
          videoCount: 2,
        }),
      ],
      titles: [],
      now: new Date("2026-03-10T12:00:00+09:00"),
    });
    expect(result.prevEntropy).toBeNull();
  });

  it("가장 최근 직전 날짜만 prevEntropy에 반영한다(더 오래된 과거 세션은 제외)", () => {
    const result = aggregateTodayCumulative({
      sessions: [
        // 2일 전 — 오늘 대비 더 오래된 날짜(음악 단독, entropy=0)
        session({
          sessionId: "s-2-days-ago",
          endTime: "2026-03-08T20:00:00+09:00",
          categoryDistribution: { 음악: 1 },
          videoCount: 10,
        }),
        // 어제 — 가장 최근 이전 시청일(게임/교육 반반, entropy=1)
        session({
          sessionId: "s-yesterday",
          endTime: "2026-03-09T20:00:00+09:00",
          categoryDistribution: { 게임: 0.5, 교육: 0.5 },
          videoCount: 4,
        }),
        session({
          sessionId: "s-today",
          endTime: "2026-03-10T09:00:00+09:00",
          categoryDistribution: { 스포츠: 1 },
          videoCount: 2,
        }),
      ],
      titles: [],
      now: new Date("2026-03-10T12:00:00+09:00"),
    });
    expect(result.prevEntropy).toBe(1);
  });

  it("단말 시계가 앞서 있어 미래 날짜 세션이 섞여도 prevEntropy에 반영하지 않는다", () => {
    const result = aggregateTodayCumulative({
      sessions: [
        // 어제 — 진짜 직전 시청일(entropy=1)
        session({
          sessionId: "s-yesterday",
          endTime: "2026-03-09T20:00:00+09:00",
          categoryDistribution: { 게임: 0.5, 교육: 0.5 },
          videoCount: 4,
        }),
        session({
          sessionId: "s-today",
          endTime: "2026-03-10T09:00:00+09:00",
          categoryDistribution: { 스포츠: 1 },
          videoCount: 2,
        }),
        // 단말 시계 오류로 미래로 찍힌 세션(entropy=0) — 내림차순 정렬이면 최상단에 온다
        session({
          sessionId: "s-future-clock-skew",
          endTime: "2026-03-15T09:00:00+09:00",
          categoryDistribution: { 음악: 1 },
          videoCount: 1,
        }),
      ],
      titles: [],
      now: new Date("2026-03-10T12:00:00+09:00"),
    });
    expect(result.prevEntropy).toBe(1);
  });

  it("파싱 불가한 endTime을 가진 세션은 직전 시청일 계산에서 제외한다", () => {
    const result = aggregateTodayCumulative({
      sessions: [
        session({
          sessionId: "s-yesterday",
          endTime: "2026-03-09T20:00:00+09:00",
          categoryDistribution: { 게임: 1 },
          videoCount: 1,
        }),
        session({
          sessionId: "s-bad-endtime",
          endTime: "not-a-date",
          categoryDistribution: { 음악: 1 },
          videoCount: 1,
        }),
        session({
          sessionId: "s-today",
          endTime: "2026-03-10T09:00:00+09:00",
          categoryDistribution: { 스포츠: 1 },
          videoCount: 2,
        }),
      ],
      titles: [],
      now: new Date("2026-03-10T12:00:00+09:00"),
    });
    expect(result.prevEntropy).toBe(0);
  });

  it("titles가 없어도(빈 배열) 집계가 동작한다", () => {
    const result = aggregateTodayCumulative({
      sessions: [
        session({
          sessionId: "s1",
          endTime: "2026-03-10T09:00:00+09:00",
          categoryDistribution: { 음악: 1 },
          videoCount: 2,
        }),
      ],
      now: new Date("2026-03-10T20:00:00+09:00"),
    });
    expect(result.videoCount).toBe(2);
    expect(result.videoTitles).toEqual([]);
  });
});
