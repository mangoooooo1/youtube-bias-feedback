#!/usr/bin/env node
/**
 * SQLite 핫 백업 스크립트 (cron 실행용)
 *
 * 실행 중인 DB를 안전하게 복사한다: WAL 체크포인트(TRUNCATE)로 WAL 내용을 메인 .db 파일에
 * 전부 반영한 뒤 파일을 복사한다. 암호화된 DB는 online backup API(db.backup())를 못 쓴다 —
 * 독립적으로 생성된 두 암호화 파일은 salt가 달라 "incompatible source and target databases"로
 * 실패한다. 체크포인트 후 파일 복사는 암호화된 바이트를 그대로 복제하므로 이 문제가 없다.
 *
 * 복사본은 쓰기 전에 검증한다. 체크포인트가 다 끝났는지, 임시 이름으로 복사한 파일이 같은 키로
 * 열리고 quick_check를 통과하는지, 테이블마다 행 수가 원본 이상인지 본다. 통과해야 정식 이름이
 * 붙고 로테이션·오프사이트 전송이 진행된다. 실패하면 임시 파일을 지우고 exit 1로 끝나
 * backup-checked.sh가 실패로 알린다.
 *
 * - 백업 대상 : server/youtube_bias.db
 * - 저장 위치 : BACKUP_DIR (기본 ~/db-backups) — repo 밖에 둬 git pull/배포와 분리
 * - 파일명    : youtube_bias-YYYYMMDD-HHMMSS.db
 * - 로테이션  : RETENTION_DAYS(기본 30일, 1 이상 정수) 지난 백업 자동 삭제
 *               값이 잘못되면 백업은 남기고 로테이션만 건너뛴 뒤 실패(exit 1)로 끝낸다
 *
 * 오프사이트 복사: 백업 후 원격 서버로 scp 전송한다. 단일 디스크 장애 대비.
 * best-effort라 전송 실패해도 로컬 백업은 유효(스크립트 성공). 대신 "오프사이트 전송 실패" 문구를
 * 남겨 backup-checked.sh가 실패로 알린다. E1_BACKUP_HOST가 없을 때도 같다(조용히 꺼지지 않게).
 * 원격 주소·키는 코드에 두지 않고 환경변수로만 받는다(레포·이력에 노출 방지). 값은 GitHub Secret →
 * 배포 때 server/.env로 들어간다. 서버에서 .env를 직접 고치면 다음 배포 때 지워진다.
 *   E1_BACKUP_HOST      원격 호스트(IP). 필수
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
const {
  isValidRemoteDir,
  isValidRemoteRetention,
  isValidRetentionDays,
} = require("./backup-db-validate");

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

function openEncrypted(file, key) {
  const db = new Database(file);
  db.pragma("cipher = 'sqlcipher'"); // db.js와 동일 cipher(AES-256)로 맞춰야 키가 들어맞는다
  db.key(Buffer.from(key)); // 문자열 보간 대신 바인딩 API. db.js와 동일 이유
  return db;
}

/**
 * WAL 내용이 메인 파일에 전부 반영될 때까지 체크포인트를 시도한다.
 * 서버가 읽는 중이면 일부만 반영되고(busy) 남은 변경은 복사본에서 빠지므로, 끝나지 않으면 실패한다.
 */
async function checkpointFully(db, { attempts = 3, waitMs = 2000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    const [result] = db.pragma("wal_checkpoint(TRUNCATE)");
    if (result.busy === 0 && result.log === result.checkpointed) return;
    if (i < attempts) await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error(`WAL 체크포인트가 끝나지 않았습니다(${attempts}회 시도)`);
}

/** 사용자 테이블별 행 수 */
function countRows(db) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .pluck()
    .all();
  return Object.fromEntries(
    tables.map((t) => [
      t,
      db
        .prepare(`SELECT COUNT(*) FROM "${t.replaceAll('"', '""')}"`)
        .pluck()
        .get(),
    ]),
  );
}

/** 복사본이 같은 키로 열리고, 구조가 온전하고, 원본에서 센 행이 모두 있는지 확인한다. 문제가 있으면 throw */
function verifyCopy(file, key, sourceCounts) {
  const db = openEncrypted(file, key);
  try {
    const check = db.pragma("quick_check", { simple: true });
    if (check !== "ok") throw new Error(`quick_check 결과: ${check}`);
    const copyCounts = countRows(db);
    for (const [table, n] of Object.entries(sourceCounts)) {
      if (!(table in copyCounts)) throw new Error(`${table} 테이블 없음`);
      if (copyCounts[table] < n) {
        throw new Error(
          `${table} 행 수 부족(원본 ${n}, 복사본 ${copyCounts[table]})`,
        );
      }
    }
    return Object.keys(copyCounts).length;
  } finally {
    db.close();
  }
}

