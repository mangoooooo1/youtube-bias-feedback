// 리뷰 생성 때마다 Gemini 호출 결과를 Datadog 커스텀 메트릭으로 보낸다.
// today_reviews는 날짜당 최신본만 남아 중간 fallback이 사라지므로, DB 집계가 아니라 생성 시점에 센다.
const { createDogStatsd } = require("./dogstatsd");
const {
  LLM_STATUSES,
  FAILURE_REASONS,
} = require("../routes/sessions-validate");

// 운영 서버에 Gemini 키가 빠진 설정 사고를 fallback 사유로 드러낸다
const NO_API_KEY = "no_api_key";

const ALLOWED_TAGS = {
  kind: new Set(["today", "period"]),
  status: new Set(LLM_STATUSES),
  failure_reason: new Set([...FAILURE_REASONS, NO_API_KEY]),
  env: new Set(["production"]),
};

let defaultClient = null;
function getDefaultClient() {
  if (!defaultClient)
    defaultClient = createDogStatsd({ allowedTags: ALLOWED_TAGS });
  return defaultClient;
}

/**
 * Gemini 호출 1건의 결과를 보낸다. 참여자 정보는 받지 않는다.
 * @param {object} call
 * @param {"today"|"period"} call.kind
 * @param {"success"|"fallback"} call.llmStatus
 * @param {string|null} call.failureReason
 * @param {number|null} call.geminiMs
 * @param {boolean} call.calledGemini - 키가 없어 호출하지 않았으면 false
 * @param {{send: Function}} [client]
 */
function recordLlmCall(
  { kind, llmStatus, failureReason, geminiMs, calledGemini },
  client = getDefaultClient(),
) {
  const env = process.env.NODE_ENV;
  client.send("viewlens.llm.calls", 1, "c", {
    kind,
    status: llmStatus,
    failure_reason: calledGemini ? failureReason : NO_API_KEY,
    env,
  });
  if (calledGemini && typeof geminiMs === "number") {
    client.send("viewlens.llm.gemini_ms", geminiMs, "d", { kind, env });
  }
}

/** cron 스크립트가 끝나기 전에 남은 패킷을 보낸다. */
function closeLlmMetrics() {
  return defaultClient ? defaultClient.close() : Promise.resolve();
}

module.exports = { recordLlmCall, closeLlmMetrics, ALLOWED_TAGS, NO_API_KEY };
