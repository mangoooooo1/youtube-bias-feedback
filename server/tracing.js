// dd-trace(Datadog APM) 초기화
// APM의 http.url에는 실제 요청 URL(참여 코드 쿼리스트링, 경로 속 sessionId·eventId)이 그대로 남는다.
// IRB 문서는 외부 전송에 참여자 식별자를 넣지 않기로 했으므로, 라우트 패턴으로 바꿔서 보낸다.

const UNMATCHED_PATH = "/(unmatched)";

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
  return tracer;
}

module.exports = { initTracer, redactHttpUrl, UNMATCHED_PATH };
