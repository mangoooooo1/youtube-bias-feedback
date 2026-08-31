require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { success, errorHandler } = require("./middleware/responseHandler");
const { db, initializeDB } = require("./db");
const { buildHealthPayload } = require("./routes/health");

initializeDB();

const app = express();

const ALLOWED_ORIGIN_PATTERNS = [
  /^chrome-extension:\/\//,
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
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
