// 앱 조립(미들웨어·라우터 연결). 포트를 열지 않아 테스트에서 그대로 불러 쓸 수 있다.
// 라우터가 불러오는 시점에 SQL을 준비하므로 initializeDB() 뒤에 호출해야 한다.

const express = require("express");
const { success, errorHandler } = require("./middleware/responseHandler");
const { createCorsPolicy } = require("./middleware/corsPolicy");
const { createAccessLog } = require("./middleware/accessLog");
const { db } = require("./db");
const { buildHealthPayload } = require("./routes/health");

const SESSIONS_BODY_LIMIT = "256kb";

function createApp() {
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

  // 세션 본문은 영상 수만큼 배열이 길어져 기본 한도(100kb)를 넘을 수 있다. 413은 확장의 세션 큐 전체를 멈추므로 이 경로만 넓힌다.
  // 먼저 파싱된 요청은 아래 전역 파서가 건너뛴다
  app.use("/api/sessions", express.json({ limit: SESSIONS_BODY_LIMIT }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    return success(res, buildHealthPayload(db));
  });

  for (const [mountPath, router] of API_ROUTES) {
    app.use(mountPath, router);
  }

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
