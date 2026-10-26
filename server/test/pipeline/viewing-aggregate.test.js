import { describe, it, expect } from "vitest";
import {
  EXCLUDED_REASONS,
  cappedWatchSeconds,
  aggregateViewing,
  aggregateViewingByDay,
} from "../../pipeline/viewing-aggregate.js";

// 유튜브 categoryId — 10 음악, 17 스포츠, 20 게임
const MUSIC = 10;
const SPORTS = 17;
const GAME = 20;

function video({
  eventId,
  categoryId = MUSIC,
  durationSeconds = 600,
  watchedSeconds = 300,
  watchedAt,
}) {
  return { eventId, categoryId, durationSeconds, watchedSeconds, watchedAt };
}
const short = (props) => video({ watchedSeconds: 5, ...props });

describe("aggregateViewing — 세션 병합 없이 영상 기록에서 직접 집계", () => {
  // 세션 A: 전체 10개 중 유효 음악 2개, 세션 B: 전체 2개 중 유효 게임 2개
  // 세션 분포를 전체 영상 수로 병합하면 83/17이 되던 예시 — 영상 기준이면 50/50
  it("유효 영상 비율이 다른 세션이 섞여도 영상 수 기준 분포가 50/50이다", () => {
    const sessionA = [
      video({ categoryId: MUSIC }),
      video({ categoryId: MUSIC }),
      ...Array.from({ length: 8 }, () => short({ categoryId: SPORTS })),
    ];
    const sessionB = [video({ categoryId: GAME }), video({ categoryId: GAME })];

    const result = aggregateViewing([...sessionA, ...sessionB]);

    expect(result.countDistribution).toEqual({ 음악: 0.5, 게임: 0.5 });
    expect(result.validCount).toBe(4);
    expect(result.shortCount).toBe(8);
  });

  it("잠깐 본 영상은 분포·개수에서 빠지고 사유와 함께 따로 나온다", () => {
    const result = aggregateViewing([
      video({ eventId: "e1", categoryId: MUSIC }),
      short({ eventId: "e2", categoryId: SPORTS }),
    ]);

    expect(result.countDistribution).toEqual({ 음악: 1 });
    expect(result.timeDistribution).toEqual({ 음악: 1 });
    expect(result.validCount).toBe(1);
    expect(result.excluded).toEqual([
      { eventId: "e2", reason: EXCLUDED_REASONS.SHORT },
    ]);
  });

  it("두 도넛(영상 수·시청 시간)은 같은 영상 묶음을 쓴다 — 시청 시간을 모르는 영상은 둘 다에서 빠진다", () => {
    const result = aggregateViewing([
      video({ eventId: "e1", categoryId: MUSIC, watchedSeconds: 300 }),
      video({ eventId: "e2", categoryId: SPORTS, watchedSeconds: null }),
    ]);

    expect(result.chartCount).toBe(1);
    expect(result.countDistribution).toEqual({ 음악: 1 });
    expect(result.timeDistribution).toEqual({ 음악: 1 });
    // 시청 시간을 몰라도 유효 시청으로는 센다(사전등록 §2)
    expect(result.validCount).toBe(2);
    expect(result.pendingTimeCount).toBe(1);
    expect(result.excluded).toEqual([
      { eventId: "e2", reason: EXCLUDED_REASONS.PENDING_TIME },
    ]);
  });

  it("카테고리를 못 가져온 영상은 분포에서만 빠지고 영상 개수에는 들어간다", () => {
    const result = aggregateViewing([
      video({ eventId: "e1", categoryId: MUSIC }),
      video({ eventId: "e2", categoryId: null }),
    ]);

    expect(result.countDistribution).toEqual({ 음악: 1 });
    expect(result.validCount).toBe(2);
    expect(result.uncategorizedCount).toBe(1);
    expect(result.excluded).toEqual([
      { eventId: "e2", reason: EXCLUDED_REASONS.UNCATEGORIZED },
    ]);
  });

  it("카테고리도 시청 시간도 없으면 카테고리 없음으로 분류한다", () => {
    const result = aggregateViewing([
      video({ eventId: "e1", categoryId: null, watchedSeconds: null }),
    ]);

    expect(result.uncategorizedCount).toBe(1);
    expect(result.pendingTimeCount).toBe(0);
  });

  it("시청 시간은 영상 길이로 상한을 둔다", () => {
    // 길이 100초 영상을 250초 본 것으로 기록(잠자기·버퍼링 등) → 100초로 센다
    const result = aggregateViewing([
      video({ categoryId: MUSIC, durationSeconds: 100, watchedSeconds: 250 }),
      video({ categoryId: GAME, durationSeconds: 600, watchedSeconds: 100 }),
    ]);

    expect(result.chartSeconds).toBe(200);
    expect(result.timeDistribution).toEqual({ 음악: 0.5, 게임: 0.5 });
    expect(result.weightedDistribution).toEqual({ 음악: 0.5, 게임: 0.5 });
  });

  it("영상 길이를 모르면 상한 없이 시청 시간을 그대로 쓴다", () => {
    expect(cappedWatchSeconds(250, null)).toBe(250);
    expect(cappedWatchSeconds(250, 0)).toBe(250);
    expect(cappedWatchSeconds(null, 100)).toBeNull();
  });

  it("시청 시간과 영상 개수가 갈리는 경우를 두 분포가 각각 보여준다", () => {
    // 음악 플레이리스트 2개(긴 시간) vs 스포츠 쇼츠 10개(짧은 시간)
    const result = aggregateViewing([
      video({ categoryId: MUSIC, durationSeconds: 3600, watchedSeconds: 3600 }),
      video({ categoryId: MUSIC, durationSeconds: 3600, watchedSeconds: 3600 }),
      ...Array.from({ length: 10 }, () =>
        video({ categoryId: SPORTS, durationSeconds: 40, watchedSeconds: 40 }),
      ),
    ]);

    expect(result.timeDistribution.음악).toBeGreaterThan(0.9);
    expect(result.countDistribution).toEqual({ 음악: 0.167, 스포츠: 0.833 });
  });

  it("한 카테고리 100개인 날은 그 카테고리 100%이고 다양성은 0이다", () => {
    const result = aggregateViewing(
      Array.from({ length: 100 }, () => video({ categoryId: SPORTS })),
    );

    expect(result.countDistribution).toEqual({ 스포츠: 1 });
    expect(result.timeDistribution).toEqual({ 스포츠: 1 });
    expect(result.entropy).toBe(0);
    expect(result.weightedEntropy).toBe(0);
    expect(result.validCount).toBe(100);
  });

  it("영상 1개인 날도 계산된다", () => {
    const result = aggregateViewing([video({ categoryId: GAME })]);

    expect(result.validCount).toBe(1);
    expect(result.chartCount).toBe(1);
    expect(result.countDistribution).toEqual({ 게임: 1 });
  });

  it("영상이 없으면 빈 분포와 0, 시청 시간 가중 다양성은 null이다", () => {
    const result = aggregateViewing([]);

    expect(result.validCount).toBe(0);
    expect(result.countDistribution).toEqual({});
    expect(result.timeDistribution).toEqual({});
    expect(result.entropy).toBe(0);
    expect(result.weightedEntropy).toBeNull();
  });

  // 분석용 entropy는 사전등록 정의 — 시청 시간을 모르는 유효 영상도 영상 수 분포에 넣는다
  it("분석용 entropy는 시청 시간을 모르는 유효 영상도 포함하고, 화면용 분포는 포함하지 않는다", () => {
    const result = aggregateViewing([
      video({ categoryId: MUSIC, watchedSeconds: 300 }),
      video({ categoryId: GAME, watchedSeconds: null }),
    ]);

    expect(result.countDistribution).toEqual({ 음악: 1 });
    expect(result.analysisDistribution).toEqual({ 음악: 0.5, 게임: 0.5 });
    expect(result.entropy).toBe(1); // 음악 50% · 게임 50%
    expect(result.weightedEntropy).toBe(0); // 시간을 아는 음악만
  });
});

