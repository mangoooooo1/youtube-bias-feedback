// "오늘" 탭 누적 리뷰 생성 파이프라인
const { SENSITIVE_PATTERN } = require("./sensitive-pattern");
const { oneLine } = require("../log-line");
const { MIN_VALID_VIDEOS_PER_DAY } = require("./study-constants");
const {
  shareBasis,
  formatShares,
  formatTitleGroups,
  sharesSentence,
} = require("./review-prompt-format");

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent";
const TIMEOUT_MS = 10000;
// Gemini 오류 응답은 여러 줄 JSON이고 길이를 알 수 없어 한 줄로 만들고 자른다
const ERROR_BODY_MAX_LENGTH = 1000;

// 파일럿 완료 후 커밋 태그로 동결
// 본조사 중에는 buildTodayCumulativePrompt 문구를 바꾸지 않고, 부득이하게 바꿀 때만 이 값을 올려 세션에 함께 저장된 값으로 처치 시점을 구분한다.
// v2.0: 유효 시청·시청 시간 비중·카테고리별 제목 묶음 입력, 다양성 지수·직전 시청일 비교·70% 쏠림 지시 제거
const TODAY_PROMPT_VERSION = "viewlens-today-mirror-v2.0";

// "오늘" 탭 누적 리뷰 프롬프트: 오늘 본 영상 기록에서 직접 집계한 값(aggregateTodayCumulative)을 받는다.
function buildTodayCumulativePrompt({
  validVideoCount,
  timeDistribution,
  titleGroups = [],
}) {
  const basis = shareBasis({ timeDistribution });

  // 시청이 적은 날: 하루치로는 패턴을 말하기 어렵다는 점을 밝힌다
  const fewVideosSection =
    validVideoCount < MIN_VALID_VIDEOS_PER_DAY
      ? `\n\n[피드백 작성 지침]\n- 오늘은 시청한 영상이 적어 패턴을 단정하기 어렵습니다. 무엇을 봤는지 가볍게 비추고, 영상이 적어 정확한 피드백은 아니라는 점을 한 문장으로 밝혀 주세요.`
      : "";

  return `당신은 사용자가 자신의 YouTube 콘텐츠 소비 패턴을 스스로 돌아볼 수 있도록 있는 그대로 비춰 주는 거울 같은 조력자입니다.

[오늘 정보]
- 오늘 시청한 영상 수: ${validVideoCount}개 (30초 이상 보거나 영상 길이의 4분의 1 이상 본 영상만 셈)
${formatShares(basis)}${formatTitleGroups(titleGroups)}${fewVideosSection}

[피드백 원칙]
- 위에 제시된 분야별 비중과 영상 제목에만 근거하세요. 정치 성향·이념·성격 등 데이터로 알 수 없는 내용은 추론하거나 단정하지 마세요.
- 평가하거나 가르치려 들지 말고, 친근하고 중립적인 톤으로 사용자가 자신의 시청 패턴을 스스로 알아차리도록 돕는 데 집중하세요.
- 비중을 말할 때는 위에 적힌 퍼센트만 그대로 쓰세요(예: "음악이 시청 시간의 62%였어요"). 숫자를 새로 계산하거나 바꾸지 마세요. 다양성 지수 같은 통계 용어는 쓰지 마세요.
- "다양하다/편중됐다/쏠렸다"처럼 시청을 판정하는 말, "이렇게 하라"는 행동 지시, 특정 분야 시청 권유는 하지 마세요.
- 비중이 큰 분야는 그 안에서 어떤 소재를 주로 봤는지 제목을 근거로 짚어 주세요(예: "스포츠 중에서도 야구 하이라이트를 주로 보셨어요"). 단, 제목 속 특정 인물·정당·이슈에 대한 주장이나 논조는 절대 요약·평가하지 마세요.
- 분야는 영상을 올린 사람이 정한 것이라 내용과 다를 수 있습니다. 제목으로 볼 때 실제 소재가 분야와 분명히 다르면 소재를 기준으로 말하되, 비중 숫자는 바꾸지 마세요.
- 오늘 있었던 여러 세션을 개별적으로 나열하지 말고, 오늘 하루 전체를 하나로 요약하세요.

아래 JSON 형식으로만 응답하세요. 다른 텍스트는 포함하지 마세요.

{
  "topic": "시청 카테고리 기반 주요 관심사를 5단어 이내 명사구로 (예: 과학과 기술)",
  "feedback": "위 원칙에 따른 2~3문장. 오늘 무엇을 봤는지 비추되 비중이 가장 큰 분야는 그 퍼센트와 함께 언급 → 비중이 큰 분야 안에서 주로 본 소재 짚기. 판정이나 처방 없이 관찰에서 멈출 것"
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

  try {
    const response = await fetch(GEMINI_API_URL, {
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

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        "[today-review-llm] API error body:",
        oneLine(errorBody, { maxLength: ERROR_BODY_MAX_LENGTH }),
      );
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

    return {
      topic,
      feedback,
      source: "llm",
      promptVersion: TODAY_PROMPT_VERSION,
    };
  } catch (error) {
    // 이미 위에서 분류된 에러(failureReason 있음)는 그대로 전달한다.
    if (error.failureReason) throw error;
    // abort는 타임아웃으로만 발생 → 실제 네트워크 장애(TypeError 등)와 구분
    if (timedOut)
      throw llmError("timeout", `Gemini API 타임아웃 (${TIMEOUT_MS}ms)`, {
        timedOut: true,
      });
    throw llmError("network_error", error.message);
  } finally {
    // 본문 읽기(response.text/json)까지 끝난 뒤에만 타임아웃을 해제한다 — 헤더 수신 직후
    // clearTimeout하면 본문 전송이 멈춘 연결에서 response.json()이 무기한 대기하게 된다.
    clearTimeout(timeoutId);
  }
}

// "오늘" 누적 리뷰의 폴백: 프롬프트와 같은 기준(유효 영상 수, 시청 시간 비중)의 사실만 적는다
function generateTodayFallbackReview({ validVideoCount, timeDistribution }) {
  const basis = shareBasis({ timeDistribution });

  if (basis.entries.length === 0) {
    return {
      topic: "분석 불가",
      feedback:
        "오늘의 시청 데이터를 분석하지 못했습니다. 잠시 후 다시 확인해 주세요!",
      source: "fallback",
      promptVersion: TODAY_PROMPT_VERSION,
    };
  }

  const [topName] = basis.entries[0];
  // 영상 수(시청 시간이 확인된 유효 영상, 분야 미확인 포함)와 분야 비중은 대상이 달라 따로 적는다
  const summary = `오늘은 영상 ${validVideoCount}개를 보셨고, ${sharesSentence(basis)}`;
  const fewNote =
    validVideoCount < MIN_VALID_VIDEOS_PER_DAY
      ? "영상이 적어 오늘 패턴을 정확히 말하기는 어려워요."
      : "";

  return {
    topic: topName,
    feedback: [summary, fewNote].filter(Boolean).join(" "),
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
