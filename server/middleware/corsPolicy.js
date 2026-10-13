const cors = require("cors");

// 임의의 확장이 아니라 실제 게시된 ViewLens 확장 ID로만 한정한다.
const VIEWLENS_EXTENSION_ID = "hdoachgdmhdlbgbacaffihocdjagjecp";

function buildAllowedOrigins(env) {
  const allowed = [
    `chrome-extension://${VIEWLENS_EXTENSION_ID}`,
    /^https:\/\/([a-z0-9-]+\.)*youtube\.com$/,
    "https://viewlens.site",
  ];
  // 로컬 개발용 압축해제 확장 ID는 production이 아닐 때만 허용 목록에 추가한다
  if (env.NODE_ENV !== "production" && env.DEV_EXTENSION_ID) {
    allowed.push(`chrome-extension://${env.DEV_EXTENSION_ID}`);
  }
  return allowed;
}

function isAllowedOrigin(origin, allowedOrigins) {
  // origin 없는 요청(curl, 헬스체크 등)은 CORS 검사 없이 통과시킨다
  if (!origin) return true;
  return allowedOrigins.some((p) =>
    p instanceof RegExp ? p.test(origin) : p === origin,
  );
}

/** 허용 목록은 생성 시 한 번만 만든다(서버 시작 시점의 env 기준). */
function createCorsPolicy(env = process.env) {
  const allowedOrigins = buildAllowedOrigins(env);
  return cors({
    origin(origin, callback) {
      callback(null, isAllowedOrigin(origin, allowedOrigins));
    },
    // sendBeacon은 credentials를 끌 수 없어 항상 포함되므로 Allow-Credentials를 켜둔다
    credentials: true,
  });
}

module.exports = { buildAllowedOrigins, isAllowedOrigin, createCorsPolicy };
