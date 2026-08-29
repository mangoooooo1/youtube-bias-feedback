import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mergeSessionDistributions } from "../../../server/pipeline/period-boundaries.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWLENS_POPUP_PATH = path.join(__dirname, "../../popup/viewlens-popup.js");

// viewlens-popup.js는 DOM/전역 VL 객체에 크게 의존하는 1200줄짜리 classic script라
// 파일 전체를 그대로 실행할 수 없다(document 접근, 이벤트 리스너 등록 등으로 즉시 예외).
// mergeDist는 CAT_NAME_TO_KEY/toVlKey에만 의존하는 순수 함수라, 이 세 선언만 정규식으로
// 추출해 격리 실행한다(운영 코드 변경 없음). 각 정규식은 "다음 줄 맨 앞 칸(들여쓰기 없음)의
// 닫는 중괄호"에서 멈추도록 만들어, 함수 본문 안의 들여쓰기된 중괄호에서 조기 종료되지 않는다.
const CAT_MAP_DECL = /const CAT_NAME_TO_KEY = \{[\s\S]*?\n\};/;
const TO_VL_KEY_DECL = /function toVlKey\(catName\) \{[\s\S]*?\n\}/;
const MERGE_DIST_DECL = /function mergeDist\(sessions\) \{[\s\S]*?\n\}/;

function loadMergeDistAndToVlKey() {
  const raw = readFileSync(VIEWLENS_POPUP_PATH, "utf8");
  const blocks = [CAT_MAP_DECL, TO_VL_KEY_DECL, MERGE_DIST_DECL].map((re) => {
    const match = raw.match(re);
    if (!match) {
      throw new Error(
        `${re}에 매칭되는 선언을 찾지 못했습니다 — viewlens-popup.js 구조가 바뀌었을 수 있습니다.`,
      );
    }
    return match[0];
  });
  return new Function(`${blocks.join("\n")}\nreturn { mergeDist, toVlKey };`)();
}

// 서버(mergeSessionDistributions)는 원본 카테고리명을 그대로 키로 쓰는 반면, 팝업(mergeDist)은
// toVlKey로 축약 키로 묶은 뒤 병합한다 — 두 함수의 출력 형태 자체가 다르므로 곧바로 비교할 수
// 없다. 대신 "서버 결과를 같은 toVlKey로 재매핑하면 팝업 결과와 같아야 한다"를 동치성 기준으로
// 삼는다. 이게 성립하면 두 곳의 videoCount 가중 병합·정규화 로직이 실제로 같은 계산이라는 뜻이다.
function remapToVlKeys(categoryDistribution, toVlKey) {
  const merged = {};
  for (const [catName, ratio] of Object.entries(categoryDistribution)) {
    const k = toVlKey(catName);
    merged[k] = (merged[k] ?? 0) + ratio;
  }
  return merged;
}

describe("mergeDist(팝업) ↔ mergeSessionDistributions(서버) 동치성", () => {
  let mergeDist;
  let toVlKey;

  beforeAll(() => {
    ({ mergeDist, toVlKey } = loadMergeDistAndToVlKey());
  });

  it("빈 세션 배열이면 둘 다 빈 객체를 반환한다", () => {
    expect(mergeDist([])).toEqual({});
    expect(mergeSessionDistributions([]).categoryDistribution).toEqual({});
  });

  it("videoCount를 명시한 여러 세션에 대해, 서버 결과를 toVlKey로 재매핑하면 팝업 결과와 같다", () => {
    const sessions = [
      { videoCount: 2, categoryDistribution: { 음악: 0.5, 게임: 0.5 } },
      // "코미디"/"영화 & 애니메이션"은 둘 다 toVlKey로 "ent"에 묶인다 —
      // 병합 순서(축약 후 합산 vs 합산 후 축약)가 결과에 영향 없는지 검증
      { videoCount: 3, categoryDistribution: { 코미디: 0.4, "영화 & 애니메이션": 0.6 } },
      { videoCount: 1, categoryDistribution: { 존재하지않는카테고리: 1 } }, // toVlKey 폴백("etc") 검증
    ];

    const popupResult = mergeDist(sessions);
    const serverRemapped = remapToVlKeys(
      mergeSessionDistributions(sessions).categoryDistribution,
      toVlKey,
    );

    const allKeys = new Set([
      ...Object.keys(popupResult),
      ...Object.keys(serverRemapped),
    ]);
    expect(allKeys.size).toBeGreaterThan(0);
    for (const key of allKeys) {
      expect(popupResult[key] ?? 0).toBeCloseTo(serverRemapped[key] ?? 0, 9);
    }
  });

  it("세션이 1개뿐이면 그 세션의 분포를 toVlKey로 축약한 값과 같다", () => {
    const sessions = [{ videoCount: 4, categoryDistribution: { 음악: 1 } }];
    const popupResult = mergeDist(sessions);
    const serverRemapped = remapToVlKeys(
      mergeSessionDistributions(sessions).categoryDistribution,
      toVlKey,
    );
    expect(popupResult).toEqual(serverRemapped);
  });

  // 발견된 불일치 — 고의로 다르게 만든 게 아니라 코드를 읽다가 실제로 찾은 차이다.
  // mergeDist(및 extension/pipeline/analysis.js)는 videoCount가 없으면 videos.length로,
  // 그마저 없으면 1로 폴백한다. 반면 mergeSessionDistributions(서버)는 videoCount ?? 1까지만
  // 폴백하고 videos.length는 보지 않는다 — videoCount가 비어있는(오래된/결손) 세션 데이터에서는
  // 두 구현이 서로 다른 가중치를 계산한다.
  // 확인 결과 실사용 영향 없음(운영 DB 확인 완료, 2026-08-29 — 서울 A1에서
  // `sessions.videoCount IS NULL AND categoryDistribution IS NOT NULL` 0건 확인).
  // 서버 세션 객체는 DB에 videos 컬럼이 없어 애초에 이 폴백을 못 타므로, 두 구현의
  // 폴백 정책을 억지로 통일해도 죽은 코드가 될 뿐이다. 그래서 수정하지 않고 현재 동작을
  // 그대로 고정해 문서화한다(결정 근거: docs/07-작업5.md 이슈 1).
  it("videoCount가 없고 videos 배열만 있으면 서버·팝업의 가중치 계산이 서로 다르다 (알려진 불일치, 결정 완료 — 영향 없음)", () => {
    const sessions = [
      { videos: [{}, {}, {}], categoryDistribution: { 음악: 1 } }, // videoCount 없음, videos.length=3
      { videoCount: 1, categoryDistribution: { 게임: 1 } },
    ];

    const popupResult = mergeDist(sessions);
    // 팝업: videos.length(3) 폴백 적용 → 가중치 3:1
    expect(popupResult.music).toBeCloseTo(0.75, 9);
    expect(popupResult.game).toBeCloseTo(0.25, 9);

    const serverResult = mergeSessionDistributions(sessions).categoryDistribution;
    // 서버: videoCount ?? 1까지만 폴백(videos.length 미고려) → 가중치 1:1
    expect(serverResult.음악).toBeCloseTo(0.5, 9);
    expect(serverResult.게임).toBeCloseTo(0.5, 9);
  });
});
