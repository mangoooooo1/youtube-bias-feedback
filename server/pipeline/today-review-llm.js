// "오늘" 탭 누적 리뷰 생성 파이프라인
const { SENSITIVE_PATTERN } = require("./sensitive-pattern");

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const TIMEOUT_MS = 10000;

// 다양성 변화로 인정할 최소 entropy 변화량(bits)
const ENTROPY_DELTA_EPS = 0.1;
// 단일 카테고리 편중 경고 임계 비율
const BIAS_WARN_RATIO = 0.7;
// 변화 분석/편중 경고를 신뢰할 수 있는 최소 영상 수
const MIN_VIDEOS_FOR_TREND = 5;

// 파일럿 완료 후 커밋 태그로 동결
// 본조사 중에는 buildTodayCumulativePrompt 문구를 바꾸지 않고, 부득이하게 바꿀 때만 이 값을 올려 세션에 함께 저장된 값으로 처치 시점을 구분한다.
const TODAY_PROMPT_VERSION = "viewlens-today-mirror-v1.0";

// entropy는 소수점 둘째 자리로 반올림된 값이므로, 부동소수점 오차로
// 경계(예: 정확히 0.1) 판정이 빗나가지 않도록 차이값도 같은 정밀도로 반올림
function roundedDelta(entropy, prevEntropy) {
  return Math.round((entropy - prevEntropy) * 100) / 100;
}

// prevEntropy 및 편중 비율을 LLM에게 줄 자연어 지시로 번역
// 비교 단위는 "직전 세션"이 아니라 "직전 시청일"이다(prevEntropy로 넘어오는 값 자체가
// 이전 세션이 아니라 이전 시청일의 entropy).
function buildTodayTrendGuidance({
  entropy,
  prevEntropy,
  topRatio,
  videoCount,
}) {
  if (videoCount < MIN_VIDEOS_FOR_TREND) {
    return "- 오늘은 시청한 영상 수가 적어 패턴을 단정하기 어렵습니다. 무엇을 봤는지 가볍게 비추는 정도로만 언급해 주세요.";
  }

  const lines = [];
  const TONE = "부드럽고 또렷하게";

  if (Number.isFinite(prevEntropy)) {
    const delta = roundedDelta(entropy, prevEntropy);
    if (delta >= ENTROPY_DELTA_EPS) {
      lines.push(
        `- 직전 시청일보다 오늘 시청이 여러 주제로 다양해졌습니다. 이 변화를 ${TONE} 사실로 비춰 주세요.`,
      );
    } else if (delta <= -ENTROPY_DELTA_EPS) {
      lines.push(
        `- 직전 시청일보다 오늘 시청이 더 적은 수의 주제에 모였습니다. 이 변화를 ${TONE} 사실로 비춰 주세요.`,
      );
    } else {
      lines.push(
        "- 직전 시청일과 비슷한 다양성을 유지하고 있습니다. 이 사실을 중립적으로 비춰 주세요.",
      );
    }
  }

  if (topRatio >= BIAS_WARN_RATIO) {
    lines.push(
      `- 시청이 한 주제에 크게 모여 있습니다. 그 쏠림을 ${TONE} 사실로 비춰 주세요. 다양하게 보라는 권유나 지시는 하지 마세요.`,
    );
  }

  return lines.join("\n");
}

