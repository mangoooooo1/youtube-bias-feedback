// 발급 코드 명단을 issued_codes 테이블에 등록 (일회성, 멱등)
//
// 사용법:
//   node scripts/seed-codes.js codes.csv   (server/에서 실행)
//
// codes.csv 형식 (첫 줄 헤더):
//   code,group
//   VL-K7M2,EXP
//   VL-3F9Q,CON
//
// - INSERT OR IGNORE 이므로 이미 있는 code는 무시된다(재실행 안전).
// - 코드를 추가 발급하면 CSV에 덧붙여 다시 실행하면 된다.

const fs = require("fs");
const path = require("path");
const { CODE_GROUPS } = require("./generate-codes");

const isAllowedGroup = (group) => CODE_GROUPS.includes(group.toUpperCase());

function invalidGroupError(where) {
  return new Error(
    `group은 ${CODE_GROUPS.join("/")}만 쓸 수 있어 아무것도 등록하지 않았습니다: ${where.join(", ")}`,
  );
}

/**
 * 명단 CSV를 [code, group] 줄 목록으로 읽는다. 첫 줄은 헤더로 버리고, 칸이 모자란 줄은 뺀다.
 * 허용되지 않은 group이 하나라도 있으면 그 줄 번호와 group 값을 담아 예외를 던진다.
 * 코드 원본은 메시지에 넣지 않는다(터미널 기록에 남지 않도록).
 * @param {string} text
 * @returns {string[][]}
 */
function parseCodesCsv(text) {
  const rows = [];
  const invalid = [];
  text
    .trim()
    .split(/\r?\n/)
    .forEach((l, i) => {
      if (i === 0) return; // 헤더 제거
      const r = l.split(",").map((s) => s.trim());
      if (!(r.length >= 2 && r[0] && r[1])) return;
      if (!isAllowedGroup(r[1])) invalid.push(`${i + 1}번째 줄(${r[1]})`);
      rows.push(r);
    });
  if (invalid.length > 0) throw invalidGroupError(invalid);
  return rows;
}

/**
 * 명단을 issued_codes에 등록한다(대문자로 맞추고, 이미 있는 code는 건너뜀).
 * @param {import("better-sqlite3").Database} db
 * @param {string[][]} rows - parseCodesCsv 결과
 * @returns {{inserted: number, total: number}}
 */
function seedCodes(db, rows) {
  // parseCodesCsv를 거치지 않고 불러도 잘못된 group은 넣지 않는다
  const invalid = rows.filter(([, group]) => !isAllowedGroup(group));
  if (invalid.length > 0) {
    throw invalidGroupError(invalid.map(([, group]) => group));
  }
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO issued_codes (code, group_code) VALUES (?, ?)",
  );
  const insertMany = db.transaction((rows) => {
    let inserted = 0;
    for (const [code, group] of rows) {
      const info = stmt.run(code.toUpperCase(), group.toUpperCase());
      inserted += info.changes;
    }
    return inserted;
  });

  const inserted = insertMany(rows);
  const total = db.prepare("SELECT COUNT(*) AS c FROM issued_codes").get().c;
  return { inserted, total };
}

if (require.main === module) {
  try {
    const file = process.argv[2];
    if (!file)
      throw new Error("사용법: node scripts/seed-codes.js <codes.csv>");

    // node server/scripts/seed-codes.js처럼 repo 루트에서 실행될 수 있으므로, cwd 기준 기본 동작에
    // 의존하지 않고 명시적으로 server/.env를 불러온다 (server/scripts/backup-db.js와 동일 이유).
    require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
    const { db, initializeDB } = require("../db");
    initializeDB(); // issued_codes 테이블 보장

    const { inserted, total } = seedCodes(
      db,
      parseCodesCsv(fs.readFileSync(file, "utf8")),
    );
    console.log(`신규 등록: ${inserted}개 / issued_codes 총계: ${total}개`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { parseCodesCsv, seedCodes };
