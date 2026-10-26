import { describe, it, expect } from "vitest";
import {
  shareBasis,
  sharePercents,
  sharesSentence,
} from "../../pipeline/review-prompt-format.js";

const sentence = (timeDistribution) =>
  sharesSentence(shareBasis({ timeDistribution }));

describe("sharesSentence — 대체 문구의 비중 문장", () => {
  it("분야가 하나면 '모두'로 말하고, 받침에 맞춰 이었어요/였어요를 붙인다", () => {
    expect(sentence({ 음악: 1 })).toBe("시청 시간은 모두 음악이었어요.");
    expect(sentence({ 스포츠: 1 })).toBe("시청 시간은 모두 스포츠였어요.");
  });

  it("여럿이면 1위를 '가장 많았어요'로, 나머지(최대 2개)를 '그다음은'으로 말한다", () => {
    expect(sentence({ 음악: 0.5, 게임: 0.3, 교육: 0.15, 스포츠: 0.05 })).toBe(
      "전체 시청 시간 중 음악이 50%로 가장 많았어요. 그다음은 게임 30%, 교육 15%였어요.",
    );
    expect(sentence({ 스포츠: 0.7, 음악: 0.3 })).toBe(
      "전체 시청 시간 중 스포츠가 70%로 가장 많았어요. 그다음은 음악 30%였어요.",
    );
  });

  it("1·2위가 같으면 '각각'으로 함께 말하고, 받침에 맞춰 과/와를 붙인다", () => {
    expect(sentence({ 게임: 0.5, 음악: 0.5 })).toBe(
      "전체 시청 시간 중 게임과 음악이 각각 50%로 가장 많았어요.",
    );
    expect(sentence({ 스포츠: 0.4, 게임: 0.4, 교육: 0.2 })).toBe(
      "전체 시청 시간 중 스포츠와 게임이 각각 40%로 가장 많았어요. 그다음은 교육 20%였어요.",
    );
  });
});

describe("sharePercents — 오늘 리뷰 재생성 판단에 저장하는 정수 %", () => {
  it("분야마다 프롬프트와 같은 반올림으로 정수 %를 만든다", () => {
    expect(
      sharePercents({ timeDistribution: { 음악: 0.614, 게임: 0.386 } }),
    ).toEqual({ 음악: 61, 게임: 39 });
    expect(
      sharePercents({ timeDistribution: { 음악: 0.616, 게임: 0.384 } }),
    ).toEqual({ 음악: 62, 게임: 38 });
  });

  it("분포가 비어 있으면 빈 객체를 돌려준다", () => {
    expect(sharePercents({ timeDistribution: {} })).toEqual({});
    expect(sharePercents({})).toEqual({});
  });
});