// "오늘" 탭 누적 리뷰 프롬프트 — buildPrompt와 [피드백 원칙]·JSON 응답 형식은
// 문자 그대로 동일하게 유지하고, 근거 범위만 "이번 세션"에서 "오늘 하루 전체"로 바꾼다.
// categoryDistribution/entropy/videoCount/videoTitles는 오늘의 여러 세션을 병합 집계한 값이다.
function buildTodayCumulativePrompt({
  categoryDistribution,
  entropy,
  prevEntropy = null,
  videoCount,
  videoTitles = [],
}) {
  const sorted = Object.entries(categoryDistribution).sort(
    ([, a], [, b]) => b - a,
  );

  const categoryLines = sorted
    .map(([name, ratio]) => `  · ${name}: ${Math.round(ratio * 100)}%`)
    .join("\n");

  const categoryCount = sorted.length;
  const maxEntropy =
    categoryCount > 1 ? Math.log2(categoryCount).toFixed(2) : null;
  const entropyLine =
    maxEntropy !== null
      ? `- 다양성 지수: ${entropy} (최대 ${maxEntropy})`
      : `- 다양성 지수: ${entropy}`;

  const titleLines =
    videoTitles.length > 0
      ? `\n- 시청한 영상 제목:\n${videoTitles
          .slice(0, 10)
          .map((t) => `  · ${t}`)
          .join("\n")}`
      : "";

  const topRatio = sorted.length > 0 ? sorted[0][1] : 0;
  const trendGuidance = buildTodayTrendGuidance({
    entropy,
    prevEntropy,
    topRatio,
    videoCount,
  });
  const trendSection = trendGuidance
    ? `\n\n[피드백 작성 지침]\n${trendGuidance}`
    : "";

  return `당신은 사용자가 자신의 YouTube 콘텐츠 소비 패턴을 스스로 돌아볼 수 있도록 있는 그대로 비춰 주는 거울 같은 조력자입니다.

[오늘 정보]
- 오늘 시청한 영상 수: ${videoCount}개
- 카테고리 분포:
${categoryLines}
${entropyLine}${titleLines}${trendSection}

[피드백 원칙]
- 위에 제시된 카테고리 분포와 다양성 변화에만 근거하세요. 정치 성향·이념·성격 등 데이터로 알 수 없는 내용은 추론하거나 단정하지 마세요.
- 평가하거나 가르치려 들지 말고, 친근하고 중립적인 톤으로 사용자가 자신의 시청 패턴을 스스로 알아차리도록 돕는 데 집중하세요.
- 한 주제에 시청이 모여 있으면, 그 사실을 부드럽고 또렷하게 비춰 주세요. 단, "이렇게 하라"는 식의 행동 지시나 특정 카테고리 시청 권유는 하지 마세요. 무엇을 볼지는 전적으로 사용자가 결정합니다.
- entropy·통계·퍼센트 같은 수치나 전문 용어는 직접 노출하지 마세요.
- 시청한 영상 제목은 카테고리 판단을 보완하는 배경 정보로만 참고하세요. 제목을 언급할 때는 "OO 관련 영상"처럼 소재 수준으로만 지칭하고, 제목 속 특정 인물·정당·이슈에 대한 주장이나 논조는 절대 요약·평가하지 마세요.
- 오늘 있었던 여러 세션을 개별적으로 나열하지 말고, 오늘 하루 전체를 하나로 요약하세요.

아래 JSON 형식으로만 응답하세요. 다른 텍스트는 포함하지 마세요.

{
  "topic": "시청 카테고리 기반 주요 관심사를 5단어 이내 명사구로 (예: 과학과 기술)",
  "feedback": "위 원칙에 따른 2~3문장. 오늘 전반적으로 무엇을 봤는지 비추기 → (쏠림이 있으면) 그 쏠림을 알아차리게 하기. 행동을 처방하지 말고 관찰에서 멈출 것"
}`;
}

// 실패 사유를 sessions.failureReason 분류값으로 태깅한 에러.
function llmError(failureReason, message, extra = {}) {
  const err = new Error(message);
  err.failureReason = failureReason;
  return Object.assign(err, extra);
}

