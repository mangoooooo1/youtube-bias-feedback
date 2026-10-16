// 기간 단위 리뷰 생성 파이프라인

const { SENSITIVE_PATTERN } = require("./sensitive-pattern");
const { oneLine } = require("../log-line");
const { minValidVideosForPeriod } = require("./study-constants");
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

// 세션 리뷰의 PROMPT_VERSION과 별도로 관리
const PROMPT_VERSION = "viewlens-period-mirror-v2.0";

const VALID_WATCH_NOTE =
  "(30초 이상 보거나 영상 길이의 4분의 1 이상 본 영상만 셈)";

/** 시청이 적은 구간인지 */
function isFewVideosPeriod(validVideoCount, periodDays) {
  return validVideoCount < minValidVideosForPeriod(periodDays);
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** "2026-03-09" → "3/9(월)" */
function shortDate(date) {
  const [, m, d] = date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return `${m}/${d}(${weekday})`;
}

/** [{category, percent}] → "음악 60%, 게임 40%" (없으면 "기록 없음") */
function inlineShares(shares) {
  return shares.length > 0
    ? shares.map((s) => `${s.category} ${s.percent}%`).join(", ")
    : "기록 없음";
}

function signed(delta) {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

/** 직전 구간이 있어 비교 문장을 받을 수 있는지 */
function hasPreviousPeriod(comparison) {
  return Boolean(comparison?.changeFromPrevious);
}

/** [이전 구간과 비교] 항목 */
function formatComparison(comparison) {
  const { previousPeriods, changeFromPrevious, usualChange } = comparison;
  const last = previousPeriods[previousPeriods.length - 1];
  const fewMark = (p) => (p.isFew ? ", 영상이 적은 구간" : "");
  const lines = [
    `- 직전 구간(${last.periodIndex}구간) 시청 시간 비중: ${inlineShares(last.shares)} (영상 ${last.validVideoCount}개${fewMark(last)})`,
    // 이전 구간이 하나뿐이면 직전 구간 줄과 같아 넣지 않는다
    ...(previousPeriods.length > 1
      ? [
          `- 이전 구간 전체:`,
          ...previousPeriods.map(
            (p) =>
              `  · ${p.periodIndex}구간: ${inlineShares(p.shares)} (영상 ${p.validVideoCount}개${fewMark(p)})`,
          ),
        ]
      : []),
    `- 직전 구간 대비 변화(크기 순): ${
      changeFromPrevious.changes.length > 0
        ? changeFromPrevious.changes
            .map(
              (c) =>
                `${c.category} ${signed(c.delta)}%p (${c.from}% → ${c.to}%)`,
            )
            .join(", ")
        : "모든 분야 비중이 같음"
    }`,
    `- 새로 본 분야: ${changeFromPrevious.newCategories.join(", ") || "없음"} / 보지 않게 된 분야: ${changeFromPrevious.droppedCategories.join(", ") || "없음"}`,
  ];
  if (usualChange) {
    lines.push(
      `- 평소 변화 폭: 이전 구간이 바뀔 때마다 가장 크게 달라진 분야가 평균 ${usualChange.averageLargestDelta}%p였음`,
    );
  }
  const titles = formatTitleGroups(comparison.previousTitleGroups ?? []);
  if (titles)
    lines.push(
      titles.replace("\n- 분야별 영상 제목", "- 직전 구간 분야별 영상 제목"),
    );
  return `\n\n[이전 구간과 비교]\n${lines.join("\n")}`;
}

/** [이번 구간 날짜별 시청 시간 비중] 항목 */
function formatDailyShares(dailyShares = []) {
  if (dailyShares.length === 0) return "";
  const lines = dailyShares.map((d) => {
    if (d.noRecord) return `- ${shortDate(d.date)}: 기록 없음`;
    const few = d.isFew ? ", 영상이 적은 날" : "";
    return `- ${shortDate(d.date)}: ${inlineShares(d.shares)} (영상 ${d.validVideoCount}개${few})`;
  });
  return `\n\n[이번 구간 날짜별 시청 시간 비중]\n${lines.join("\n")}`;
}

function buildPeriodPrompt({
  validVideoCount,
  timeDistribution,
  titleGroups = [],
  periodDays,
  comparison = null,
}) {
  const basis = shareBasis({ timeDistribution });
  const withComparison = hasPreviousPeriod(comparison);
  const currentFew = isFewVideosPeriod(validVideoCount, periodDays);
  const previousFew = withComparison && comparison.previousPeriods.at(-1).isFew;

  const guidance = [];
  if (currentFew) {
    guidance.push(
      "- 이 기간은 시청한 영상이 적어 패턴을 단정하기 어렵습니다. 무엇을 봤는지 가볍게 비추고, 영상이 적어 정확한 피드백은 아니라는 점을 한 문장으로 밝혀 주세요.",
    );
  }
  if (withComparison && (currentFew || previousFew)) {
    guidance.push(
      '- 이번 구간이나 직전 구간의 영상이 적습니다. 직전 구간과 비교하는 첫 문장에 "영상이 적어서 변화 폭이 평소와 다를 수 있다"는 점을 함께 밝혀 주세요.',
    );
  }
  const guidanceSection =
    guidance.length > 0 ? `\n\n[피드백 작성 지침]\n${guidance.join("\n")}` : "";

  const comparisonPrinciples = withComparison
    ? `
- feedback의 첫 문장은 직전 구간과의 비교입니다. 직전 구간과 비교해 가장 크게 달라진 점, 또는 비슷했다는 사실을 한 문장으로 쓰세요. 위 [이전 구간과 비교]의 숫자만 쓰세요.
- 평소 변화 폭이 주어졌을 때만 이번 변화가 그보다 큰지 비슷한지 말할 수 있습니다. 주어지지 않았으면 평소와 비교하지 마세요.
- 이전 구간 전체에서 계속 같은 방향으로 움직이는 분야가 있으면 그 사실을 말해도 됩니다.
- 분야 비중이 비슷해도 직전 구간 제목과 비교해 주로 본 소재가 바뀌었으면 짚어도 됩니다.
- 변화가 좋다거나 나쁘다고 평가하지 마세요.`
    : `
- 이번이 첫 구간이라 비교할 이전 구간이 없습니다. 이전과 비교하지 말고 이 기간 자체만 서술하세요.`;

  const feedbackShape = withComparison
    ? "위 원칙에 따른 3~4문장. 첫 문장은 직전 구간과의 비교 → 이 기간 동안 무엇을 봤는지 비추되 비중이 가장 큰 분야는 그 퍼센트와 함께 언급 → 시청 패턴과 비중이 큰 분야 안에서 주로 본 소재 짚기. 판정이나 처방 없이 관찰에서 멈출 것"
    : "위 원칙에 따른 2~3문장. 이 기간 동안 무엇을 봤는지 비추되 비중이 가장 큰 분야는 그 퍼센트와 함께 언급 → 시청 패턴과 비중이 큰 분야 안에서 주로 본 소재 짚기. 판정이나 처방 없이 관찰에서 멈출 것";

  return `당신은 참여자가 자신의 YouTube 콘텐츠 소비 패턴을 스스로 돌아볼 수 있도록 있는 그대로 비춰 주는 거울 같은 조력자입니다.

[기간 정보]
- 이 기간(${periodDays}일)에 시청한 영상 수: ${validVideoCount}개 ${VALID_WATCH_NOTE}
${formatShares(basis)}${formatTitleGroups(titleGroups)}${formatDailyShares(comparison?.dailyShares)}${withComparison ? formatComparison(comparison) : ""}${guidanceSection}

[피드백 원칙]
- 위에 제시된 분야별 비중, 날짜별 비중, 이전 구간 정보와 영상 제목에만 근거하세요. 정치 성향·이념·성격 등 데이터로 알 수 없는 내용은 추론하거나 단정하지 마세요.
- 평가하거나 가르치려 들지 말고, 친근하고 중립적인 톤으로 참여자가 자신의 시청 패턴을 스스로 알아차리도록 돕는 데 집중하세요.
- 숫자는 위에 적힌 것만 그대로 쓰세요(예: "음악이 시청 시간의 62%였어요"). 숫자를 새로 계산하거나 바꾸지 마세요. 다양성 지수 같은 통계 용어는 쓰지 마세요.
- 이 기간의 시청 패턴을 위의 숫자로 설명할 수 있습니다. 한 분야의 비중이 크면 그 비중을 퍼센트와 함께 말하세요(예: "시청 시간의 85%가 음악이었어요"). 날짜별 비중에서 반복되는 점이 있으면 말하세요(예: "기록이 있는 3일 모두 음악이 가장 길었어요", "주말 이틀은 게임 비중이 더 컸어요"). 위 숫자로 확인되지 않는 패턴은 말하지 마세요.
- "편중됐다/다양하지 못하다/균형 잡혔다"처럼 시청을 좋거나 나쁘게 평가하는 말, "이렇게 하라"는 행동 지시, 특정 분야 시청 권유는 하지 마세요.${comparisonPrinciples}
- 비중이 큰 분야는 그 안에서 어떤 소재를 주로 봤는지 제목을 근거로 짚어 주세요(예: "스포츠 중에서도 야구 하이라이트를 주로 보셨어요"). 단, 제목 속 특정 인물·정당·이슈에 대한 주장이나 논조는 절대 요약·평가하지 마세요.
- 분야는 영상을 올린 사람이 정한 것이라 내용과 다를 수 있습니다. 제목으로 볼 때 실제 소재가 분야와 분명히 다르면 소재를 기준으로 말하되, 비중 숫자는 바꾸지 마세요.
- 이 기간 동안 있었던 여러 세션을 개별적으로 나열하지 말고, 기간 전체를 하나로 요약하세요.

아래 JSON 형식으로만 응답하세요. 다른 텍스트는 포함하지 마세요.

{
  "topic": "시청 카테고리 기반 주요 관심사를 5단어 이내 명사구로 (예: 과학과 기술)",
  "feedback": "${feedbackShape}"
}`;
}

// 실패 사유를 period_reviews.failureReason 분류값으로 태깅한 에러.
function llmError(failureReason, message, extra = {}) {
  const err = new Error(message);
  err.failureReason = failureReason;
  return Object.assign(err, extra);
}

// 숫자는 프롬프트의 입력 부분([피드백 원칙] 앞)에 적힌 것만 허용한다. 원칙의 예시 숫자(62%, 85% 등)는
// 실제 입력이 아니라 허용 목록에서 뺀다. 비중·변화·영상 수·날짜·제목 속 숫자가 모두 입력 부분에 있다.
function numbersIn(text) {
  return (text.match(/\d+/g) ?? []).map(Number);
}

function allowedNumbers(prompt) {
  const end = prompt.indexOf("[피드백 원칙]");
  // 유효 시청 기준 설명(30초, 4분의 1)은 데이터가 아니므로 뺀다
  const input = (end >= 0 ? prompt.slice(0, end) : prompt).replace(
    VALID_WATCH_NOTE,
    "",
  );
  return new Set(numbersIn(input));
}

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
      console.error(
        "[period-review-llm] API error body:",
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

    // 넘겨준 숫자만 쓰게 했으므로, 입력에 없는 숫자가 있으면 실패로 보고 전체를 폴백으로 바꾼다
    const allowed = allowedNumbers(prompt);
    const unknown = numbersIn(feedback).filter((n) => !allowed.has(n));
    if (unknown.length > 0) {
      throw llmError(
        "number_mismatch",
        `입력에 없는 숫자를 사용: ${[...new Set(unknown)].join(", ")}`,
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

// 코드 비교 문장의 "달라졌다/비슷하다" 경계(%p)와 새로 본 분야 기준(2차 테스트 뒤 조정)
const SIMILAR_MAX_DELTA = 10;

/**
 * Gemini를 쓰지 못했을 때(실패·숫자 검증 실패) 대체 문구 맨 앞에 붙이는 비교 문장
 * 가장 큰 변화가 SIMILAR_MAX_DELTA%p 이상이면 그 변화, 아니면 새로 본 분야, 아니면 비슷하다고 말한다.
 * 1구간처럼 직전 구간이 없으면 null(비교 문장을 넣지 않음).
 */
function buildCodeComparison({ comparison, validVideoCount, periodDays }) {
  if (!hasPreviousPeriod(comparison)) return null;
  const { largest, newCategories } = comparison.changeFromPrevious;
  let sentence;
  if (largest && Math.abs(largest.delta) >= SIMILAR_MAX_DELTA) {
    sentence = `직전 구간보다 ${largest.category} 비중이 ${Math.abs(largest.delta)}%p ${largest.delta > 0 ? "늘었어요" : "줄었어요"}.`;
  } else if (newCategories.length > 0) {
    sentence = `직전 구간에는 보지 않았던 ${newCategories.join(", ")} 분야도 봤어요.`;
  } else {
    sentence = "직전 구간과 비슷하게 봤어요.";
  }
  const few =
    isFewVideosPeriod(validVideoCount, periodDays) ||
    comparison.previousPeriods.at(-1).isFew;
  return few
    ? `${sentence} 영상이 적어서, 변화 폭이 평소와 다를 수 있어요.`
    : sentence;
}

// 기간 리뷰의 폴백
// 프롬프트와 같은 기준(유효 영상 수, 시청 시간 비중)의 사실만 적는다
function generatePeriodFallbackReview({
  validVideoCount,
  timeDistribution,
  periodDays,
  comparison = null,
}) {
  const basis = shareBasis({ timeDistribution });

  if (basis.entries.length === 0) {
    // 유효 영상은 있는데 카테고리를 하나도 못 가져온 경우는 "분석하지 못했다"고 알린다.
    return {
      topic: "분석 불가",
      feedback:
        validVideoCount > 0
          ? "이 기간의 시청 기록을 분석하지 못했어요. 잠시 후 다시 확인해 주세요!"
          : "이 기간엔 분석할 시청 기록이 없어요. 다음 기간을 기대해 주세요!",
      source: "fallback",
      promptVersion: PROMPT_VERSION,
    };
  }

  const [topName] = basis.entries[0];
  // 영상 수(시청 시간이 확인된 유효 영상, 분야 미확인 포함)와 분야 비중은 대상이 달라 따로 적는다
  const summary = `이 기간에는 영상 ${validVideoCount}개를 보셨고, ${sharesSentence(basis)}`;
  const fewNote = isFewVideosPeriod(validVideoCount, periodDays)
    ? "영상이 적어 이 기간의 패턴을 정확히 말하기는 어려워요."
    : "";

  return {
    topic: topName,
    // 2구간부터는 Gemini 리뷰처럼 첫 문장을 직전 구간 비교로 둔다
    feedback: [
      buildCodeComparison({ comparison, validVideoCount, periodDays }),
      summary,
      fewNote,
    ]
      .filter(Boolean)
      .join(" "),
    source: "fallback",
    promptVersion: PROMPT_VERSION,
  };
}

module.exports = {
  PROMPT_VERSION,
  buildPeriodPrompt,
  buildCodeComparison,
  generatePeriodReview,
  generatePeriodFallbackReview,
};