// 검증 연결을 닫으면 SQLite가 -wal·-shm을 지우지만, 남아 있어도 정식 백업에는 필요 없다
function removeSidecars(file) {
  for (const f of [`${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
}

// 경로·키·오프사이트·복사·체크포인트 주입점은 인자로 줄 수 있다(테스트용). 생략하면 cron 실행과 같은 기본값을 쓴다.
async function main({
  dbPath = DB_PATH,
  backupDir = BACKUP_DIR,
  retentionDays = RETENTION_DAYS,
  encryptionKey = DB_ENCRYPTION_KEY,
  offsite = {},
  copy = fs.copyFileSync,
  checkpoint = {},
} = {}) {
  // process.exit 대신 exitCode. 출력 문구와 종료 코드는 그대로 두고 테스트에서 불러올 수 있게 한다
  if (!fs.existsSync(dbPath)) {
    console.error(`[backup] DB 파일 없음: ${dbPath}`);
    process.exitCode = 1;
    return;
  }
  if (!encryptionKey) {
    console.error("[backup] DB_ENCRYPTION_KEY 환경변수가 필요합니다.");
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(backupDir, { recursive: true });

  const dest = path.join(backupDir, `youtube_bias-${timestamp()}.db`);
  // 로테이션·오프사이트의 파일명 규칙(*.db)에 걸리지 않아, 검증 전 파일은 지워지거나 전송되지 않는다
  const tmp = `${dest}.tmp`;
  let tableCount;
  try {
    const db = openEncrypted(dbPath, encryptionKey);
    let sourceCounts;
    try {
      await checkpointFully(db, checkpoint);
      sourceCounts = countRows(db);
    } finally {
      db.close();
    }
    copy(dbPath, tmp); // 암호화된 바이트를 그대로 복사. 대상 파일도 자동으로 동일하게 암호화됨
    tableCount = verifyCopy(tmp, encryptionKey, sourceCounts);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    removeSidecars(tmp);
    console.error(`[backup] 실패: 검증 실패 — ${err.message}`);
    process.exitCode = 1;
    return;
  }
  removeSidecars(tmp);
  fs.renameSync(tmp, dest);
  const sizeKb = Math.round(fs.statSync(dest).size / 1024);
  console.log(
    `[backup] 완료: ${dest} (${sizeKb} KB, 검증 통과: 테이블 ${tableCount}개)`,
  );

  // 설정 오류로 백업을 잃지 않도록 로테이션만 건너뛰고, 종료 코드로 backup-checked.sh가 실패를 보고하게 한다
  if (isValidRetentionDays(retentionDays)) {
    rotateBackups(backupDir, retentionDays);
  } else {
    console.error(
      `[backup] 로테이션 건너뜀: RETENTION_DAYS가 1 이상의 정수가 아닙니다 (값: ${retentionDays})`,
    );
    process.exitCode = 1;
  }

  offsitePush(dest, offsite);
}

// 로테이션 retentionDays 지난 백업 삭제
function rotateBackups(backupDir, retentionDays, now = Date.now()) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(backupDir)) {
    if (!/^youtube_bias-\d{8}-\d{6}\.db$/.test(name)) continue;
    const full = path.join(backupDir, name);
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
      `[backup] 로테이션: 오래된 백업 ${removed}개 삭제 (>${retentionDays}일)`,
    );
}

// 오프사이트 복사.
// best-effort: 전송/원격정리 실패해도 로컬 백업은 이미 성공했으므로 경고만 남기고 넘어간다.
// env·exec는 테스트에서 원격 명령을 가로채기 위한 주입점이다(서버 모듈은 vi.mock이 닿지 않음).
function offsitePush(dest, { env = process.env, exec = execFileSync } = {}) {
  const host = env.E1_BACKUP_HOST;
  // 설정이 빠진 채 조용히 넘어가 오프사이트가 꺼진 걸 모른 적이 있어, 실패 문구로 알린다
  if (!host) {
    console.warn(
      "[backup] 오프사이트 전송 실패(설정 없음, 로컬 백업은 정상): E1_BACKUP_HOST가 없습니다.",
    );
    return;
  }

  const user = env.E1_BACKUP_USER || "ubuntu";
  const key = env.E1_BACKUP_KEY || path.join(os.homedir(), ".ssh", "e1_backup");
  const remoteDir = env.E1_BACKUP_DIR || "db-backups";
  const remoteRetention = Number(env.E1_RETENTION_DAYS || 14);

  // remoteDir/remoteRetention은 원격 쉘 명령(mkdir/find)에 삽입되므로 검증한다.
  // 쉘 메타문자·공백 유입 시 원격에서 의도치 않은 실행/구문 오류 방지. (실패해도 로컬 백업은 유효)
  // 설정 오류도 복사본이 안 생기므로 backup-checked.sh가 찾는 "오프사이트 전송 실패" 문구로 알린다
  if (!isValidRemoteDir(remoteDir)) {
    console.warn(
      "[backup] 오프사이트 전송 실패(설정 오류, 로컬 백업은 정상): E1_BACKUP_DIR에 허용되지 않는 문자가 있습니다.",
    );
    return;
  }
  if (!isValidRemoteRetention(remoteRetention)) {
    console.warn(
      "[backup] 오프사이트 전송 실패(설정 오류, 로컬 백업은 정상): E1_RETENTION_DAYS가 0 이상의 정수가 아닙니다.",
    );
    return;
  }

  const target = `${user}@${host}`;
  // BatchMode=yes: 프롬프트 없이 즉시 실패(자동화용). known_hosts는 최초 수동 접속 시 등록됨.
  const sshOpts = ["-i", key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

  // 네트워크 장애·원격 지연으로 무한 대기하면 후속 크론 작업까지 막히므로 타임아웃을 건다.
  const execOpts = { stdio: "pipe", timeout: 30000 };

  try {
    exec("ssh", [...sshOpts, target, `mkdir -p ${remoteDir}`], execOpts);
    exec("scp", [...sshOpts, dest, `${target}:${remoteDir}/`], execOpts);
    // 원격 로테이션 — remoteRetention일 지난 백업 삭제
    exec(
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

if (require.main === module) {
  main().catch((err) => {
    console.error("[backup] 실패:", err.message);
    process.exit(1);
  });
}

module.exports = { main, rotateBackups, offsitePush, checkpointFully };
