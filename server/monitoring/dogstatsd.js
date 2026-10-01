// 로컬 Datadog Agent의 DogStatsD(UDP 8125)로 커스텀 메트릭을 보낸다.
// 태그는 호출 쪽이 넘긴 허용 목록(키·값 모두 고정)만 통과시켜, 참여자 단위 값이 외부로 나가지 않게 한다.
// UDP라 전달을 확인하지 않으며, 어떤 실패도 throw하지 않는다(메트릭 때문에 요청 처리가 깨지면 안 된다).
const dgram = require("dgram");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8125;
const METRIC_NAME_PATTERN = /^viewlens\.[a-z0-9_.]+$/;
const METRIC_TYPES = new Set(["c", "d", "g"]);

/**
 * 허용 목록에 있는 태그만 `key:value`로 만든다. 목록 밖 키·값은 버린다.
 * @param {Record<string, string|null|undefined>} tags
 * @param {Record<string, Set<string>>} allowedTags - 키별 허용 값
 * @returns {string[]}
 */
function filterTags(tags, allowedTags) {
  const out = [];
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (value == null) continue;
    if (allowedTags[key]?.has(String(value))) {
      out.push(`${key}:${value}`);
    } else {
      console.warn(`[dogstatsd] 허용 목록 밖 태그 버림: ${key}`);
    }
  }
  return out;
}

/**
 * DogStatsD 한 줄을 만든다. 이름·타입·값이 잘못되면 null.
 * @param {string} name - viewlens.로 시작하는 메트릭 이름
 * @param {number} value
 * @param {"c"|"d"|"g"} type - count, distribution, gauge
 * @param {Record<string, string|null|undefined>} tags
 * @param {Record<string, Set<string>>} allowedTags
 * @returns {string|null}
 */
function formatMetric(name, value, type, tags, allowedTags) {
  if (!METRIC_NAME_PATTERN.test(name) || !METRIC_TYPES.has(type)) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const tagList = filterTags(tags, allowedTags);
  const suffix = tagList.length > 0 ? `|#${tagList.join(",")}` : "";
  return `${name}:${value}|${type}${suffix}`;
}

/**
 * @param {object} [options]
 * @param {boolean} [options.enabled] - 기본은 NODE_ENV=production일 때만
 * @param {Record<string, Set<string>>} options.allowedTags
 * @param {() => import("dgram").Socket} [options.createSocket] - 테스트용
 */
function createDogStatsd({
  enabled = process.env.NODE_ENV === "production",
  allowedTags,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  createSocket = () => dgram.createSocket("udp4"),
} = {}) {
  let socket = null;
  let pending = 0;
  let onDrained = null;

  function getSocket() {
    if (!socket) {
      socket = createSocket();
      socket.on("error", (err) =>
        console.warn(`[dogstatsd] 소켓 오류: ${err.message}`),
      );
      // 열린 소켓 때문에 cron 스크립트가 끝나지 않는 일이 없게 한다
      socket.unref?.();
    }
    return socket;
  }

  function send(name, value, type, tags = {}) {
    if (!enabled) return;
    try {
      const line = formatMetric(name, value, type, tags, allowedTags);
      if (!line) {
        console.warn(`[dogstatsd] 잘못된 메트릭 버림: ${name}`);
        return;
      }
      getSocket().send(line, port, host, () => {
        pending -= 1;
        if (pending === 0 && onDrained) onDrained();
      });
      pending += 1;
    } catch (err) {
      console.warn(`[dogstatsd] 전송 실패: ${err.message}`);
    }
  }

  /** 보내는 중인 패킷을 마저 보낸 뒤 소켓을 닫는다. cron 스크립트 종료 직전에 부른다. */
  function close() {
    return new Promise((resolve) => {
      const finish = () => {
        try {
          socket?.close();
        } catch {
          // 이미 닫혔으면 무시
        }
        socket = null;
        resolve();
      };
      if (pending === 0) return finish();
      onDrained = finish;
    });
  }

  return { send, close };
}

module.exports = { createDogStatsd, formatMetric, filterTags };
