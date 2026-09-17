// dd-trace는 express 등 다른 모듈을 require-hook으로 패치해 계측하므로, 그 모듈들보다
// 먼저 초기화돼야 한다. 이 파일의 첫 줄이어야 하는 이유. 로컬 Agent로만 보내고 API Key는 필요 없다.
// 기본값은 request body·query string·DB 쿼리를 캡처하지 않는다.
require("dd-trace").init({ service: "youtube-bias-server", env: "production" });

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { success, errorHandler } = require("./middleware/responseHandler");
const { db, initializeDB } = require("./db");
const { buildHealthPayload } = require("./routes/health");

// 전역 예외 핸들러
// errorHandler는 Express 요청 흐름 안의 예외만 잡기 때문에 이 둘을 등록해야
// 요청 흐름 밖에서 처리되지 않은 예외/거부는 [Error] 접두사가 없어서 필터링되지 않는다.
// [Error] 포맷으로 통일해 남기고, 상태가 오염됐을 수 있는 프로세스를 계속 쓰지 않도록 PM2가 재시작하게 종료한다.
process.on("uncaughtException", (err) => {
  console.error(`[Error] uncaught exception: ${err.stack || err.message}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const message =
    reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error(`[Error] unhandled rejection: ${message}`);
  process.exit(1);
});

initializeDB();

const app = express();

// 임의의 확장이 아니라 실제 게시된 ViewLens 확장 ID로만 한정한다.
const VIEWLENS_EXTENSION_ID = "hdoachgdmhdlbgbacaffihocdjagjecp";
const ALLOWED_ORIGIN_PATTERNS = [
  `chrome-extension://${VIEWLENS_EXTENSION_ID}`,
  /^https:\/\/([a-z0-9-]+\.)*youtube\.com$/,
  "https://viewlens.site",
];
// 로컬 개발 편의. "압축해제된 확장 프로그램"으로 로드하면 배포 ID와 다른 ID가 발급되므로,
// production이 아닐 때만 .env의 DEV_EXTENSION_ID를 추가로 허용한다. 운영 환경 보안엔 영향 없음.
if (process.env.NODE_ENV !== "production" && process.env.DEV_EXTENSION_ID) {
  ALLOWED_ORIGIN_PATTERNS.push(
    `chrome-extension://${process.env.DEV_EXTENSION_ID}`,
  );
}
app.use(
  cors({
    origin(origin, callback) {
      // origin이 없는 요청(브라우저가 아닌 curl/서버-서버 호출, 헬스체크 등)은 애초에
      // CORS 적용 대상이 아니므로 통과시킨다.
      if (!origin) return callback(null, true);
      const allowed = ALLOWED_ORIGIN_PATTERNS.some((p) =>
        p instanceof RegExp ? p.test(origin) : p === origin,
      );
      callback(null, allowed);
    },
    // navigator.sendBeacon(popup-events 백업 전송, viewlens-popup.js)은 credentials
    // mode를 끌 방법이 없어 cross-origin이어도 항상 포함해서 보낸다. 이 서버는 쿠키를
    // 쓰지 않지만, Access-Control-Allow-Credentials가 없으면 브라우저가 그 preflight
    // 자체를 막아버려 beacon이 항상 실패한다.
    credentials: true,
  }),
);
app.use(express.json());

app.get("/health", (_req, res) => {
  return success(res, buildHealthPayload(db));
});

app.use("/api/participants", require("./routes/participants"));
app.use("/api/sessions", require("./routes/sessions"));
app.use("/api/video-events", require("./routes/video-events"));
app.use("/api/popup-events", require("./routes/popup-events"));
app.use("/api/period-reviews", require("./routes/period-reviews"));
app.use("/api/today-reviews", require("./routes/today-reviews"));
app.use("/api/study-end-code", require("./routes/study-end-code"));

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
// 루프백에만 바인딩
// nginx가 리버스 프록시로서 항상 같은 머신에서 localhost로 붙기에 이걸로 충분하고,
// 외부에서는 방화벽 설정과 무관하게 이 포트로 TCP 연결 자체가 불가능해진다.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
