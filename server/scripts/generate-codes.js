#!/usr/bin/env node
/**
 * 참여코드 명단 생성 — seed-codes.js가 그대로 읽는 code,group CSV를 만든다.
 *
 * 형식은 확장 프로그램 온보딩의 parseParticipantCode(extension/popup/viewlens-screens.js)가
 * 받는 규칙(^[A-Z]{2,3}-[A-Z2-9]{4}$)을 따라야 한다. 모든 코드가 같은 접두사(VL)를 써서
 * 코드만으로는 그룹을 알 수 없다 — 그룹은 CSV의 group 열(서버 issued_codes)에만 있다.
 * 참여자가 손으로 입력하므로 헷갈리는 I·L·O는 뺀다.
 *
 * 코드 원본은 콘솔에 출력하지 않는다(터미널 기록에 남지 않도록). 이미 있는 파일은 덮어쓰지 않는다 —
 * 참여자에게 나눠준 명단을 실수로 날리지 않기 위함. codes.csv는 .gitignore 대상이다.
 *
 *   node server/scripts/generate-codes.js --exp 20 --con 20 [--out server/codes.csv]
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;
const CODE_SPACE = CODE_CHARS.length ** CODE_LENGTH;
const PREFIX = "VL";
const DEFAULT_OUT = path.join(__dirname, "..", "codes.csv");

/**
 * @param {{exp: number, con: number}} counts
 * @param {(max: number) => number} [randomInt] - 0 이상 max 미만 정수(테스트 주입용)
 * @returns {{code: string, group: string}[]}
 */
function generateCodes({ exp, con }, randomInt = crypto.randomInt) {
  // 두 그룹이 한 접두사를 나눠 쓰므로 합계로 검사한다
  if (exp + con > CODE_SPACE) {
    throw new Error(
      `코드는 두 그룹 합쳐 최대 ${CODE_SPACE}개까지 만들 수 있습니다(요청: ${exp + con}).`,
    );
  }
  const seen = new Set();
  const rows = [];
  for (const [group, count] of [
    ["EXP", exp],
    ["CON", con],
  ]) {
    let made = 0;
    while (made < count) {
      let suffix = "";
      for (let i = 0; i < CODE_LENGTH; i++) {
        suffix += CODE_CHARS[randomInt(CODE_CHARS.length)];
      }
      const code = `${PREFIX}-${suffix}`;
      if (seen.has(code)) continue;
      seen.add(code);
      rows.push({ code, group });
      made += 1;
    }
  }
  return rows;
}

function toCsv(rows) {
  return ["code,group", ...rows.map((r) => `${r.code},${r.group}`)].join("\n");
}

/** 파일이 이미 있으면 EEXIST로 실패한다(flag "wx"). */
function writeCodesFile(file, rows) {
  fs.writeFileSync(file, `${toCsv(rows)}\n`, { flag: "wx" });
}

function parseArgs(argv) {
  const args = { exp: NaN, con: NaN, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 2) {
    const [key, value] = [argv[i], argv[i + 1]];
    if (!["--exp", "--con", "--out"].includes(key)) {
      throw new Error(`알 수 없는 인자: ${key}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${key} 뒤에 값이 필요합니다.`);
    }
    if (key === "--exp") args.exp = Number(value);
    else if (key === "--con") args.con = Number(value);
    else args.out = path.resolve(value);
  }
  for (const key of ["exp", "con"]) {
    if (!Number.isInteger(args[key]) || args[key] < 0) {
      throw new Error(`--${key}는 0 이상의 정수여야 합니다.`);
    }
  }
  return args;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const rows = generateCodes(args);
    writeCodesFile(args.out, rows);
    console.log(
      `생성 완료: EXP ${args.exp}개, CON ${args.con}개 → ${args.out}`,
    );
  } catch (err) {
    if (err.code === "EEXIST") {
      console.error(
        `이미 파일이 있어 덮어쓰지 않습니다: ${err.path}\n나눠준 명단이 아닌지 확인한 뒤 옮기거나 --out으로 다른 경로를 지정하세요.`,
      );
    } else {
      console.error(err.message);
      console.error(
        "사용법: node server/scripts/generate-codes.js --exp 20 --con 20 [--out server/codes.csv]",
      );
    }
    process.exitCode = 1;
  }
}

module.exports = {
  generateCodes,
  toCsv,
  writeCodesFile,
  parseArgs,
  CODE_CHARS,
  CODE_SPACE,
};
