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

// 확장 온보딩(parseParticipantCode, extension/popup/viewlens-screens.js)이 받는 형식과 같다.
// 런타임이 달라 모듈 공유가 안 돼 중복 정의(바뀌면 양쪽 다 갱신). 따옴표째 들어온 code도 여기서 걸린다.
const CODE_PATTERN = /^[A-Z]{2,3}-[A-Z2-9]{4}$/;

function invalidGroupError(where) {
  return new Error(
    `group은 ${CODE_GROUPS.join("/")}만 쓸 수 있어 아무것도 등록하지 않았습니다: ${where.join(", ")}`,
  );
}

const cellsOf = (line) => line.split(",").map((s) => s.trim());

/**
 * 명단 CSV를 [code, group] 줄 목록으로 읽는다.
 * - BOM과 CRLF·LF·CR 줄바꿈을 받고, 빈 줄(쉼표만 있는 줄 포함)은 건너뛴다.
 * - 첫 내용 줄은 code,group 헤더여야 한다. 헤더가 없거나 쉼표가 아닌 구분자면 첫 코드가
 *   빠지거나 0개로 끝나 알아채기 어렵다.
 * - 칸이 빈 줄, 허용되지 않은 group, 형식이 틀린 code, 같은 code가 다시 나온 줄이 하나라도 있으면
 *   원본 파일 기준 줄 번호를 담아 예외를 던진다. 일부만 등록하면 빠진 참여자가 온보딩할 수 없다.
 * 코드 원본은 메시지에 넣지 않는다(터미널 기록에 남지 않도록).
 * @param {string} text
 * @returns {string[][]}
 */
function parseCodesCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  const isBlank = (line) => cellsOf(line).every((s) => s === "");
  const headerIndex = lines.findIndex((line) => !isBlank(line));
  if (headerIndex === -1) return [];
  const [first, second] = cellsOf(lines[headerIndex]).map((s) =>
    s.toLowerCase(),
  );
  if (first !== "code" || second !== "group") {
    // 헤더 자리에 코드가 있을 수 있어 내용은 메시지에 넣지 않는다
    throw new Error(
      `${headerIndex + 1}번째 줄이 code,group 헤더가 아니라 아무것도 등록하지 않았습니다. 쉼표로 구분한 CSV인지, 첫 줄에 헤더가 있는지 확인하세요.`,
    );
  }

  const rows = [];
  const invalid = [];
  const firstLineOf = new Map();
  lines.slice(headerIndex + 1).forEach((line, offset) => {
    if (isBlank(line)) return;
    const lineNo = headerIndex + offset + 2;
    const [code = "", group = ""] = cellsOf(line);
    if (!code || !group) {
      invalid.push(`${lineNo}번째 줄(빈 칸)`);
    } else if (!isAllowedGroup(group)) {
      invalid.push(`${lineNo}번째 줄(${group})`);
    } else if (!CODE_PATTERN.test(code.toUpperCase())) {
      invalid.push(`${lineNo}번째 줄(code 형식)`);
    } else if (firstLineOf.has(code.toUpperCase())) {
      invalid.push(
        `${lineNo}번째 줄(${firstLineOf.get(code.toUpperCase())}번째 줄과 같은 code)`,
      );
    } else {
      firstLineOf.set(code.toUpperCase(), lineNo);
      rows.push([code, group]);
    }
  });
  if (invalid.length > 0) {
    throw new Error(
      `명단에 문제가 있어 아무것도 등록하지 않았습니다(group은 ${CODE_GROUPS.join("/")}만): ${invalid.join(", ")}`,
    );
  }
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

    const rows = parseCodesCsv(fs.readFileSync(file, "utf8"));
    if (rows.length === 0)
      throw new Error(
        "등록할 코드가 없습니다. 헤더 아래에 code,group 줄이 있는지 확인하세요.",
      );
    const { inserted, total } = seedCodes(db, rows);
    console.log(`신규 등록: ${inserted}개 / issued_codes 총계: ${total}개`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { parseCodesCsv, seedCodes };
