// 로그 한 건을 한 줄로 유지하기 위한 도구.
// error-monitor와 Datadog Agent는 줄 단위로 읽어서, 외부 문자열의 줄바꿈이 그대로 들어가면
// 한 건이 여러 줄로 흩어지고 다음 줄이 "[Error] "로 시작하면 가짜 에러로 집계된다(로그 위조).

/**
 * 줄바꿈을 \n 문자로 바꿔 한 줄로 만든다. 줄바꿈이 없는 문자열은 그대로라 기존 로그 모양과 지문이 바뀌지 않는다.
 * @param {unknown} text
 * @param {{maxLength?: number}} [options] - 외부 응답 본문처럼 길이를 모르는 값은 상한을 둔다
 * @returns {string}
 */
function oneLine(text, { maxLength } = {}) {
  let value = String(text);
  if (maxLength != null && value.length > maxLength) {
    value = `${value.slice(0, maxLength)}…(${value.length}자 중 ${maxLength}자)`;
  }
  return value.replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * 스택을 로그 한 줄 끝에 붙일 문자열로 만든다. JSON 이스케이프로 줄바꿈을 \n 문자로 바꿔
 * Datadog에서 한 예외가 여러 로그로 흩어지지 않게 하고, 스택 속 문자열의 줄 위조도 막는다.
 * @param {unknown} err
 * @returns {string} 스택이 없으면 빈 문자열
 */
function formatStack(err) {
  return err instanceof Error && err.stack
    ? ` stack=${JSON.stringify(err.stack)}`
    : "";
}

module.exports = { oneLine, formatStack };
