// 기간 단위 리뷰 생성 파이프라인

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent";
const TIMEOUT_MS = 10000;

// 단일 카테고리 편중 경고 임계 비율
const BIAS_WARN_RATIO = 0.7;
// 패턴을 서술할 수 있다고 신뢰할 수 있는 최소 영상 수
const MIN_VIDEOS_FOR_PATTERN = 5;

// 세션 리뷰의 PROMPT_VERSION과 별도로 관리
const PROMPT_VERSION = "viewlens-period-mirror-v1.0";

// topRatio/videoCount를 LLM에게 줄 자연어 지시로 번역. 비교·증감이 없으므로
// "이 기간 자체가 어떤 모양이었는지"만 판단한다.
function buildPatternGuidance({ topRatio, videoCount }) {
  if (videoCount < MIN_VIDEOS_FOR_PATTERN) {
    return "- 이 기간은 시청한 영상 수가 적어 패턴을 단정하기 어렵습니다. 무엇을 봤는지 가볍게 비추는 정도로만 언급해 주세요.";
  }

  if (topRatio >= BIAS_WARN_RATIO) {
    return "- 시청이 한 주제에 크게 모여 있습니다. 그 쏠림을 부드럽고 또렷하게 사실로 비춰 주세요. 다양하게 보라는 권유나 지시는 하지 마세요.";
  }

  return "";
}

function buildPeriodPrompt({
  categoryDistribution,
  entropy,
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
  const patternGuidance = buildPatternGuidance({ topRatio, videoCount });
  const guidanceSection = patternGuidance
    ? `\n\n[피드백 작성 지침]\n${patternGuidance}`
    : "";

  return `당신은 참여자가 자신의 YouTube 콘텐츠 소비 패턴을 스스로 돌아볼 수 있도록 있는 그대로 비춰 주는 거울 같은 조력자입니다.

[기간 정보]
- 시청 영상 수: ${videoCount}개
- 카테고리 분포:
${categoryLines}
${entropyLine}${titleLines}${guidanceSection}

[피드백 원칙]
- 위에 제시된 카테고리 분포에만 근거하세요. 정치 성향·이념·성격 등 데이터로 알 수 없는 내용은 추론하거나 단정하지 마세요.
- 평가하거나 가르치려 들지 말고, 친근하고 중립적인 톤으로 참여자가 자신의 시청 패턴을 스스로 알아차리도록 돕는 데 집중하세요.
- 한 주제에 시청이 모여 있으면, 그 사실을 부드럽고 또렷하게 비춰 주세요. 단, "이렇게 하라"는 식의 행동 지시나 특정 카테고리 시청 권유는 하지 마세요. 무엇을 볼지는 전적으로 참여자가 결정합니다.
- 이전 기간과 비교하거나 증감을 언급하지 마세요. 이 기간 자체가 전반적으로 어떤 시청 기록이었는지만 서술하세요.
- entropy·통계·퍼센트 같은 수치나 전문 용어는 직접 노출하지 마세요.
- 시청한 영상 제목은 카테고리 판단을 보완하는 배경 정보로만 참고하세요. 제목을 언급할 때는 "OO 관련 영상"처럼 소재 수준으로만 지칭하고, 제목 속 특정 인물·정당·이슈에 대한 주장이나 논조는 절대 요약·평가하지 마세요.
- 이 기간 동안 있었던 여러 세션을 개별적으로 나열하지 말고, 기간 전체를 하나로 요약하세요.

아래 JSON 형식으로만 응답하세요. 다른 텍스트는 포함하지 마세요.

{
  "topic": "시청 카테고리 기반 주요 관심사를 5단어 이내 명사구로 (예: 과학과 기술)",
  "feedback": "위 원칙에 따른 2~3문장. 이 기간 동안 전반적으로 무엇을 봤는지 비추기 → (쏠림이 있으면) 그 사실을 알아차리게 하기. 행동을 처방하지 말고 관찰에서 멈출 것"
}`;
}

// 실패 사유를 period_reviews.failureReason 분류값으로 태깅한 에러.
function llmError(failureReason, message, extra = {}) {
  const err = new Error(message);
  err.failureReason = failureReason;
  return Object.assign(err, extra);
}

const SENSITIVE_PATTERN =
  /(?:진보|보수)\s*(?:성향|진영|정치|이념)|좌파|우파|좌익|우익|여당|야당|정당|국민의힘|민주당|대통령|국회의원|탄핵|친일|반일|극우|극좌/;

async function generatePeriodReview(prompt, apiKey) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const response = await fetch(GEMINI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 512 } },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("[period-review-llm] API error body:", errorBody);
      throw llmError("http_error", `Gemini API error: ${response.status}`, {
        httpStatus: response.status,
      });
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (timedOut) throw error;
      throw llmError(
        "parse_error",
        `응답 본문 JSON 파싱 실패: ${error.message}`,
      );
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

    return { topic, feedback, source: "llm", promptVersion: PROMPT_VERSION };
  } catch (error) {
    if (error.failureReason) throw error;
    if (timedOut)
      throw llmError("timeout", `Gemini API 타임아웃 (${TIMEOUT_MS}ms)`, {
        timedOut: true,
      });
    throw llmError("network_error", error.message);
  } finally {
    clearTimeout(timeoutId);
  }
}

function generatePeriodFallbackReview({ categoryDistribution, videoCount }) {
  const sorted = Object.entries(categoryDistribution).sort(
    ([, a], [, b]) => b - a,
  );

  if (sorted.length === 0) {
    return {
      topic: "분석 불가",
      feedback:
        "이 기간엔 분석할 시청 기록이 없어요. 다음 기간을 기대해 주세요!",
      source: "fallback",
      promptVersion: PROMPT_VERSION,
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
    summary = `이 기간에는 ${topName} 영상을 ${videoCount}개 집중적으로 시청하셨네요.`;
  } else if (topRatio > 0.5) {
    topic = topName;
    summary = `이 기간에는 주로 ${topName} 영상을 보셨고, ${sorted[1][0]} 영상도 함께 총 ${videoCount}개를 시청하셨어요.`;
  } else {
    topic = topNames;
    summary = `이 기간에는 ${topNames} 등 다양한 카테고리의 영상을 총 ${videoCount}개 고루 시청하셨네요.`;
  }

  let skewNote = "";
  if (videoCount >= MIN_VIDEOS_FOR_PATTERN && topRatio >= BIAS_WARN_RATIO) {
    skewNote = "특히 시청이 한 주제에 크게 모여 있었어요.";
  }

  const feedback = [summary, skewNote].filter(Boolean).join(" ");
  return { topic, feedback, source: "fallback", promptVersion: PROMPT_VERSION };
}

module.exports = {
  PROMPT_VERSION,
  buildPeriodPrompt,
  generatePeriodReview,
  generatePeriodFallbackReview,
};
