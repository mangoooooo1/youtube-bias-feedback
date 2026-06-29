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

// entropy는 소수점 둘째 자리로 반올림된 값(analysis.js)이므로, 부동소수점 오차로
// 경계(예: 정확히 0.1) 판정이 빗나가지 않도록 차이값도 같은 정밀도로 반올림
function roundedDelta(entropy, prevEntropy) {
  return Math.round((entropy - prevEntropy) * 100) / 100;
}

// prevEntropy 및 편중 비율을 LLM에게 줄 자연어 지시로 번역
function buildTrendGuidance({ entropy, prevEntropy, topRatio, videoCount }) {
  if (videoCount < MIN_VIDEOS_FOR_TREND) {
    return '- 이번 세션은 시청한 영상 수가 적어 패턴을 단정하기 어렵습니다. 무엇을 봤는지 가볍게 비추는 정도로만 언급해 주세요.';
  }

  const lines = [];

  if (Number.isFinite(prevEntropy)) {
    const delta = roundedDelta(entropy, prevEntropy);
    if (delta >= ENTROPY_DELTA_EPS) {
      lines.push('- 직전 세션보다 시청이 여러 주제로 다양해졌습니다. 이 변화를 담담한 사실로 비춰 주세요.');
    } else if (delta <= -ENTROPY_DELTA_EPS) {
      lines.push('- 직전 세션보다 시청이 더 적은 수의 주제에 모였습니다. 이 변화를 부드럽고 또렷하게 사실로 비춰 주세요.');
    } else {
      lines.push('- 직전 세션과 비슷한 다양성을 유지하고 있습니다. 이 사실을 중립적으로 비춰 주세요.');
    }
  }

  if (topRatio >= BIAS_WARN_RATIO) {
    lines.push('- 시청이 한 주제에 크게 모여 있습니다. 그 쏠림을 부드럽고 또렷하게 사실로 비춰 주세요. 다양하게 보라는 권유나 지시는 하지 마세요.');
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

  return `당신은 사용자가 자신의 YouTube 콘텐츠 소비 패턴을 스스로 돌아볼 수 있도록 있는 그대로 비춰 주는 거울 같은 조력자입니다.

[세션 정보]
- 시청 영상 수: ${videoCount}개
- 카테고리 분포:
${categoryLines}
${entropyLine}${titleLines}${trendSection}

[피드백 원칙]
- 위에 제시된 카테고리 분포와 다양성 변화에만 근거하세요. 정치 성향·이념·성격 등 데이터로 알 수 없는 내용은 추론하거나 단정하지 마세요.
- 평가하거나 가르치려 들지 말고, 친근하고 중립적인 톤으로 사용자가 자신의 시청 패턴을 스스로 알아차리도록 돕는 데 집중하세요.
- 한 주제에 시청이 모여 있으면, 그 사실을 부드럽고 또렷하게 비춰 주세요. 단, "이렇게 하라"는 식의 행동 지시나 특정 카테고리 시청 권유는 하지 마세요. 무엇을 볼지는 전적으로 사용자가 결정합니다.
- entropy·통계·퍼센트 같은 수치나 전문 용어는 직접 노출하지 마세요.

아래 JSON 형식으로만 응답하세요. 다른 텍스트는 포함하지 마세요.

{
  "topic": "시청 카테고리 기반 주요 관심사를 5단어 이내 명사구로 (예: 과학과 기술)",
  "feedback": "위 원칙에 따른 2~3문장. 무엇을 봤는지 비추기 → (쏠림이 있으면) 그 쏠림을 알아차리게 하기. 행동을 처방하지 말고 관찰에서 멈출 것"
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
    summary = `이번 세션에서는 주로 ${topName} 영상을 보셨고, ${sorted[1][0]} 영상도 함께 총 ${videoCount}개를 시청하셨어요.`;
  } else {
    topic = topNames;
    summary = `이번 세션에서는 ${topNames} 등 다양한 카테고리의 영상을 총 ${videoCount}개 고루 시청하셨네요.`;
  }

  // [변화 추세] + [쏠림] — 거울형: 사실만 비추고 권유·처방은 하지 않음
  let trend = '';
  let skewNote = '';
  if (videoCount >= MIN_VIDEOS_FOR_TREND) {
    const hasPrev = Number.isFinite(prevEntropy);
    const delta = hasPrev ? roundedDelta(entropy, prevEntropy) : 0;

    if (hasPrev) {
      if (delta >= ENTROPY_DELTA_EPS) trend = '직전 세션보다 여러 주제를 두루 보셨어요.';
      else if (delta <= -ENTROPY_DELTA_EPS) trend = '직전 세션보다 더 적은 수의 주제에 모여 있었어요.';
      else trend = '직전 세션과 비슷한 다양성이었어요.';
    }

    if (topRatio >= BIAS_WARN_RATIO) {
      skewNote = '특히 시청이 한 주제에 크게 모여 있었어요.';
    }
  }

  const feedback = [summary, trend, skewNote].filter(Boolean).join(' ');
  return { topic, feedback };
}
