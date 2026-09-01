// 점검 스크립트 로그에 참여코드·anonymousId 원본을 남기지 않기 위한 공용 해시 헬퍼.
const crypto = require("crypto");

function fingerprint(value) {
  if (!value) return "(none)";
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 10);
}

module.exports = { fingerprint };
