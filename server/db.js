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
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT    NOT NULL UNIQUE,
      group_code  TEXT    NOT NULL,
      installDate TEXT    NOT NULL,
      createdAt   TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS video_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      anonymousId TEXT    NOT NULL,
      videoId     TEXT    NOT NULL,
      title       TEXT,
      watchedAt   TEXT    NOT NULL,
      createdAt   TEXT    DEFAULT (datetime('now'))
    );
  `);
}

module.exports = { db, initializeDB };