describe("aggregateViewingByDay — 영상을 본 시각(KST) 기준 날짜별 집계", () => {
  it("자정을 기준으로 KST 날짜별로 나눈다", () => {
    const result = aggregateViewingByDay([
      video({ categoryId: MUSIC, watchedAt: "2026-10-15T14:59:00Z" }), // KST 10/15 23:59
      video({ categoryId: GAME, watchedAt: "2026-10-15T15:01:00Z" }), // KST 10/16 00:01
      video({ categoryId: GAME, watchedAt: "2026-10-16T03:00:00Z" }), // KST 10/16 12:00
    ]);

    expect(result.map((d) => d.date)).toEqual(["2026-10-15", "2026-10-16"]);
    expect(result[0].countDistribution).toEqual({ 음악: 1 });
    expect(result[1].validCount).toBe(2);
    expect(result[1].countDistribution).toEqual({ 게임: 1 });
  });

  it("오프셋 표기가 섞여도 절대 시각으로 날짜를 정한다", () => {
    const result = aggregateViewingByDay([
      video({ categoryId: MUSIC, watchedAt: "2026-10-16T00:30:00+09:00" }),
      video({ categoryId: GAME, watchedAt: "2026-10-15T15:30:00Z" }), // = KST 10/16 00:30
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("2026-10-16");
  });

  it("본 시각이 없거나 파싱할 수 없는 기록은 날짜를 정할 수 없어 뺀다", () => {
    const result = aggregateViewingByDay([
      video({ categoryId: MUSIC, watchedAt: "2026-10-16T03:00:00Z" }),
      video({ categoryId: GAME, watchedAt: undefined }),
      video({ categoryId: GAME, watchedAt: "not-a-date" }),
    ]);

    expect(result.map((d) => d.date)).toEqual(["2026-10-16"]);

    expect(result).toHaveLength(1);
    expect(result[0].validCount).toBe(1);
  });
});

describe("aggregateViewing — 시청 시간이 확인된 유효 영상 수", () => {
  it("시청 시간을 아직 모르는 영상은 빼고, 분야를 못 가져온 영상은 센다", () => {
    const result = aggregateViewing([
      video({}),
      video({ categoryId: null }),
      video({ categoryId: GAME, watchedSeconds: null }),
      short({}),
    ]);

    expect(result.validCount).toBe(3);
    expect(result.confirmedCount).toBe(2);
  });
});

describe("aggregateViewing — 민감도 분석용 측정 정의 옵션", () => {
  const entries = [
    video({
      eventId: "a",
      categoryId: MUSIC,
      durationSeconds: 100,
      watchedSeconds: 400,
    }), // 길이보다 오래 봄
    video({
      eventId: "b",
      categoryId: SPORTS,
      durationSeconds: 600,
      watchedSeconds: 100,
    }),
    video({
      eventId: "c",
      categoryId: GAME,
      durationSeconds: 100,
      watchedSeconds: 20,
    }), // 20%
    video({
      eventId: "d",
      categoryId: GAME,
      durationSeconds: 100,
      watchedSeconds: null,
    }),
    short({ eventId: "e" }),
  ];

  it("옵션이 없으면 기본값을 직접 넘긴 것과 결과가 완전히 같다", () => {
    const base = aggregateViewing(entries);
    expect(aggregateViewing(entries, {})).toEqual(base);
    expect(
      aggregateViewing(entries, {
        capWatchSeconds: true,
        minRelativeRatio: 0.25,
      }),
    ).toEqual(base);
  });

  it("capWatchSeconds: false면 영상 길이로 자르지 않은 시청 시간으로 가중한다", () => {
    const capped = aggregateViewing(entries);
    const uncapped = aggregateViewing(entries, { capWatchSeconds: false });
    // 상한 적용: 음악 100초 vs 스포츠 100초 / 상한 없음: 음악 400초 vs 스포츠 100초
    expect(capped.weightedDistribution).toEqual({ 음악: 0.5, 스포츠: 0.5 });
    expect(uncapped.weightedDistribution).toEqual({ 음악: 0.8, 스포츠: 0.2 });
    expect(uncapped.weightedEntropy).toBeLessThan(capped.weightedEntropy);
    expect(uncapped.validCount).toBe(capped.validCount);
  });

  it("minRelativeRatio를 낮추면 짧게 본 영상이 유효 시청으로 들어온다", () => {
    expect(aggregateViewing(entries).validCount).toBe(3); // a, b, d
    const loose = aggregateViewing(entries, { minRelativeRatio: 0.1 });
    expect(loose.validCount).toBe(4); // c(20%) 추가
    expect(loose.weightedDistribution).toHaveProperty("게임");
    expect(
      aggregateViewing(entries, { minRelativeRatio: 0.5 }).validCount,
    ).toBe(3);
  });
});

describe("aggregateViewing — 엔트로피 정밀도", () => {
  it("엔트로피는 반올림 전 비율로 계산하고, 저장·화면용 분포는 반올림된 값 그대로다", () => {
    // 세 분야 같은 시간 → 원래 비율 1/3, 반올림 비율 0.333
    const entries = [
      video({ categoryId: MUSIC }),
      video({ categoryId: SPORTS }),
      video({ categoryId: GAME }),
    ];
    const result = aggregateViewing(entries);
    expect(result.analysisDistribution).toEqual({
      음악: 0.333,
      스포츠: 0.333,
      게임: 0.333,
    });
    expect(result.weightedDistribution).toEqual({
      음악: 0.333,
      스포츠: 0.333,
      게임: 0.333,
    });
    expect(result.entropy).toBeCloseTo(Math.log2(3), 12);
    expect(result.weightedEntropy).toBeCloseTo(Math.log2(3), 12);
    // 반올림 비율로 계산한 값(약 0.00014 작음)과 구별된다
    const fromRounded = -3 * (0.333 * Math.log2(0.333));
    expect(result.entropy).not.toBeCloseTo(fromRounded, 6);
  });
});
