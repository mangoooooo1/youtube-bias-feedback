// dd-trace.init()의 env 태그에 반영되도록 .env를 먼저 읽는다
require("dotenv").config();

// dd-trace는 express 등을 require-hook으로 패치하므로 다른 모듈보다 먼저 초기화한다
require("dd-trace").init({
  service: "youtube-bias-server",
  env: process.env.NODE_ENV || "development",
});

const express = require("express");
const cors = require("cors");
const { success, errorHandler } = require("./middleware/responseHandler");
const { db, initializeDB } = require("./db");
const { buildHealthPayload } = require("./routes/health");

// Express 흐름 밖 예외를 [Error] 포맷으로 남기고 프로세스를 종료해 PM2가 재시작하게 한다
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
// 로컬 개발용 압축해제 확장 ID는 production이 아닐 때만 허용 목록에 추가한다
if (process.env.NODE_ENV !== "production" && process.env.DEV_EXTENSION_ID) {
  ALLOWED_ORIGIN_PATTERNS.push(
    `chrome-extension://${process.env.DEV_EXTENSION_ID}`,
  );
}
app.use(
  cors({
    origin(origin, callback) {
      // origin 없는 요청(curl, 헬스체크 등)은 CORS 검사 없이 통과시킨다
      if (!origin) return callback(null, true);
      const allowed = ALLOWED_ORIGIN_PATTERNS.some((p) =>
        p instanceof RegExp ? p.test(origin) : p === origin,
      );
      callback(null, allowed);
    },
    // sendBeacon은 credentials를 끌 수 없어 항상 포함되므로 Allow-Credentials를 켜둔다
    credentials: true,
  }),
);
app.use((req, res, next) => {
  res.on("finish", () => {
    if (res.statusCode >= 400 && res.statusCode < 500) {
      const who = req.body?.anonymousId
        ? ` anonymousId=${req.body.anonymousId}`
        : "";
      console.warn(
        `[access] ${req.method} ${req.path} ${res.statusCode}${who}`,
      );
    }
  });
  next();
});

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
// nginx가 같은 머신에서만 접속하므로 루프백에만 바인딩한다
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
