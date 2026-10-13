// backup-db.js를 실제로 실행해 암호화 백업·로테이션을 검증한다.
// 경로·키는 모두 인자로 넘겨 저장소 DB와 ~/db-backups를 건드리지 않는다.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, rotateBackups, offsitePush } from "../../scripts/backup-db.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3-multiple-ciphers");

const KEY = "backup-test-key";
const DAY = 24 * 60 * 60 * 1000;
const BACKUP_NAME = /^youtube_bias-\d{8}-\d{6}\.db$/;

function openWithKey(dbPath, key) {
  const db = new Database(dbPath);
  db.pragma("cipher = 'sqlcipher'");
  db.key(Buffer.from(key));
  return db;
}

function backupFiles(dir) {
  return fs.readdirSync(dir).filter((name) => BACKUP_NAME.test(name));
}

function touch(dir, name, mtimeMs) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "");
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

let tmpDir;
let backupDir;
let errorSpy;
let logSpy;
let warnSpy;
let prevExitCode;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viewlens-backup-"));
  backupDir = path.join(tmpDir, "backups");
  // 오프사이트 전송이 실행되지 않게 한다(로컬 .env·셸 env와 무관하게)
  vi.stubEnv("E1_BACKUP_HOST", "");
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  prevExitCode = process.exitCode;
});

