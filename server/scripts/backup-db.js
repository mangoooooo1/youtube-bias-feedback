#!/usr/bin/env node
/**
 * SQLite 핫 백업 스크립트 (cron 실행용)
 *
 * 실행 중인 DB를 안전하게 복사한다(better-sqlite3의 db.backup() = online backup API).
 * 단순 파일 복사(cp)와 달리 WAL 체크포인트 정합성을 보장하므로 서버 가동 중에도 안전하다.
 *
 * - 백업 대상 : server/youtube_bias.db
 * - 저장 위치 : BACKUP_DIR (기본 ~/db-backups) — repo 밖에 둬 git pull/배포와 분리
 * - 파일명    : youtube_bias-YYYYMMDD-HHMMSS.db
 * - 로테이션  : RETENTION_DAYS(기본 30일) 지난 백업 자동 삭제
 *
 * 사용:
 *   node server/scripts/backup-db.js
 *   BACKUP_DIR=/mnt/backups RETENTION_DAYS=60 node server/scripts/backup-db.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "..", "youtube_bias.db");
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(os.homedir(), "db-backups");
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[backup] DB 파일 없음: ${DB_PATH}`);
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const dest = path.join(BACKUP_DIR, `youtube_bias-${timestamp()}.db`);
  const db = new Database(DB_PATH, { readonly: true });
  try {
    await db.backup(dest);
    const sizeKb = Math.round(fs.statSync(dest).size / 1024);
    console.log(`[backup] 완료: ${dest} (${sizeKb} KB)`);
  } finally {
    db.close();
  }

  // 로테이션 — RETENTION_DAYS 지난 백업 삭제
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    if (!/^youtube_bias-\d{8}-\d{6}\.db$/.test(name)) continue;
    const full = path.join(BACKUP_DIR, name);
    if (fs.statSync(full).mtimeMs < cutoff) {
      fs.unlinkSync(full);
      removed++;
    }
  }
  if (removed) console.log(`[backup] 로테이션: 오래된 백업 ${removed}개 삭제 (>${RETENTION_DAYS}일)`);

  // TODO(오프사이트): 단일 서버 디스크 장애 대비 원격 1부 복사 권장.
  //   예) rclone copy "${dest}" remote:youtube-bias-backups/
  //       또는 scp "${dest}" user@host:/backups/
}

main().catch((err) => {
  console.error("[backup] 실패:", err.message);
  process.exit(1);
});
