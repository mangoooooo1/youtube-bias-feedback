// dd-trace.init()의 env 태그에 반영되도록 .env를 먼저 읽는다
require("dotenv").config();

// dd-trace는 express 등을 require-hook으로 패치하므로 다른 모듈보다 먼저 초기화한다
require("./tracing").initTracer(process.env.NODE_ENV || "development");

const express = require("express");
const { success, errorHandler } = require("./middleware/responseHandler");
const { createCorsPolicy } = require("./middleware/corsPolicy");
const { oneLine, formatStack } = require("./log-line");
const { createAccessLog } = require("./middleware/accessLog");
const { db, initializeDB } = require("./db");
const { buildHealthPayload } = require("./routes/health");

// Express 흐름 밖 예외를 [Error] 포맷으로 남기고 프로세스를 종료해 PM2가 재시작하게 한다
process.on("uncaughtException", (err) => {
  console.error(
    `[Error] uncaught exception: ${oneLine(err?.message ?? err)}${formatStack(err)}`,
  );
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(
    `[Error] unhandled rejection: ${oneLine(message)}${formatStack(reason)}`,
  );
  process.exit(1);
});

initializeDB();

const app = express();

app.use(createCorsPolicy());
// 마운트와 접근 로그 감시 대상을 같은 목록에서 만든다
const API_ROUTES = [
  ["/api/participants", require("./routes/participants")],
  ["/api/sessions", require("./routes/sessions")],
  ["/api/video-events", require("./routes/video-events")],
  ["/api/popup-events", require("./routes/popup-events")],
  ["/api/period-reviews", require("./routes/period-reviews")],
  ["/api/today-reviews", require("./routes/today-reviews")],
  ["/api/viewing-summary", require("./routes/viewing-summary")],
  ["/api/study-end-code", require("./routes/study-end-code")],
  ["/api/client-errors", require("./routes/client-errors")],
];

app.use(createAccessLog(API_ROUTES.map(([mountPath]) => mountPath)));

app.use(express.json());

app.get("/health", (_req, res) => {
  return success(res, buildHealthPayload(db));
});

for (const [mountPath, router] of API_ROUTES) {
  app.use(mountPath, router);
}

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
// nginx가 같은 머신에서만 접속하므로 루프백에만 바인딩한다
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