afterEach(() => {
  process.exitCode = prevExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("main — 실패 종료", () => {
  it("DB 파일이 없으면 기존 문구로 실패하고 백업을 만들지 않는다", async () => {
    const dbPath = path.join(tmpDir, "missing.db");
    await main({ dbPath, backupDir, retentionDays: 30, encryptionKey: KEY });

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(`[backup] DB 파일 없음: ${dbPath}`);
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  // 기본값(env)이 적용되지 않도록 undefined 대신 빈 문자열로 키 없음을 표현한다
  it("암호화 키가 없으면 기존 문구로 실패하고 백업을 만들지 않는다", async () => {
    const dbPath = path.join(tmpDir, "source.db");
    openWithKey(dbPath, KEY).close();
    await main({ dbPath, backupDir, retentionDays: 30, encryptionKey: "" });

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[backup] DB_ENCRYPTION_KEY 환경변수가 필요합니다.",
    );
    expect(fs.existsSync(backupDir)).toBe(false);
  });
});

describe("main — 암호화 백업", () => {
  let dbPath;
  let writer;

  beforeEach(() => {
    dbPath = path.join(tmpDir, "source.db");
    // 운영 서버처럼 쓰기 연결을 연 채로 백업한다. 자동 체크포인트를 꺼 행이 WAL에만 남게 한다
    writer = openWithKey(dbPath, KEY);
    writer.pragma("journal_mode = WAL");
    writer.pragma("wal_autocheckpoint = 0");
    writer.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, note TEXT)");
    const insert = writer.prepare("INSERT INTO events (note) VALUES (?)");
    for (let i = 0; i < 3; i++) insert.run(`row-${i}`);
  });

  afterEach(() => {
    writer.close();
  });

  it("WAL에만 있던 행까지 담은 백업을 형식에 맞는 이름으로 만든다", async () => {
    expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

    await main({ dbPath, backupDir, retentionDays: 30, encryptionKey: KEY });

    expect(process.exitCode).toBe(prevExitCode);
    const files = backupFiles(backupDir);
    expect(files).toHaveLength(1);

    const backup = openWithKey(path.join(backupDir, files[0]), KEY);
    try {
      expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(backup.prepare("SELECT COUNT(*) AS n FROM events").get().n).toBe(
        3,
      );
    } finally {
      backup.close();
    }
  });

  it("백업 파일은 틀린 키로 열 수 없다(암호화 유지)", async () => {
    await main({ dbPath, backupDir, retentionDays: 30, encryptionKey: KEY });

    const [file] = backupFiles(backupDir);
    const wrong = openWithKey(path.join(backupDir, file), "wrong-key");
    try {
      expect(() =>
        wrong.prepare("SELECT COUNT(*) FROM events").get(),
      ).toThrow();
    } finally {
      wrong.close();
    }
  });
});

describe("rotateBackups — 보관 기간 지난 백업 삭제", () => {
  const NOW = Date.parse("2026-10-13T00:00:00Z");

  beforeEach(() => {
    fs.mkdirSync(backupDir);
  });

  it("보관 기간이 지난 백업 형식 파일만 삭제한다", () => {
    touch(backupDir, "youtube_bias-20260912-000000.db", NOW - 31 * DAY);
    touch(backupDir, "youtube_bias-20260914-000000.db", NOW - 29 * DAY);
    touch(backupDir, "youtube_bias-20261013-000000.db", NOW);
    // 이름 형식이 다르면 오래돼도 지우지 않는다
    touch(backupDir, "youtube_bias.db", NOW - 40 * DAY);
    touch(backupDir, "x.txt", NOW - 40 * DAY);

    rotateBackups(backupDir, 30, NOW);

    expect(fs.readdirSync(backupDir).sort()).toEqual([
      "x.txt",
      "youtube_bias-20260914-000000.db",
      "youtube_bias-20261013-000000.db",
      "youtube_bias.db",
    ]);
    expect(logSpy).toHaveBeenCalledWith(
      "[backup] 로테이션: 오래된 백업 1개 삭제 (>30일)",
    );
  });

  // 같은 이름의 디렉터리는 unlinkSync가 실제로 실패한다(mock 없이 삭제 실패 재현)
  it("파일 하나의 삭제가 실패해도 경고만 남기고 나머지를 정리한다", () => {
    const stuck = path.join(backupDir, "youtube_bias-20260801-000000.db");
    fs.mkdirSync(stuck);
    fs.utimesSync(stuck, (NOW - 60 * DAY) / 1000, (NOW - 60 * DAY) / 1000);
    touch(backupDir, "youtube_bias-20260902-000000.db", NOW - 41 * DAY);

    expect(() => rotateBackups(backupDir, 30, NOW)).not.toThrow();

    expect(fs.readdirSync(backupDir)).toEqual([
      "youtube_bias-20260801-000000.db",
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      "[backup] 로테이션 건너뜀 (youtube_bias-20260801-000000.db):",
      expect.any(String),
    );
    expect(logSpy).toHaveBeenCalledWith(
      "[backup] 로테이션: 오래된 백업 1개 삭제 (>30일)",
    );
  });
});

describe("offsitePush — 오프사이트 전송", () => {
  const DEST = "/backups/youtube_bias-20261013-000000.db";
  const SSH_OPTS = [
    "-i",
    "/keys/e1",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
  ];
  const EXEC_OPTS = { stdio: "pipe", timeout: 30000 };
  const BASE_ENV = { E1_BACKUP_HOST: "203.0.113.9", E1_BACKUP_KEY: "/keys/e1" };

  it("E1_BACKUP_HOST가 없으면 원격 명령을 실행하지 않는다", () => {
    const exec = vi.fn();
    offsitePush(DEST, { env: {}, exec });
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    ["E1_BACKUP_DIR", "a;rm -rf ~", "E1_BACKUP_DIR에 허용되지 않는 문자"],
    ["E1_BACKUP_DIR", "a b", "E1_BACKUP_DIR에 허용되지 않는 문자"],
    ["E1_RETENTION_DAYS", "-1", "E1_RETENTION_DAYS가 0 이상의 정수가 아닙니다"],
    [
      "E1_RETENTION_DAYS",
      "1.5",
      "E1_RETENTION_DAYS가 0 이상의 정수가 아닙니다",
    ],
  ])("%s=%j이면 원격 명령 없이 경고만 남긴다", (name, value, reason) => {
    const exec = vi.fn();
    offsitePush(DEST, { env: { ...BASE_ENV, [name]: value }, exec });

    expect(exec).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`[backup] 오프사이트 건너뜀: ${reason}`),
    );
  });

  it("mkdir → scp → 원격 로테이션 순으로 타임아웃을 걸어 실행한다", () => {
    const exec = vi.fn();
    offsitePush(DEST, { env: { ...BASE_ENV, E1_RETENTION_DAYS: "7" }, exec });

    const target = "ubuntu@203.0.113.9";
    expect(exec.mock.calls).toEqual([
      ["ssh", [...SSH_OPTS, target, "mkdir -p db-backups"], EXEC_OPTS],
      ["scp", [...SSH_OPTS, DEST, `${target}:db-backups/`], EXEC_OPTS],
      [
        "ssh",
        [
          ...SSH_OPTS,
          target,
          "find db-backups -maxdepth 1 -name 'youtube_bias-*.db' -mtime +7 -delete",
        ],
        EXEC_OPTS,
      ],
    ]);
    expect(logSpy).toHaveBeenCalledWith(
      `[backup] 오프사이트 전송 완료: ${target}:db-backups/ (보관 7일)`,
    );
  });

  // backup-checked.sh는 이 문구가 출력에 있어야 Healthchecks에 실패로 보고한다
  it("scp가 실패하면 '오프사이트 전송 실패'와 stderr를 남기고 예외를 던지지 않는다", () => {
    const exec = vi.fn((cmd) => {
      if (cmd !== "scp") return;
      const err = new Error("Command failed: scp");
      err.stderr = Buffer.from("ssh: connect to host 203.0.113.9: timed out\n");
      throw err;
    });

    expect(() => offsitePush(DEST, { env: BASE_ENV, exec })).not.toThrow();

    expect(exec).toHaveBeenCalledTimes(2); // 원격 로테이션까지 가지 않는다
    expect(warnSpy).toHaveBeenCalledWith(
      "[backup] 오프사이트 전송 실패(로컬 백업은 정상):",
      "ssh: connect to host 203.0.113.9: timed out",
    );
    expect(process.exitCode).toBe(prevExitCode);
  });
});
