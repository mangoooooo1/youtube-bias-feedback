require("dotenv").config();

const express = require("express");
const { success, errorHandler } = require("./middleware/responseHandler");
const { db, initializeDB } = require("./db");
const { buildHealthPayload } = require("./routes/health");

initializeDB();

const app = express();

// CORS를 의도적으로 허용하지 않는다 — 이 API를 브라우저에서 부르는 유일한 클라이언트는
// Chrome 확장(background.js/content.js)인데, manifest.json의 host_permissions로 이미
// CORS 검사 자체를 우회하는 특권을 가지고 있어 서버의 CORS 설정과 무관하게 동작한다.
// 반대로 CORS를 전면 허용(Access-Control-Allow-Origin: *)해두면, 방문자가 열어본 임의의
// 웹사이트 JS가 그 방문자의 브라우저를 통해 이 API(특히 쓰기 엔드포인트)를 호출할 수 있게
// 되므로 아무 이득 없이 공격 표면만 넓어진다.
app.use(express.json());

app.get("/health", (_req, res) => {
  return success(res, buildHealthPayload(db));
});

app.use("/api/participants", require("./routes/participants"));
app.use("/api/sessions", require("./routes/sessions"));
app.use("/api/surveys", require("./routes/surveys"));
app.use("/api/video-events", require("./routes/video-events"));
app.use("/api/popup-events", require("./routes/popup-events"));
app.use("/api/period-reviews", require("./routes/period-reviews"));
app.use("/api/today-reviews", require("./routes/today-reviews"));
app.use("/api/study-end-code", require("./routes/study-end-code"));

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
