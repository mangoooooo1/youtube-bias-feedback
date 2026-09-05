const Database = require("better-sqlite3-multiple-ciphers");
const path = require("path");

// 테스트에서 실제 운영 DB 파일을 열지 않고 라우트 파일 자체(server/routes/*.js)를 그대로
// import해 배선을 검증할 수 있도록, DB_PATH를 환경변수로 오버라이드할 수 있게 한다
// (예: DB_PATH=":memory:"). 운영에서는 process.env.DB_PATH가 없으므로 기존 경로 그대로다.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "youtube_bias.db");

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
      -- "오늘" 탭 리뷰 카드 통합 이후로는 이 세션 하나만의 격리된 관찰치가 아니라,
      -- 그 세션 종료 시점까지의 "오늘 누적" 스냅샷이다(세션 경계마다 찍힌 시계열) — 생성 당시
      -- today_reviews에 기록된 그 날짜 최신 스냅샷과 같은 계산 결과를 공유한다(한 번의 생성으로
      -- 두 테이블에 나눠 저장). 이후 같은 날 세션이 추가로 끝나면 today_reviews는 그 다음
      -- 스냅샷으로 갱신되므로, 과거 sessions.review는 today_reviews의 "현재" 최신본과 값이
      -- 갈라진다 — 두 테이블을 조인해 비교할 때는 이 시점 차이를 반드시 감안할 것.
      review               TEXT,     -- 사용자에게 노출된 피드백 문장 (llm 성공 또는 fallback 결과)
      reviewTopic          TEXT,     -- 같은 응답의 topic
      source               TEXT,     -- 'llm' | 'fallback' — 어느 경로로 생성됐는지
      promptVersion        TEXT,     -- extension/pipeline/llm.js TODAY_PROMPT_VERSION — 파일럿/본조사 처치 동일성 추적용
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
      -- 대조군 연구 종료 후 리뷰 열람 이벤트 (Story 10-10) — 최초 1회만 기록(recordStudyEndReviewEvent)
      studyEndModalShownAt   TEXT,  -- 종료 안내 모달을 처음 노출한 시각
      studyEndReviewViewedAt TEXT,  -- 6주 누적 리뷰 화면에 처음 진입한 시각
      -- 설문 연동 코드 검증 통과 시각 (최초 1회만, verifyAndRecordStudyEndCode) —
      -- getPeriodReviews가 대조군 데이터 반환 여부를 판단할 때 이 값도 함께 확인한다.
      studyEndCodeVerifiedAt TEXT,
      createdAt       TEXT    DEFAULT (datetime('now'))
    );

    -- entryHost/entryPath/referrerType/relatedTrigger는 addColumn 없이 여기(CREATE TABLE)에만 반영돼 있다.
    -- 먼저 백업한 뒤 삭제하고(server/scripts/backup-db.js), 재기동으로 새 스키마가 생성되게 할 것.
    CREATE TABLE IF NOT EXISTS video_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId     TEXT,     -- 영상 기록 1건당 1회 발급하는 멱등 키 (재전송 중복 방지). UNIQUE는 별도 인덱스로 아래에서 건다
      anonymousId TEXT    NOT NULL,
      videoId     TEXT    NOT NULL,
      title       TEXT,
      watchedAt   TEXT    NOT NULL,
      -- 이 영상이 속한 세션의 sessions.sessionId
      sessionId   TEXT,
      -- 유입 경로 판별용 원시 신호(확장이 캡처한 직전 페이지 도메인·경로, 쿼리스트링 제외).
      -- 분류 규칙(video-events-classify.js)이 나중에 바뀌어도 재분류할 수 있도록 원본을 남겨둔다.
      entryHost      TEXT,
      entryPath      TEXT,
      -- entryHost/entryPath/navigationTrigger로부터 서버가 분류한 결과
      referrerType   TEXT,  -- 'direct_search' | 'home_feed' | 'related' | 'external' | 'unknown'
      -- referrerType='related'일 때만 의미 있음(그 외엔 NULL) — 자동재생(ended)/사용자 조작(click·keydown) 구분,
      -- 판단 근거가 부족하면 'unknown'
      relatedTrigger TEXT,  -- 'autoplay' | 'click' | 'unknown' | NULL
      createdAt   TEXT    DEFAULT (datetime('now'))
    );

    -- YouTube 영상·채널 메타데이터 캐시
    --
    -- video_events.videoId -> video_metadata.videoId 는 DB 레벨 FK가 없다. video_events는
    -- 최초 CREATE TABLE(위)에서 이미 FK 없이 만들어진 기존 컬럼이라, addColumn() 패턴으로는
    -- 여기에 FK를 소급 적용할 수 없다(SQLite는 테이블 재생성 없이 기존 컬럼에 제약을 추가하는
    -- 방법을 제공하지 않는다). video_events.sessionId에 FK를 걸지 않기로 한 선례와 같은 이유로,
    -- 이 참조는 애플리케이션 코드에서 삽입 순서(video_metadata 확인·삽입 -> video_events 삽입)만
    -- 보장하는 느슨한 참조로 둔다.
    --
    -- 반면 channel_metadata/video_metadata는 이번에 함께 신설되는 테이블이라 소급 적용 제약이
    -- 없으므로, video_metadata.channelId -> channel_metadata.channelId는 실제 FK로 강제한다.
    -- FK 참조 대상은 참조하는 쪽보다 먼저 생성돼야 하므로 channel_metadata를 먼저 정의한다.
    CREATE TABLE IF NOT EXISTS channel_metadata (
      channelId       TEXT PRIMARY KEY,
      channelTitle    TEXT,
      subscriberCount INTEGER,
      videoCount      INTEGER,
      -- 정렬 정규화 적용한 JSON 배열 문자열
      topicCategories TEXT,
      -- 원문 보관 전용 — tags와 동일 계열 위험(결측·SEO 나열)으로 실시간 기능(LLM 프롬프트 등)에는 미반영
      keywords        TEXT,
      createdAt       TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS video_metadata (
      videoId         TEXT PRIMARY KEY,
      categoryId      TEXT,
      title           TEXT,
      -- 영상 총 길이(초). 쇼츠(<=60초) 여부 이진 판별 용도로만 사용
      durationSeconds INTEGER,
      -- 최초 수집 시점 스냅샷(시계열 갱신 없음) — "시청 당시 노출된 맥락"이 분석 대상이므로 고정.
      viewCount       INTEGER,
      channelId       TEXT,
      -- 원문 보관 전용 — 장르별 가치 편차가 커 실시간 기능(LLM 프롬프트 등)에는 미반영
      description     TEXT,
      createdAt       TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (channelId) REFERENCES channel_metadata(channelId)
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
    -- 별도 파이프라인(서버 cron vs 클라이언트 세션-종료 트리거)에서 독립적으로 생성·저장된다.
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

    -- "오늘" 탭 누적 리뷰 — 클라이언트 백그라운드 워커가 오늘 세션 전체를 병합 집계해 생성한 리뷰
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
  addColumn("participants", "studyEndModalShownAt", "TEXT");
  addColumn("participants", "studyEndReviewViewedAt", "TEXT");
  addColumn("participants", "studyEndCodeVerifiedAt", "TEXT");
  addColumn("video_events", "sessionId", "TEXT");

  // popup_events.eventId도 같은 이유로 addColumn 필요. UNIQUE는 ALTER TABLE ADD COLUMN이
  // 만들 수 없으므로(SQLite 제약) 컬럼 추가 후 별도 유니크 인덱스로 건다 — 신규/기존 DB 모두
  // IF NOT EXISTS라 안전하게 반복 실행된다.
  addColumn("popup_events", "eventId", "TEXT");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_popup_events_eventId ON popup_events(eventId)",
  );

  // video_events.eventId
  // 확장 프로그램의 재시도 큐 같은 영상 기록을 다시 보낼 수 있어 popup_events와 동일한 멱등 키 패턴을 적용한다.
  addColumn("video_events", "eventId", "TEXT");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_video_events_eventId ON video_events(eventId)",
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

module.exports = { db, initializeDB, addColumn };
