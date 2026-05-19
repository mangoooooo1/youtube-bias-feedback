import { GEMINI_API_KEY } from './config.js';

const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const TIMEOUT_MS = 10000;

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

export async function generateReview(prompt) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('[llm] API error body:', errorBody);
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini API: 응답에 텍스트가 없습니다');

    return text.trim();
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

export function generateFallbackReview({ categoryDistribution, videoCount }) {
  const sorted = Object.entries(categoryDistribution).sort(([, a], [, b]) => b - a);

  if (sorted.length === 0) {
    return '이번 세션의 시청 데이터를 분석하지 못했습니다. 다음 세션을 기대해 주세요!';
  }

  const [topName, topRatio] = sorted[0];

  if (sorted.length === 1) {
    return `이번 세션에서는 ${topName} 영상을 집중적으로 시청하셨네요. ${videoCount}개의 영상을 보셨습니다. 다음에는 다른 카테고리의 콘텐츠도 탐색해 보세요!`;
  }

  const [secondName] = sorted[1];

  if (topRatio > 0.5) {
    return `이번 세션에서는 주로 ${topName} 콘텐츠를 즐기셨고, ${secondName} 영상도 함께 시청하셨네요. 총 ${videoCount}개의 영상을 보셨습니다. 더 다양한 카테고리를 탐색해 보시는 건 어떨까요?`;
  }

  const topNames = sorted
    .slice(0, 3)
    .map(([name]) => name)
    .join(', ');
  return `이번 세션에서는 ${topNames} 등 다양한 카테고리의 영상을 고루 시청하셨네요. 총 ${videoCount}개의 영상을 보셨습니다. 균형 잡힌 시청 패턴을 잘 유지하고 계세요!`;
}
