#!/usr/bin/env node
/**
 * SQLite 핫 백업 스크립트 (cron 실행용)
 *
 * 실행 중인 DB를 안전하게 복사한다: WAL 체크포인트(TRUNCATE)로 WAL 내용을 메인 .db 파일에
 * 전부 반영한 뒤 파일을 복사한다. 암호화된 DB는 online backup API(db.backup())를 못 쓴다 —
 * 독립적으로 생성된 두 암호화 파일은 salt가 달라 "incompatible source and target databases"로
 * 실패한다. 체크포인트 후 파일 복사는 암호화된 바이트를 그대로 복제하므로 이 문제가 없다.
 *
 * - 백업 대상 : server/youtube_bias.db
 * - 저장 위치 : BACKUP_DIR (기본 ~/db-backups) — repo 밖에 둬 git pull/배포와 분리
 * - 파일명    : youtube_bias-YYYYMMDD-HHMMSS.db
 * - 로테이션  : RETENTION_DAYS(기본 30일) 지난 백업 자동 삭제
 *
 * 오프사이트 복사(선택): E1_BACKUP_HOST가 설정된 경우에만, 백업 후 원격 서버로 scp 전송한다.
 * 단일 디스크 장애 대비. best-effort라 전송 실패해도 로컬 백업은 유효(스크립트 성공).
 * 원격 주소·키는 코드에 두지 않고 환경변수로만 받는다(레포·이력에 노출 방지).
 *   E1_BACKUP_HOST      원격 호스트(IP). 설정 시 오프사이트 활성화
 *   E1_BACKUP_USER      원격 사용자 (기본 ubuntu)
 *   E1_BACKUP_KEY       개인키 경로 (기본 ~/.ssh/e1_backup)
 *   E1_BACKUP_DIR       원격 저장 디렉터리 (기본 db-backups, 홈 기준 상대경로)
 *   E1_RETENTION_DAYS   원격 보관 일수 (기본 14)
 *
 * 사용:
 *   node server/scripts/backup-db.js
 *   BACKUP_DIR=/mnt/backups RETENTION_DAYS=60 node server/scripts/backup-db.js
 *   E1_BACKUP_HOST=203.0.113.9 node server/scripts/backup-db.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const Database = require("better-sqlite3-multiple-ciphers");

// cron으로 실행될 때는 server/.env가 자동으로 로드되지 않으므로 명시적으로 불러온다.
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const DB_PATH = path.join(__dirname, "..", "youtube_bias.db");
const BACKUP_DIR =
  process.env.BACKUP_DIR || path.join(os.homedir(), "db-backups");
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
const DB_ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY;

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
  if (!DB_ENCRYPTION_KEY) {
    console.error("[backup] DB_ENCRYPTION_KEY 환경변수가 필요합니다.");
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const dest = path.join(BACKUP_DIR, `youtube_bias-${timestamp()}.db`);
  const db = new Database(DB_PATH);
  db.pragma("cipher = 'sqlcipher'"); // db.js와 동일 cipher(AES-256)로 맞춰야 키가 들어맞는다
  db.key(Buffer.from(DB_ENCRYPTION_KEY)); // 문자열 보간 대신 바인딩 API — db.js와 동일 이유
  try {
    db.pragma("wal_checkpoint(TRUNCATE)"); // WAL 내용을 메인 파일에 전부 반영
  } finally {
    db.close();
  }
  fs.copyFileSync(DB_PATH, dest); // 암호화된 바이트를 그대로 복사 — 대상 파일도 자동으로 동일하게 암호화됨
  const sizeKb = Math.round(fs.statSync(dest).size / 1024);
  console.log(`[backup] 완료: ${dest} (${sizeKb} KB)`);

  // 로테이션 — RETENTION_DAYS 지난 백업 삭제
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    if (!/^youtube_bias-\d{8}-\d{6}\.db$/.test(name)) continue;
    const full = path.join(BACKUP_DIR, name);
    // 개별 파일 정리 실패(권한·레이스 등)가 성공한 백업 전체를 실패로 만들지 않도록 방어
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch (err) {
      console.warn(`[backup] 로테이션 건너뜀 (${name}):`, err.message);
    }
  }
  if (removed)
    console.log(
      `[backup] 로테이션: 오래된 백업 ${removed}개 삭제 (>${RETENTION_DAYS}일)`,
    );

  offsitePush(dest);
}

// 오프사이트 복사 — E1_BACKUP_HOST가 설정된 경우에만 동작.
// best-effort: 전송/원격정리 실패해도 로컬 백업은 이미 성공했으므로 경고만 남기고 넘어간다.
function offsitePush(dest) {
  const host = process.env.E1_BACKUP_HOST;
  if (!host) return; // 미설정 → 오프사이트 비활성화

  const user = process.env.E1_BACKUP_USER || "ubuntu";
  const key =
    process.env.E1_BACKUP_KEY || path.join(os.homedir(), ".ssh", "e1_backup");
  const remoteDir = process.env.E1_BACKUP_DIR || "db-backups";
  const remoteRetention = Number(process.env.E1_RETENTION_DAYS || 14);

  // remoteDir/remoteRetention은 원격 쉘 명령(mkdir/find)에 삽입되므로 검증한다.
  // 쉘 메타문자·공백 유입 시 원격에서 의도치 않은 실행/구문 오류 방지. (실패해도 로컬 백업은 유효)
  if (!/^[a-zA-Z0-9_/-]+$/.test(remoteDir)) {
    console.warn(
      "[backup] 오프사이트 건너뜀: E1_BACKUP_DIR에 허용되지 않는 문자가 있습니다.",
    );
    return;
  }
  if (!Number.isInteger(remoteRetention) || remoteRetention < 0) {
    console.warn(
      "[backup] 오프사이트 건너뜀: E1_RETENTION_DAYS가 0 이상의 정수가 아닙니다.",
    );
    return;
  }

  const target = `${user}@${host}`;
  // BatchMode=yes: 프롬프트 없이 즉시 실패(자동화용). known_hosts는 최초 수동 접속 시 등록됨.
  const sshOpts = ["-i", key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

  // 네트워크 장애·원격 지연으로 무한 대기하면 후속 크론 작업까지 막히므로 타임아웃을 건다.
  const execOpts = { stdio: "pipe", timeout: 30000 };

  try {
    execFileSync(
      "ssh",
      [...sshOpts, target, `mkdir -p ${remoteDir}`],
      execOpts,
    );
    execFileSync(
      "scp",
      [...sshOpts, dest, `${target}:${remoteDir}/`],
      execOpts,
    );
    // 원격 로테이션 — remoteRetention일 지난 백업 삭제
    execFileSync(
      "ssh",
      [
        ...sshOpts,
        target,
        `find ${remoteDir} -maxdepth 1 -name 'youtube_bias-*.db' -mtime +${remoteRetention} -delete`,
      ],
      execOpts,
    );
    console.log(
      `[backup] 오프사이트 전송 완료: ${target}:${remoteDir}/ (보관 ${remoteRetention}일)`,
    );
  } catch (err) {
    // err.message에는 SSH 실패 원인이 안 담기는 경우가 많아, stderr가 있으면 함께 남긴다.
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    console.warn("[backup] 오프사이트 전송 실패(로컬 백업은 정상):", detail);
  }
}

main().catch((err) => {
  console.error("[backup] 실패:", err.message);
  process.exit(1);
});
