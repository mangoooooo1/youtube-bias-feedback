// dd-trace(Datadog APM) 초기화
// APM의 http.url에는 실제 요청 URL(참여 코드 쿼리스트링, 경로 속 sessionId·eventId)이 그대로 남는다.
// 참여 코드는 사람과 연결되는 키이고 경로 식별자는 조사에 필요 없으므로, 라우트 패턴으로 바꿔서 보낸다.
// 익명 식별자(무작위 UUID)는 장애·결측 원인 조사를 위해 usr.id 태그로 보낸다(PRIVACY.md Datadog 항목).

const { normalizeAnonymousId } = require("./routes/anonymous-id");

const UNMATCHED_PATH = "/(unmatched)";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// initTracer가 만든 tracer. 초기화 전(테스트·스크립트)에는 null이라 traceRef가 빈 문자열을 돌려준다.
let currentTracer = null;

/**
 * span 종료 직전에 http.url을 라우트 패턴으로 덮어쓴다.
 * 라우트를 읽을 수 없으면 실제 경로를 남기지 않는다. dd-trace 내부 API가 바뀌어도 식별자가 새지 않게 하기 위함.
 * @param {import("dd-trace").Span} span
 */
function redactHttpUrl(span) {
  if (!span) return;
  const context = span.context();
  if (typeof context.getTag !== "function") {
    span.setTag("http.url", UNMATCHED_PATH);
    return;
  }

  const route = context.getTag("http.route");
  let origin = "";
  try {
    origin = new URL(context.getTag("http.url")).origin;
  } catch {
    // 원본 URL이 없거나 파싱되지 않으면 origin 없이 패턴만 남긴다
  }
  span.setTag("http.url", `${origin}${route || UNMATCHED_PATH}`);
}

/**
 * 본문의 anonymousId를 usr.id 태그로 붙인다. Datadog APM에서 @usr.id로 참여자 요청을 찾는 데 쓴다.
 * 인증 전·실패 요청도 "주장한 ID"로 태그한다(잘못된 트래픽 조사용).
 * APM 태그는 Agent 로그 마스킹을 거치지 않으므로, 참여 코드 등 다른 값이 새지 않게 UUID 형식만 붙인다.
 * @param {import("dd-trace").Span} span
 * @param {import("express").Request} req
 */
function tagUserId(span, req) {
  if (!span) return;
  const anonymousId = normalizeAnonymousId(req?.body?.anonymousId);
  if (UUID_PATTERN.test(anonymousId)) span.setTag("usr.id", anonymousId);
}

/** express request hook. 응답이 끝날 때 호출되므로 req.body와 http.route가 채워져 있다. */
function onRequestFinish(span, req) {
  redactHttpUrl(span);
  tagUserId(span, req);
}

/**
 * express 등을 require-hook으로 패치하므로 다른 모듈보다 먼저 호출해야 한다.
 * @param {string} env - Datadog env 태그
 */
function initTracer(env) {
  const tracer = require("dd-trace").init({
    service: "youtube-bias-server",
    env,
  });
  tracer.use("express", { hooks: { request: onRequestFinish } });
  useTracer(tracer);
  return tracer;
}

/** traceRef가 쓸 tracer를 지정한다. */
function useTracer(tracer) {
  currentTracer = tracer;
}

/**
 * 지금 요청의 trace ID를 로그 줄 끝에 붙일 문자열로 만든다. Datadog Logs에서 해당 trace로 이동하는 데 쓴다.
 * console 로그는 dd-trace의 logInjection 대상이 아니라 직접 붙인다. 형식은 dd-trace 공식 log 주입과 같게
 * 맞추려고 inject(..., "log")를 그대로 쓴다(128비트면 16진수 32자, 아니면 10진수).
 * 로그 한 줄 때문에 요청이 실패하면 안 되므로 어떤 경우에도 던지지 않는다.
 * @returns {string} 활성 span이 없으면 빈 문자열
 */
function traceRef(tracer = currentTracer) {
  try {
    const span = tracer?.scope().active();
    if (!span) return "";
    const carrier = {};
    tracer.inject(span.context(), "log", carrier);
    const { trace_id: traceId, span_id: spanId } = carrier.dd ?? {};
    return traceId && spanId
      ? ` dd.trace_id=${traceId} dd.span_id=${spanId}`
      : "";
  } catch {
    return "";
  }
}

module.exports = {
  initTracer,
  redactHttpUrl,
  tagUserId,
  onRequestFinish,
  useTracer,
  traceRef,
  UNMATCHED_PATH,
};
