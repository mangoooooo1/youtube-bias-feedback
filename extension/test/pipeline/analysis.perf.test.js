import { describe, it, expect } from "vitest";
import { aggregateDailyData } from "../../pipeline/analysis.js";

// 80명 규모 확대를 앞두고, aggregateDailyData(참여자 1명의 세션 목록)가
// 실제로 다룰 수 있는 세션 수 구간에서 처리 시간이 어떻게 변하는지 실측·기록한다.
// 회귀를 좁게 검증하는 테스트가 아니라 관찰 기록이므로, 임계값은 "명백한 성능
// 재앙(예: 실수로 O(n^2) 코드가 섞임)"만 잡아내도록 넉넉하게 잡는다.

function buildSessions(count) {
  const categories = ["게임", "음악", "뉴스 & 정치", "코미디", "교육"];
  const now = Date.now();
  const sessions = [];
  for (let i = 0; i < count; i++) {
    const categoryDistribution = {};
    let remaining = 1;
    for (let c = 0; c < categories.length - 1; c++) {
      const share = Math.round(((remaining * Math.random()) / 2) * 1000) / 1000;
      categoryDistribution[categories[c]] = share;
      remaining -= share;
    }
    categoryDistribution[categories[categories.length - 1]] =
      Math.round(remaining * 1000) / 1000;

    sessions.push({
      endTime: new Date(now - (i % 7) * 86400000 - i * 1000).toISOString(),
      videoCount: 1 + (i % 20),
      categoryDistribution,
    });
  }
  return sessions;
}

describe("aggregateDailyData 성능 실측 (P2-④, 관찰용)", () => {
  it.each([100, 1000])("세션 %i개를 넉넉한 시간 안에 처리한다", (count) => {
    const sessions = buildSessions(count);

    const start = performance.now();
    const result = aggregateDailyData(sessions);
    const elapsedMs = performance.now() - start;

    console.log(
      `[perf] aggregateDailyData(${count}건) = ${elapsedMs.toFixed(2)}ms`,
    );

    expect(result.dates).toHaveLength(7);
    // O(n) 구조 기준 정상 범위의 수십~수백 배 여유를 둔 넉넉한 상한.
    // 이 값을 넘기면 알고리즘 복잡도 자체가 바뀐 것으로 의심할 수 있다.
    expect(elapsedMs).toBeLessThan(2000);
  });
});
