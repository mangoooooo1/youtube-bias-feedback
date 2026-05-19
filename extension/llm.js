import { GEMINI_API_KEY } from './config.js';

const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

export function buildPrompt({ categoryDistribution, entropy, videoCount }) {
  const sorted = Object.entries(categoryDistribution).sort(([, a], [, b]) => b - a);

  const categoryLines = sorted
    .map(([name, ratio]) => `  · ${name}: ${Math.round(ratio * 100)}%`)
    .join('\n');

  const categoryCount = sorted.length;
  const maxEntropy = categoryCount > 1 ? Math.log2(categoryCount).toFixed(2) : null;
  const entropyLine =
    maxEntropy !== null
      ? `- 다양성 지수: ${entropy} (최대 ${maxEntropy})`
      : `- 다양성 지수: ${entropy}`;

  return `당신은 YouTube 시청 패턴을 분석하는 친근한 조언자입니다.

[세션 정보]
- 시청 영상 수: ${videoCount}개
- 카테고리 분포:
${categoryLines}
${entropyLine}

위 데이터를 바탕으로 이 사용자의 시청 패턴에 대한 피드백을 2~3문장으로 작성해주세요.
조건: 한국어로, 친근하고 중립적인 톤으로, 수치나 통계 용어를 직접 사용하지 말고 자연스럽게 표현해주세요.`;
}
