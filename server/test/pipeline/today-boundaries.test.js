process.env.TZ = "Asia/Seoul";

import { describe, it, expect, afterEach, vi } from "vitest";
import { aggregateTodayCumulative as aggregateTodayCumulativeClient } from "../../../extension/pipeline/analysis.js";
import { aggregateTodayCumulative } from "../../pipeline/today-boundaries.js";

// 클라이언트 형태(세션에 videos 배열이 내장됨)의 세션 하나를 만든다.
function clientSession({
  sessionId,
  endTime,
  categoryDistribution,
  videoCount,
  videoTitles = [],
}) {
  return {
    sessionId,
    endTime,
    categoryDistribution,
    videoCount,
    videos: videoTitles.map((title, i) => ({
      videoId: `${sessionId}-v${i}`,
      title,
      watchedAt: endTime,
    })),
  };
}

// 클라이언트 형태 세션 배열 → 서버 형태 입력({ sessions, titles })으로 변환.
// video_events는 sessions와 별도 테이블이라 서버 버전은 이렇게 나눠 받는다.
function toServerInput(clientSessions) {
  const sessions = clientSessions.map(
    ({ sessionId, endTime, categoryDistribution, videoCount }) => ({
      sessionId,
      endTime,
      categoryDistribution,
      videoCount,
    }),
  );
  const titles = clientSessions.flatMap((s) =>
    (s.videos || []).map((v) => ({ title: v.title, watchedAt: v.watchedAt })),
  );
  return { sessions, titles };
}

// videoTitles는 top-10만 잘라 프롬프트에 쓰이는 참고 정보라 순서 자체엔 의미가 없다
// (서버는 DB 조회 순서, 클라이언트는 세션 배열 순서로 서로 다르게 나열될 수 있음) —
// 핵심 비교 대상인 분포·엔트로피·videoCount에 영향이 없으므로 정렬해서 비교한다.
function normalize(result) {
  if (!result) return result;
  return {
    ...result,
    videoTitles: [...result.videoTitles].sort(),
    sessionIds: [...result.sessionIds].sort(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("today-boundaries.aggregateTodayCumulative ↔ extension/pipeline/analysis.js 동치성", () => {
  it("오늘 세션이 없으면 둘 다 null을 반환한다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T10:00:00+09:00"));

    const sessions = [
      clientSession({
        sessionId: "s-yesterday",
        endTime: "2026-03-09T20:00:00+09:00",
        categoryDistribution: { 음악: 1 },
        videoCount: 3,
      }),
    ];

    expect(aggregateTodayCumulativeClient(sessions)).toBeNull();
    expect(
      aggregateTodayCumulative({ ...toServerInput(sessions), now: new Date() }),
    ).toBeNull();
  });

  it("오늘 세션 여러 개를 videoCount 가중으로 합치고, 직전 시청일(어제) entropy를 함께 계산한다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T22:00:00+09:00"));

    const sessions = [
      clientSession({
        sessionId: "s-yesterday",
        endTime: "2026-03-09T20:00:00+09:00",
        categoryDistribution: { 음악: 1 },
        videoCount: 4,
        videoTitles: ["어제 영상 A"],
      }),
      clientSession({
        sessionId: "s-today-1",
        endTime: "2026-03-10T10:00:00+09:00",
        categoryDistribution: { 게임: 0.5, 음악: 0.5 },
        videoCount: 2,
        videoTitles: ["오늘 영상 A", "오늘 영상 B"],
      }),
      clientSession({
        sessionId: "s-today-2",
        endTime: "2026-03-10T21:00:00+09:00",
        categoryDistribution: { 교육: 1 },
        videoCount: 3,
        videoTitles: ["오늘 영상 C"],
      }),
    ];

    const clientResult = aggregateTodayCumulativeClient(sessions);
    const serverResult = aggregateTodayCumulative({
      ...toServerInput(sessions),
      now: new Date(),
    });

    expect(clientResult).not.toBeNull();
    const a = normalize(clientResult);
    const b = normalize(serverResult);

    expect(b.reviewDate).toBe(a.reviewDate);
    expect(b.videoCount).toBe(a.videoCount);
    expect(b.sessionCount).toBe(a.sessionCount);
    expect(b.entropy).toBe(a.entropy);
    expect(b.prevEntropy).toBe(a.prevEntropy);
    expect(b.sessionIds).toEqual(a.sessionIds);
    expect(b.videoTitles).toEqual(a.videoTitles);
    for (const key of new Set([
      ...Object.keys(a.categoryDistribution),
      ...Object.keys(b.categoryDistribution),
    ])) {
      expect(b.categoryDistribution[key] ?? 0).toBeCloseTo(
        a.categoryDistribution[key] ?? 0,
        9,
      );
    }
  });

  it("직전 시청일 데이터가 전혀 없으면 prevEntropy가 둘 다 null이다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00+09:00"));

    const sessions = [
      clientSession({
        sessionId: "s-today",
        endTime: "2026-03-10T11:00:00+09:00",
        categoryDistribution: { 스포츠: 1 },
        videoCount: 2,
      }),
    ];

    const clientResult = aggregateTodayCumulativeClient(sessions);
    const serverResult = aggregateTodayCumulative({
      ...toServerInput(sessions),
      now: new Date(),
    });

    expect(clientResult.prevEntropy).toBeNull();
    expect(serverResult.prevEntropy).toBeNull();
  });

  it("가장 최근 직전 날짜만 prevEntropy에 반영한다(더 오래된 과거 세션은 제외)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00+09:00"));

    const sessions = [
      clientSession({
        sessionId: "s-2-days-ago",
        endTime: "2026-03-08T20:00:00+09:00",
        categoryDistribution: { 음악: 1 },
        videoCount: 10,
      }),
      clientSession({
        sessionId: "s-yesterday",
        endTime: "2026-03-09T20:00:00+09:00",
        categoryDistribution: { 게임: 0.5, 교육: 0.5 },
        videoCount: 4,
      }),
      clientSession({
        sessionId: "s-today",
        endTime: "2026-03-10T09:00:00+09:00",
        categoryDistribution: { 스포츠: 1 },
        videoCount: 2,
      }),
    ];

    const clientResult = aggregateTodayCumulativeClient(sessions);
    const serverResult = aggregateTodayCumulative({
      ...toServerInput(sessions),
      now: new Date(),
    });

    // 어제(게임/교육 반반, entropy=1)여야지 2일 전(음악 단독, entropy=0)이면 안 된다
    expect(clientResult.prevEntropy).toBe(1);
    expect(serverResult.prevEntropy).toBe(1);
  });
});
