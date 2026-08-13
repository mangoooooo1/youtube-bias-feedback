const Database = require("better-sqlite3-multiple-ciphers");
const path = require("path");

const DB_PATH = path.join(__dirname, "youtube_bias.db");

const DB_ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY;
if (!DB_ENCRYPTION_KEY) {
  throw new Error("DB_ENCRYPTION_KEY 환경변수가 필요합니다.");
}

const db = new Database(DB_PATH);
// cipher를 명시하지 않으면 기본값(sqleet, ChaCha20 계열)이 적용된다 — IRB 문서에 서약한
// "AES-256"과 다른 알고리즘이므로 SQLCipher 호환 cipher(AES-256-CBC)를 명시적으로 지정한다.
db.pragma("cipher = 'sqlcipher'");
// SQL 문자열 보간이 아니라 바인딩 API로 전달 — 키에 작은따옴표가 섞여도 안전하다.
// cipher 다음, 다른 pragma·쿼리보다 먼저 적용해야 함.
db.key(Buffer.from(DB_ENCRYPTION_KEY));

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
      failureReason        TEXT,     -- timeout | http_error | empty_response | parse_error | network_error | policy_filtered (성공 시 NULL)
      httpStatus           INTEGER,  -- failureReason='http_error'일 때만 (429 쿼터 vs 5xx 장애 구분)
      timedOut             INTEGER,  -- 타임아웃으로 실패한 경우 1
      -- 실제 생성된 피드백 텍스트 (Story 10-11) — 면담·로그·설문 삼각검증 및 처치 충실도 판정에 필요
      review               TEXT,     -- 사용자에게 노출된 피드백 문장 (llm 성공 또는 fallback 결과)
      reviewTopic          TEXT,     -- 같은 응답의 topic
      source               TEXT,     -- 'llm' | 'fallback' — 어느 경로로 생성됐는지
      promptVersion        TEXT,     -- llm.js PROMPT_VERSION — 파일럿/본조사 처치 동일성 추적용
      -- 피드백 알림·열람·확인 시점 (Story 10-6) — 측정 퍼널: 생성 → 알림(feedbackNotifiedAt)
      -- → 클릭(feedbackViewedAt, 알림 클릭 기준) → 확인(feedbackConfirmedAt, 블러 해제 버튼 클릭 기준 — 가장 엄격한 신호)
      feedbackNotifiedAt   TEXT,     -- 분석 완료 알림을 표시한 시각 (미대상/미전달이면 NULL)
      feedbackViewedAt     TEXT,     -- 알림 클릭 등으로 피드백을 실제로 연 시각 (NULL이면 아직 미열람)
      feedbackConfirmedAt  TEXT,     -- "피드백 확인하기" 버튼으로 블러를 해제한 시각 (NULL이면 아직 미확인)
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
      eventId        TEXT,     -- 오픈당 1회 발급하는 멱등 키 (재전송 중복 방지). UNIQUE는 별도 인덱스로 아래에서 건다
      anonymousId    TEXT    NOT NULL,
      dwellMs        INTEGER,  -- 팝업 체류 시간(ms)
      tabTodayClicks INTEGER DEFAULT 0,  -- '오늘' 탭 클릭 횟수
      tabWeekClicks  INTEGER DEFAULT 0,  -- '주차별' 탭 클릭 횟수
      feedbackViewed INTEGER DEFAULT 0,  -- 피드백을 실제로 열람했으면 1
      openedAt       TEXT,     -- 팝업 오픈 시각 (engagement 최근성 분석용)
      createdAt      TEXT    DEFAULT (datetime('now'))
    );

    -- 기간(일차·주차) 단위 리뷰 — 완료된 기간 전체를 요약하는 서버 배치(cron)
    -- 생성 리뷰. sessions/video_events를 그때그때 집계해 만들며, 세션 리뷰(sessions.review)와는
    -- 독립적으로 저장된다.
    CREATE TABLE IF NOT EXISTS period_reviews (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId          TEXT    NOT NULL,
      periodIndex          INTEGER NOT NULL,  -- 설치일 기준 몇 번째 기간인지 (1부터)
      periodStart          TEXT    NOT NULL,  -- 기간 시작 날짜 (YYYY-MM-DD)
      periodEnd            TEXT    NOT NULL,  -- 기간 종료 날짜 (YYYY-MM-DD)
      isBaseline           INTEGER NOT NULL,  -- 생성 시점 기준 베이스라인 여부 스냅샷 (0|1)
      sessionCount         INTEGER,
      videoCount           INTEGER,
      categoryDistribution TEXT,              -- JSON 문자열 (sessions와 동일 포맷)
      entropy              REAL,
      review               TEXT,              -- 참여자에게 노출된 리뷰 문장
      reviewTopic          TEXT,
      source               TEXT,              -- 'llm' | 'fallback'
      promptVersion        TEXT,              -- 기간 리뷰 전용 버전 (세션 PROMPT_VERSION과 별개)
      llmStatus            TEXT,              -- 'success' | 'fallback'
      failureReason        TEXT,              -- timeout | http_error | empty_response
                                               -- | parse_error | network_error | policy_filtered
      geminiMs             INTEGER,
      generatedAt          TEXT    NOT NULL,  -- cron이 이 행을 생성(확정)한 시각
      createdAt            TEXT    DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_period_reviews_participant_period
      ON period_reviews(anonymousId, periodIndex);

    -- "오늘" 탭 누적 리뷰 — 클라이언트 백그라운드 워커가 오늘 세션 전체를
    -- 병합 집계해 생성한 리뷰. 세션 리뷰(sessions.review)·기간 리뷰(period_reviews)와는
    -- 독립적으로, 진행 중인 오늘 하루치만 (anonymousId, reviewDate) 1행 최신본으로 upsert한다.
    CREATE TABLE IF NOT EXISTS today_reviews (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId          TEXT    NOT NULL,
      reviewDate           TEXT    NOT NULL,  -- 참여자 로컬 기준 날짜 (YYYY-MM-DD)
      sessionCount         INTEGER,
      videoCount           INTEGER,
      categoryDistribution TEXT,              -- JSON 문자열 (sessions와 동일 포맷)
      entropy              REAL,
      review               TEXT,              -- 참여자에게 노출된 누적 리뷰 문장(최신본)
      reviewTopic          TEXT,
      source               TEXT,              -- 'llm' | 'fallback'
      promptVersion        TEXT,              -- 오늘 누적 리뷰 전용 버전 (세션 PROMPT_VERSION과 별개)
      llmStatus            TEXT,              -- 'success' | 'fallback'
      failureReason        TEXT,              -- timeout | http_error | empty_response
                                               -- | parse_error | network_error | policy_filtered
      geminiMs             INTEGER,
      genCount             INTEGER,           -- 그날 몇 번째 재생성으로 만들어진 최신본인지(관측용)
      generatedAt          TEXT    NOT NULL,  -- 이 최신본을 생성한 시각
      createdAt            TEXT    DEFAULT (datetime('now')),
      updatedAt            TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_today_reviews_participant_date
      ON today_reviews(anonymousId, reviewDate);
  `);

  // 이미 만들어진 DB 파일(로컬 개발용·이미 배포된 서버)에는 CREATE TABLE IF NOT EXISTS가
  // no-op이라 새 컬럼이 반영되지 않는다 — Story 10-6에서 처음 이 문제가 실제로 발생해(로컬
  // 서버 기동 시 "no column named feedbackNotifiedAt" 에러 재현 확인) addColumn 패턴을 도입
  addColumn("sessions", "feedbackNotifiedAt", "TEXT");
  addColumn("sessions", "feedbackViewedAt", "TEXT");
  addColumn("sessions", "feedbackConfirmedAt", "TEXT");
  addColumn("sessions", "review", "TEXT");
  addColumn("sessions", "reviewTopic", "TEXT");
  addColumn("sessions", "source", "TEXT");
  addColumn("sessions", "promptVersion", "TEXT");

  // popup_events.eventId도 같은 이유로 addColumn 필요. UNIQUE는 ALTER TABLE ADD COLUMN이
  // 만들 수 없으므로(SQLite 제약) 컬럼 추가 후 별도 유니크 인덱스로 건다 — 신규/기존 DB 모두
  // IF NOT EXISTS라 안전하게 반복 실행된다.
  addColumn("popup_events", "eventId", "TEXT");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_popup_events_eventId ON popup_events(eventId)",
  );
}

// 이미 컬럼이 있으면(신규 DB) 조용히 넘어가고, 없으면(기존 DB) 추가한다.
function addColumn(table, name, type) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}

module.exports = { db, initializeDB };
