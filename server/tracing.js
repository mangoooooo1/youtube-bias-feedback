// dd-trace(Datadog APM) 초기화
// APM의 http.url에는 실제 요청 URL(참여 코드 쿼리스트링, 경로 속 sessionId·eventId)이 그대로 남는다.
// IRB 문서는 외부 전송에 참여자 식별자를 넣지 않기로 했으므로, 라우트 패턴으로 바꿔서 보낸다.

const UNMATCHED_PATH = "/(unmatched)";

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
 * express 등을 require-hook으로 패치하므로 다른 모듈보다 먼저 호출해야 한다.
 * @param {string} env - Datadog env 태그
 */
function initTracer(env) {
  const tracer = require("dd-trace").init({
    service: "youtube-bias-server",
    env,
  });
  tracer.use("express", { hooks: { request: redactHttpUrl } });
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
  useTracer,
  traceRef,
  UNMATCHED_PATH,
};