async function generateTodayReview(prompt, apiKey) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);

  let response;
  try {
    response = await fetch(GEMINI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // "생각" 토큰 상한을 안 두면 프롬프트가 복잡할수록 thinking에 쓰는 시간이 늘어나
        // TIMEOUT_MS(10초)를 넘겨 timeout으로 폴백되는 사례를 실측으로 확인했다
        generationConfig: { thinkingConfig: { thinkingBudget: 512 } },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut)
      throw llmError("timeout", `Gemini API 타임아웃 (${TIMEOUT_MS}ms)`, {
        timedOut: true,
      });
    throw llmError("network_error", error.message);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("[today-review-llm] API error body:", errorBody);
    throw llmError("http_error", `Gemini API error: ${response.status}`, {
      httpStatus: response.status,
    });
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw llmError("parse_error", `응답 본문 JSON 파싱 실패: ${error.message}`);
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text)
    throw llmError("empty_response", "Gemini API: 응답에 텍스트가 없습니다");

  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "");
  let topic, feedback;
  try {
    const parsed = JSON.parse(cleaned);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      typeof parsed.topic !== "string" ||
      typeof parsed.feedback !== "string" ||
      parsed.topic.trim() === "" ||
      parsed.feedback.trim() === ""
    ) {
      throw new Error("topic/feedback 누락, 빈 값 또는 잘못된 타입");
    }
    topic = parsed.topic;
    feedback = parsed.feedback;
  } catch (error) {
    throw llmError("parse_error", `피드백 JSON 파싱 실패: ${error.message}`);
  }

  if (SENSITIVE_PATTERN.test(feedback) || SENSITIVE_PATTERN.test(topic)) {
    throw llmError(
      "policy_filtered",
      "정치·이념 관련 표현이 감지되어 폴백으로 대체",
    );
  }

  return {
    topic,
    feedback,
    source: "llm",
    promptVersion: TODAY_PROMPT_VERSION,
  };
}

// "오늘" 누적 리뷰의 폴백
function generateTodayFallbackReview({
  categoryDistribution,
  entropy,
  prevEntropy = null,
  videoCount,
}) {
  const sorted = Object.entries(categoryDistribution).sort(
    ([, a], [, b]) => b - a,
  );

  if (sorted.length === 0) {
    return {
      topic: "분석 불가",
      feedback:
        "오늘의 시청 데이터를 분석하지 못했습니다. 잠시 후 다시 확인해 주세요!",
      source: "fallback",
      promptVersion: TODAY_PROMPT_VERSION,
    };
  }

  const [topName, topRatio] = sorted[0];
  const topNames = sorted
    .slice(0, 3)
    .map(([name]) => name)
    .join(", ");

  let summary;
  let topic;
  if (sorted.length === 1) {
    topic = topName;
    summary = `오늘은 ${topName} 영상을 ${videoCount}개 집중적으로 시청하셨네요.`;
  } else if (topRatio > 0.5) {
    topic = topName;
    summary = `오늘은 주로 ${topName} 영상을 보셨고, ${sorted[1][0]} 영상도 함께 총 ${videoCount}개를 시청하셨어요.`;
  } else {
    topic = topNames;
    summary = `오늘은 ${topNames} 등 다양한 카테고리의 영상을 총 ${videoCount}개 고루 시청하셨네요.`;
  }

  let trend = "";
  let skewNote = "";
  if (videoCount >= MIN_VIDEOS_FOR_TREND) {
    const hasPrev = Number.isFinite(prevEntropy);
    const delta = hasPrev ? roundedDelta(entropy, prevEntropy) : 0;

    if (hasPrev) {
      if (delta >= ENTROPY_DELTA_EPS)
        trend = "직전 시청일보다 여러 주제를 두루 보셨어요.";
      else if (delta <= -ENTROPY_DELTA_EPS)
        trend = "직전 시청일보다 더 적은 수의 주제에 모여 있었어요.";
      else trend = "직전 시청일과 비슷한 다양성이었어요.";
    }

    if (topRatio >= BIAS_WARN_RATIO) {
      skewNote = "특히 시청이 한 주제에 크게 모여 있었어요.";
    }
  }

  const feedback = [summary, trend, skewNote].filter(Boolean).join(" ");
  return {
    topic,
    feedback,
    source: "fallback",
    promptVersion: TODAY_PROMPT_VERSION,
  };
}

module.exports = {
  TODAY_PROMPT_VERSION,
  buildTodayCumulativePrompt,
  generateTodayReview,
  generateTodayFallbackReview,
};
