// 클라이언트가 보내는 시각 정규화
// 저장 전에 모두 이 함수를 거쳐 toISOString() 형식 하나로 맞춘다.
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** 통과하면 toISOString() 형식(UTC) 문자열, 아니면 null. */
function normalizeIsoTimestamp(value) {
  if (typeof value !== "string") return null;
  const match = ISO_WITH_OFFSET.exec(value);
  if (!match) return null;

  const [y, mo, d, h, mi, s] = match.slice(1, 7).map(Number);
  const wall = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    wall.getUTCFullYear() !== y ||
    wall.getUTCMonth() !== mo - 1 ||
    wall.getUTCDate() !== d ||
    wall.getUTCHours() !== h ||
    wall.getUTCMinutes() !== mi ||
    wall.getUTCSeconds() !== s
  ) {
    return null;
  }

  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

module.exports = { normalizeIsoTimestamp };
