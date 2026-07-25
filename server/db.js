const Database = require("better-sqlite3-multiple-ciphers");
const path = require("path");

const DB_PATH = path.join(__dirname, "youtube_bias.db");

const DB_ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY;
if (!DB_ENCRYPTION_KEY) {
  throw new Error("DB_ENCRYPTION_KEY 환경변수가 필요합니다.");
}

const db = new Database(DB_PATH);
db.pragma(`key='${DB_ENCRYPTION_KEY}'`); // 다른 pragma·쿼리보다 먼저 적용해야 함

// 동시성·내구성 하드닝 (80명 확대 실험 대비)
// - WAL: 쓰기 중에도 읽기 허용, 크래시 내구성 향상
// - busy_timeout: 순간적 쓰기 락 경합을 에러 대신 최대 5초 대기로 흡수
// - synchronous=NORMAL: WAL과 함께 무결성 유지 + fsync 부담 완화
// - foreign_keys: 외래키 제약 강제
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

function initializeDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId          TEXT    NOT NULL,
      sessionId            TEXT    NOT NULL UNIQUE,
      startTime            TEXT    NOT NULL,
      endTime              TEXT    NOT NULL,
      videoCount           INTEGER,
      categoryDistribution TEXT,
      entropy              REAL,
      -- 세션 처리 지연시간 () — 확장이 측정해 전송, ms 단위
      totalMs              INTEGER,
      youtubeMs            INTEGER,
      geminiMs             INTEGER,
      -- LLM 성공/폴백 로깅 () — 확장의 폴백 분기(background.js/llm.js)와 대응
      llmStatus            TEXT,     -- 'success' | 'fallback'
      failureReason        TEXT,     -- timeout | http_error | empty_response | parse_error | network_error (성공 시 NULL)
      httpStatus           INTEGER,  -- failureReason='http_error'일 때만 (429 쿼터 vs 5xx 장애 구분)
      timedOut             INTEGER,  -- 타임아웃으로 실패한 경우 1
      createdAt            TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS participants (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId     TEXT    NOT NULL UNIQUE,
      participantCode TEXT,
      group_code      TEXT    NOT NULL,
      installDate     TEXT    NOT NULL,
      createdAt       TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS video_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT    NOT NULL,
      videoId     TEXT    NOT NULL,
      title       TEXT,
      watchedAt   TEXT    NOT NULL,
      createdAt   TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS issued_codes (
      code       TEXT PRIMARY KEY,
      group_code TEXT NOT NULL,
      createdAt  TEXT DEFAULT (datetime('now'))
    );

    -- 팝업 상호작용 마이크로 로그 — 세션과 무관해 별도 테이블
    CREATE TABLE IF NOT EXISTS popup_events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId        TEXT    UNIQUE,  -- 오픈당 1회 발급하는 멱등 키. UNIQUE로 재전송 중복을 막는다(NULL끼리는 distinct라 구버전 요청은 허용)
      anonymousId    TEXT    NOT NULL,
      dwellMs        INTEGER,  -- 팝업 체류 시간(ms)
      tabTodayClicks INTEGER DEFAULT 0,  -- '오늘' 탭 클릭 횟수
      tabWeekClicks  INTEGER DEFAULT 0,  -- '주차별' 탭 클릭 횟수
      feedbackViewed INTEGER DEFAULT 0,  -- 피드백을 실제로 열람했으면 1
      openedAt       TEXT,     -- 팝업 오픈 시각 (engagement 최근성 분석용)
      createdAt      TEXT    DEFAULT (datetime('now'))
    );
  `);

  // 스키마의 단일 진실 원천(single source of truth)은 위 CREATE TABLE 하나다.
  // 런칭 전이라 세상에 마이그레이션할 '옛 스키마 DB'가 없으므로, ALTER 기반
  // 점진 마이그레이션은 두지 않는다(넣어봤자 새 DB에선 전부 no-op인 죽은 코드).
  // 운영 중 스키마를 바꿔야 하는 첫 순간이 오면, 그때 duplicate column name만
  // 무시하고 나머지는 재던지는 addColumn 패턴을 도입한다.
  // (eventId의 UNIQUE도 위 CREATE TABLE에 인라인으로 선언 — 별도 인덱스로 분리하던
  //  이유였던 'ALTER는 UNIQUE 컬럼을 못 만든다' 제약이 ALTER를 걷어내며 사라졌다.)
}

module.exports = { db, initializeDB };
