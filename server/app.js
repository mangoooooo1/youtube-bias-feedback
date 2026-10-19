// dd-trace.init()의 env 태그에 반영되도록 .env를 먼저 읽는다
require("dotenv").config();

// dd-trace는 express 등을 require-hook으로 패치하므로 다른 모듈보다 먼저 초기화한다
require("./tracing").initTracer(process.env.NODE_ENV || "development");

const { oneLine, formatStack } = require("./log-line");
const { initializeDB } = require("./db");

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

// 라우터가 테이블을 쓰므로 initializeDB() 뒤에 조립한다
const { createApp } = require("./create-app");
const app = createApp();

const PORT = process.env.PORT || 3000;
// nginx가 같은 머신에서만 접속하므로 루프백에만 바인딩한다
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
