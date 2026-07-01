const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "youtube_bias.db");

const db = new Database(DB_PATH);

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
  `);

  // 기존 DB 마이그레이션 — participantCode 컬럼이 없으면 추가 (이미 있으면 무시)
  try {
    db.exec("ALTER TABLE participants ADD COLUMN participantCode TEXT");
  } catch (e) {
    // "duplicate column name" → 이미 존재, 무시
  }
}

module.exports = { db, initializeDB };
