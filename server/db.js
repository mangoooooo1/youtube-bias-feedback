const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "youtube_bias.db");

const db = new Database(DB_PATH);

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
      anonymousId    TEXT    NOT NULL,
      dwellMs        INTEGER,  -- 팝업 체류 시간(ms)
      tabTodayClicks INTEGER DEFAULT 0,  -- '오늘' 탭 클릭 횟수
      tabWeekClicks  INTEGER DEFAULT 0,  -- '주차별' 탭 클릭 횟수
      feedbackViewed INTEGER DEFAULT 0,  -- 피드백을 실제로 열람했으면 1
      openedAt       TEXT,     -- 팝업 오픈 시각 (engagement 최근성 분석용)
      createdAt      TEXT    DEFAULT (datetime('now'))
    );
  `);

  // 기존 DB 마이그레이션 — 컬럼이 없으면 추가 (이미 있으면 무시).
  // 실운영 중인 DB를 깨지 않고 컬럼을 점진 추가하기 위한 패턴.
  const addColumn = (sql) => {
    try {
      db.exec(sql);
    } catch (e) {
      // "duplicate column name" → 이미 존재하는 컬럼이므로 무시.
      // 그 외(SQL 오류·DB 잠금·테이블 부재 등)는 마이그레이션 실패이므로 재던져
      // 조용한 실패 후 런타임 컬럼 누락 크래시를 막는다.
      if (e.message && e.message.includes("duplicate column name")) return;
      throw e;
    }
  };

  addColumn("ALTER TABLE participants ADD COLUMN participantCode TEXT");
  //  latency /  폴백 로깅 컬럼
  addColumn("ALTER TABLE sessions ADD COLUMN totalMs INTEGER");
  addColumn("ALTER TABLE sessions ADD COLUMN youtubeMs INTEGER");
  addColumn("ALTER TABLE sessions ADD COLUMN geminiMs INTEGER");
  addColumn("ALTER TABLE sessions ADD COLUMN llmStatus TEXT");
  addColumn("ALTER TABLE sessions ADD COLUMN failureReason TEXT");
  addColumn("ALTER TABLE sessions ADD COLUMN httpStatus INTEGER");
  addColumn("ALTER TABLE sessions ADD COLUMN timedOut INTEGER");
}

module.exports = { db, initializeDB };
