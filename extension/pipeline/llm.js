import { GEMINI_API_KEY } from '../config.js';

const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const TIMEOUT_MS = 10000;

// 다양성 변화로 인정할 최소 entropy 변화량(bits) — 노이즈 무시
const ENTROPY_DELTA_EPS = 0.1;
// 단일 카테고리 편중 경고 임계 비율
const BIAS_WARN_RATIO = 0.7;
// 변화 분석/편중 경고를 신뢰할 수 있는 최소 영상 수
const MIN_VIDEOS_FOR_TREND = 5;

// prevEntropy 및 편중 비율을 LLM에게 줄 자연어 지시로 번역
function buildTrendGuidance({ entropy, prevEntropy, topRatio, videoCount }) {
  if (videoCount < MIN_VIDEOS_FOR_TREND) {
    return '- 이번 세션은 시청한 영상 수가 적어 패턴을 단정하기 어렵습니다. 단정적인 평가나 강한 권유는 피하고 가볍게 언급해 주세요.';
  }

  const lines = [];

  if (Number.isFinite(prevEntropy)) {
    const delta = entropy - prevEntropy;
    if (delta >= ENTROPY_DELTA_EPS) {
      lines.push('- 직전 세션보다 시청 다양성이 늘었습니다. 긍정적으로 격려하는 톤으로 작성해 주세요.');
    } else if (delta <= -ENTROPY_DELTA_EPS) {
      lines.push('- 직전 세션보다 시청 다양성이 줄었습니다. 다양한 카테고리를 탐색해 보도록 부드럽게 권장해 주세요.');
    } else {
      lines.push('- 직전 세션과 비슷한 다양성을 유지하고 있습니다. 중립적인 톤으로 현재 패턴을 언급해 주세요.');
    }
  }

  if (topRatio >= BIAS_WARN_RATIO) {
    lines.push('- 한 카테고리에 시청이 크게 쏠려 있습니다. 다양한 카테고리를 탐색해 보도록 권장하는 문구를 반드시 포함해 주세요.');
  }

  return lines.join('\n');
}

export function buildPrompt({ categoryDistribution, entropy, prevEntropy = null, videoCount, videoTitles = [] }) {
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

  const titleLines = videoTitles.length > 0
    ? `\n- 시청한 영상 제목:\n${videoTitles.slice(0, 10).map(t => `  · ${t}`).join('\n')}`
    : '';

  const topRatio = sorted.length > 0 ? sorted[0][1] : 0;
  const trendGuidance = buildTrendGuidance({ entropy, prevEntropy, topRatio, videoCount });
  const trendSection = trendGuidance ? `\n\n[피드백 작성 지침]\n${trendGuidance}` : '';

  return `당신은 YouTube 시청 패턴을 분석하는 친근한 조언자입니다.

[세션 정보]
- 시청 영상 수: ${videoCount}개
- 카테고리 분포:
${categoryLines}
${entropyLine}${titleLines}${trendSection}

위 데이터를 바탕으로 아래 JSON 형식으로만 응답해주세요. 다른 텍스트는 포함하지 마세요.

{
  "topic": "영상 제목과 카테고리를 보고 이 사용자의 주요 관심사를 5단어 이내 명사구로 (예: 과학과 기술, 음악과 일상)",
  "feedback": "시청 패턴에 대한 피드백 2~3문장. 한국어로, 친근하고 중립적인 톤으로, 수치나 통계 용어를 직접 사용하지 말고 자연스럽게 표현"
}`;
}

export async function generateReview(prompt) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
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

    const cleaned = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(cleaned);
    const isObj = parsed && typeof parsed === 'object';
    return { topic: (isObj && parsed.topic) || '', feedback: (isObj && parsed.feedback) || cleaned };
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

export function generateFallbackReview({ categoryDistribution, entropy, prevEntropy = null, videoCount }) {
  const sorted = Object.entries(categoryDistribution).sort(([, a], [, b]) => b - a);

  if (sorted.length === 0) {
    return { topic: '', feedback: '이번 세션의 시청 데이터를 분석하지 못했습니다. 다음 세션을 기대해 주세요!' };
  }

  const [topName, topRatio] = sorted[0];
  const topNames = sorted.slice(0, 3).map(([name]) => name).join(', ');

  // [무엇을 봤는지]
  let summary;
  let topic;
  if (sorted.length === 1) {
    topic = topName;
    summary = `이번 세션에서는 ${topName} 영상을 ${videoCount}개 집중적으로 시청하셨네요.`;
  } else if (topRatio > 0.5) {
    topic = topName;
    summary = `이번 세션에서는 주로 ${topName} 콘텐츠를 즐기셨고, ${sorted[1][0]} 영상도 함께 총 ${videoCount}개를 시청하셨네요.`;
  } else {
    topic = topNames;
    summary = `이번 세션에서는 ${topNames} 등 다양한 카테고리의 영상을 총 ${videoCount}개 고루 시청하셨네요.`;
  }

  // [변화 추세] + [권장/격려] — 프롬프트 경로와 동일한 상수/임계값 사용
  let trend = '';
  let recommendation = '';
  if (videoCount >= MIN_VIDEOS_FOR_TREND) {
    const hasPrev = Number.isFinite(prevEntropy);
    const delta = hasPrev ? entropy - prevEntropy : 0;

    if (hasPrev) {
      if (delta >= ENTROPY_DELTA_EPS) trend = '직전 세션보다 시청 다양성이 늘었어요.';
      else if (delta <= -ENTROPY_DELTA_EPS) trend = '직전 세션보다 시청 다양성이 다소 줄었어요.';
      else trend = '직전 세션과 비슷한 다양성을 유지하고 있어요.';
    }

    if (topRatio >= BIAS_WARN_RATIO) {
      recommendation = '한 가지 주제에 시청이 크게 쏠려 있으니, 다양한 카테고리를 탐색해 보시는 건 어떨까요?';
    } else if (hasPrev && delta <= -ENTROPY_DELTA_EPS) {
      recommendation = '다른 주제의 콘텐츠도 곁들여 보시는 걸 추천해요.';
    } else if (hasPrev && delta >= ENTROPY_DELTA_EPS) {
      recommendation = '균형 잡힌 시청 패턴을 잘 유지하고 계세요!';
    }
  }

  const feedback = [summary, trend, recommendation].filter(Boolean).join(' ');
  return { topic, feedback };
}
