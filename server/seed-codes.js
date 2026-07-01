// 발급 코드 명단을 issued_codes 테이블에 등록 (일회성, 멱등)
//
// 사용법:
//   node seed-codes.js codes.csv
//
// codes.csv 형식 (첫 줄 헤더):
//   code,group
//   QWE-K7M2,EXP
//   ASD-3F9Q,CON
//
// - INSERT OR IGNORE 이므로 이미 있는 code는 무시된다(재실행 안전).
// - 코드를 추가 발급하면 CSV에 덧붙여 다시 실행하면 된다.

const fs = require("fs");
const { db, initializeDB } = require("./db");

initializeDB(); // issued_codes 테이블 보장

const file = process.argv[2];
if (!file) {
  console.error("사용법: node seed-codes.js <codes.csv>");
  process.exit(1);
}

const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
const rows = lines
  .slice(1) // 헤더 제거
  .map((l) => l.split(",").map((s) => s.trim()))
  .filter((r) => r.length >= 2 && r[0]);

const stmt = db.prepare("INSERT OR IGNORE INTO issued_codes (code, group_code) VALUES (?, ?)");
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
console.log(`신규 등록: ${inserted}개 / issued_codes 총계: ${total}개`);
