/**
 * 골드스탠다드 평정용 제목 목록 추출 (읽기 전용)
 *
 * sample-embedding-validation-sessions.js가 뽑은 28개 세션의 실제 영상 제목을 꺼내,
 * 평정자(본인/외부 검증자/LLM)에게 줄 "제목 목록만" 시트와, 나중에 채점 결과를 원래
 * 세션(entropy·카테고리 수·그리드 셀)과 다시 연결할 비공개 키 파일을 분리해서 만든다.
 *
 * - 평정 시트(.txt)에는 세션 ID·참여자·그리드 셀 등 어떤 라벨도 넣지 않는다(편향 방지).
 * - 세션 순서를 섞어서 익명 번호(S01, S02...)를 매긴다. 원래 순서가 그리드 셀 크기순이라
 *   그대로 두면 평정자가 순서에서 난이도·다양성 패턴을 눈치챌 수 있다.
 * - 키 파일(.json)은 평정자에게 절대 보여주지 않는다. 채점 결과 취합 때만 사용한다.
 *
 * 사용:
 *   SOURCE_DB_PATH="..." DB_ENCRYPTION_KEY="..." node server/scripts/export-gold-standard-titles.js
 *   (골드스탠다드 표본 파일은 output/ 안의 최신 gold-standard-sample-*.json을 자동으로 찾는다.
 *    다른 파일을 쓰려면 GOLD_STANDARD_SAMPLE_PATH로 지정)
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const SOURCE_DB_PATH = process.env.SOURCE_DB_PATH || process.argv[2];
const DB_ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY;
const OUTPUT_DIR = path.join(__dirname, "output");

function fail(message) {
  console.error(`[export] ${message}`);
  process.exit(1);
}

if (!SOURCE_DB_PATH) {
  fail(
    "SOURCE_DB_PATH 환경변수 또는 첫 번째 인자로 백업 DB 경로를 지정하세요.",
  );
}
if (!fs.existsSync(SOURCE_DB_PATH)) {
  fail(`파일 없음: ${SOURCE_DB_PATH}`);
}
if (!DB_ENCRYPTION_KEY) {
  fail("DB_ENCRYPTION_KEY 환경변수가 필요합니다.");
}

function resolveSamplePath() {
  if (process.env.GOLD_STANDARD_SAMPLE_PATH) {
    return process.env.GOLD_STANDARD_SAMPLE_PATH;
  }
  if (!fs.existsSync(OUTPUT_DIR)) {
    fail(
      `${OUTPUT_DIR} 없음 — 먼저 sample-embedding-validation-sessions.js를 실행하세요.`,
    );
  }
  const candidates = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => /^gold-standard-sample-\d+\.json$/.test(f))
    .sort(); // 파일명의 타임스탬프가 고정 자릿수라 사전순 정렬 = 시간순 정렬
  if (candidates.length === 0) {
    fail(
      "gold-standard-sample-*.json이 없습니다 — 먼저 sample-embedding-validation-sessions.js를 실행하세요.",
    );
  }
  return path.join(OUTPUT_DIR, candidates[candidates.length - 1]);
}

// Fisher-Yates: 평정 시트에서 원래 그리드 셀 순서(크기순)가 드러나지 않도록 섞는다.
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function main() {
  const samplePath = resolveSamplePath();
  console.log(`[export] 표본 파일: ${samplePath}`);
  const sample = JSON.parse(fs.readFileSync(samplePath, "utf8"));
  if (!Array.isArray(sample.sessions) || sample.sessions.length === 0) {
    fail("표본 파일에 sessions가 없습니다.");
  }

  let db;
  try {
    db = new Database(SOURCE_DB_PATH, { readonly: true, fileMustExist: true });
    db.pragma("cipher = 'sqlcipher'");
    db.key(Buffer.from(DB_ENCRYPTION_KEY));
    db.prepare("SELECT COUNT(*) FROM sqlite_master").get();
  } catch (err) {
    fail(
      `DB 열기 실패 (${err.message}). DB_ENCRYPTION_KEY가 이 백업 파일 생성 당시 값과 일치하는지 확인하세요.`,
    );
  }

  // video_events.sessionId는 영상 기록 시점에 별도 경로로 붙는 값이라(sessions의
  // categoryDistribution/entropy는 이와 무관하게 클라이언트가 보낸 videoIds로 계산됨),
  // 과거 다중 탭 경합 조건 버그(2019d19) 계열 문제로 어긋나는 경우가 있다. sessionId로
  // 먼저 찾고, 못 찾으면 "같은 참여자 + 그 세션의 시작~종료 시각 사이"로 재시도한다.
  const titleBySessionIdStmt = db.prepare(
    `SELECT title FROM video_events
     WHERE sessionId = ? AND title IS NOT NULL
     ORDER BY watchedAt ASC`,
  );
  const sessionMetaStmt = db.prepare(
    "SELECT startTime, endTime FROM sessions WHERE sessionId = ?",
  );
  const titleByTimeRangeStmt = db.prepare(
    `SELECT title FROM video_events
     WHERE anonymousId = ? AND title IS NOT NULL
       AND watchedAt >= ? AND watchedAt <= ?
     ORDER BY watchedAt ASC`,
  );

  function resolveTitles(s) {
    const bySessionId = titleBySessionIdStmt
      .all(s.sessionId)
      .map((r) => r.title);
    if (bySessionId.length > 0)
      return { titles: bySessionId, method: "sessionId" };

    const meta = sessionMetaStmt.get(s.sessionId);
    if (!meta) return { titles: [], method: "no_session_row" };

    const byTimeRange = titleByTimeRangeStmt
      .all(s.anonymousId, meta.startTime, meta.endTime)
      .map((r) => r.title);
    return {
      titles: byTimeRange,
      method: byTimeRange.length > 0 ? "timeRange" : "none",
    };
  }

  const methodCounts = {};
  const withTitles = sample.sessions.map((s) => {
    const { titles, method } = resolveTitles(s);
    methodCounts[method] = (methodCounts[method] ?? 0) + 1;
    return { ...s, titles, matchMethod: method };
  });

  db.close();

  console.log("[export] 제목 매칭 방식별 세션 수:", methodCounts);

  const missing = withTitles.filter((s) => s.titles.length === 0);
  if (missing.length > 0) {
    console.warn(
      `[export] 경고: 제목을 하나도 못 찾은 세션 ${missing.length}개 — sessionId·시간범위 매칭 모두 실패.`,
    );
  }

  const shuffled = shuffle(withTitles);
  const pad = (n) => String(n).padStart(2, "0");

  const timestamp = Date.now();

  // 1) 평정 시트: 라벨 없이 제목 목록만. 이 파일만 평정자(본인/외부 검증자/LLM)에게 준다.
  const sheetLines = [];
  const ratingSheetJson = [];
  shuffled.forEach((s, idx) => {
    const ratingId = `S${pad(idx + 1)}`;
    sheetLines.push(`### ${ratingId}`);
    s.titles.forEach((t, i) => sheetLines.push(`${i + 1}. ${t}`));
    sheetLines.push("");
    ratingSheetJson.push({ ratingId, titles: s.titles });
  });

  const sheetTxtPath = path.join(OUTPUT_DIR, `rating-sheet-${timestamp}.txt`);
  const sheetJsonPath = path.join(OUTPUT_DIR, `rating-sheet-${timestamp}.json`);
  fs.writeFileSync(sheetTxtPath, sheetLines.join("\n"));
  fs.writeFileSync(sheetJsonPath, JSON.stringify(ratingSheetJson, null, 2));

  // 1b) 채점용 빈칸 템플릿. 평정자마다 이 파일을 복사해서 따로 채우게 한다.
  // 한 파일에 여러 명이 이어 적으면 뒷사람이 앞사람 점수를 보게 되어 "독립 평정"이
  // 깨지므로, 반드시 평정자 1명당 1개의 복사본을 나눠주고 따로 걷는다.
  const templateLines = [
    "평정자 이름: ______________________",
    "",
    "아래 각 세션(S01~S28)의 영상 제목 목록을 보고, 이 세션이 얼마나 다양한 주제의",
    "영상으로 이루어져 있는지 1~5점으로 평가해 빈칸에 적어주세요.",
    "  1점 = 사실상 한 가지 주제/채널만 반복",
    "  3점 = 두세 가지 뚜렷한 주제가 섞여 있음",
    "  5점 = 서로 확연히 다른 주제가 여러 개 섞여 있음",
    "",
    "──────────────────────────────",
    "",
  ];
  shuffled.forEach((s, idx) => {
    const ratingId = `S${pad(idx + 1)}`;
    templateLines.push(`### ${ratingId}`);
    s.titles.forEach((t, i) => templateLines.push(`${i + 1}. ${t}`));
    templateLines.push("점수(1~5): ____");
    templateLines.push("");
  });
  const templatePath = path.join(
    OUTPUT_DIR,
    `rating-template-${timestamp}.txt`,
  );
  fs.writeFileSync(templatePath, templateLines.join("\n"));

  // 2) 키 파일: 평정자에게 절대 보여주지 않는다. 채점 결과를 다시 붙일 때만 쓴다.
  const keyJson = shuffled.map((s, idx) => ({
    ratingId: `S${pad(idx + 1)}`,
    sessionId: s.sessionId,
    anonymousId: s.anonymousId,
    groupCode: s.groupCode,
    isTestAccount: s.isTestAccount,
    videoCount: s.videoCount,
    titleCount: s.titles.length,
    matchMethod: s.matchMethod,
    entropy: s.entropy,
    categoryCount: s.categoryCount,
    gridKey: s.gridKey,
  }));
  const keyPath = path.join(OUTPUT_DIR, `rating-key-${timestamp}.json`);
  fs.writeFileSync(keyPath, JSON.stringify(keyJson, null, 2));

  console.log(`[export] 평정 시트(텍스트, 라벨 없음): ${sheetTxtPath}`);
  console.log(`[export] 평정 시트(JSON, 라벨 없음): ${sheetJsonPath}`);
  console.log(
    `[export] 채점용 빈칸 템플릿(평정자 1명당 1부씩 복사해서 배포): ${templatePath}`,
  );
  console.log(
    `[export] 키 파일(비공개, 라벨 포함 — 평정자에게 주지 말 것): ${keyPath}`,
  );
  console.log(
    `[export] 총 ${shuffled.length}개 세션, 제목 없는 세션 ${missing.length}개`,
  );
}

main();
