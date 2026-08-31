require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { success, errorHandler } = require("./middleware/responseHandler");
const { db, initializeDB } = require("./db");
const { buildHealthPayload } = require("./routes/health");

initializeDB();

const app = express();

// 임의의 확장이 아니라 실제 게시된 ViewLens 확장 ID로만 한정한다.
const VIEWLENS_EXTENSION_ID = "hdoachgdmhdlbgbacaffihocdjagjecp";
const ALLOWED_ORIGIN_PATTERNS = [
  `chrome-extension://${VIEWLENS_EXTENSION_ID}`,
  /^https:\/\/([a-z0-9-]+\.)*youtube\.com$/,
  "https://viewlens.site",
];
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
  }),
);
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
// 루프백에만 바인딩
// nginx가 리버스 프록시로서 항상 같은 머신에서 localhost로 붙기에 이걸로 충분하고,
// 외부에서는 방화벽 설정과 무관하게 이 포트로 TCP 연결 자체가 불가능해진다.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
