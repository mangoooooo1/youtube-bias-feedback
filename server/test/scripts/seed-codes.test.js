import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 실제 issued_codes 스키마(initializeDB)로 검증한다. DB_PATH를 임시 파일로 바꿔 운영 DB를 열지 않는다.
const require = createRequire(import.meta.url);
const TEST_DB_PATH = path.join(
  os.tmpdir(),
  `viewlens-seed-codes-${process.pid}.db`,
);
fs.rmSync(TEST_DB_PATH, { force: true });
process.env.DB_ENCRYPTION_KEY = "vitest-in-memory-only";
process.env.DB_PATH = TEST_DB_PATH;

const { db, initializeDB } = require("../../db.js");
initializeDB();

const { parseCodesCsv, seedCodes } = require("../../scripts/seed-codes.js");
const { generateCodes, toCsv } = require("../../scripts/generate-codes.js");

const issued = () =>
  db.prepare("SELECT code, group_code FROM issued_codes ORDER BY code").all();

beforeEach(() => {
  db.exec("DELETE FROM issued_codes");
});

afterAll(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${TEST_DB_PATH}${suffix}`, { force: true });
  }
});

describe("parseCodesCsv", () => {
  it("첫 줄(헤더)을 빼고 칸마다 앞뒤 공백을 지운다", () => {
    expect(parseCodesCsv("code,group\n VL-AAA2 , EXP \nVL-BBB3,CON")).toEqual([
      ["VL-AAA2", "EXP"],
      ["VL-BBB3", "CON"],
    ]);
  });

  it.each([
    ["CRLF", "code,group\r\nVL-AAA2,EXP\r\nVL-BBB3,CON\r\n"],
    ["LF", "code,group\nVL-AAA2,EXP\nVL-BBB3,CON\n"],
    ["CR", "code,group\rVL-AAA2,EXP\rVL-BBB3,CON\r"],
    ["BOM(엑셀 CSV UTF-8)", "\uFEFFcode,group\r\nVL-AAA2,EXP\r\nVL-BBB3,CON"],
  ])("%s 줄바꿈·형식을 받는다", (_label, text) => {
    expect(parseCodesCsv(text)).toEqual([
      ["VL-AAA2", "EXP"],
      ["VL-BBB3", "CON"],
    ]);
  });

  it("빈 줄과 쉼표만 있는 줄(엑셀의 빈 행)은 건너뛰고, 헤더 대소문자·공백은 가리지 않는다", () => {
    expect(
      parseCodesCsv("\n Code , GROUP \nVL-AAA2,EXP\n\n , \n,\nVL-BBB3,CON\n\n"),
    ).toEqual([
      ["VL-AAA2", "EXP"],
      ["VL-BBB3", "CON"],
    ]);
  });

  it("빈 파일이거나 헤더만 있으면 빈 목록이다(0개 실행은 CLI가 막는다)", () => {
    expect(parseCodesCsv("")).toEqual([]);
    expect(parseCodesCsv("code,group\n")).toEqual([]);
  });

  it.each([
    ["헤더 없는 파일", "VL-AAA2,EXP\nVL-BBB3,CON"],
    ["세미콜론 구분", "code;group\nVL-AAA2;EXP"],
    ["탭 구분", "code\tgroup\nVL-AAA2\tEXP"],
  ])(
    "%s은 헤더가 아니라고 알리고 코드는 메시지에 넣지 않는다",
    (_label, text) => {
      expect(() => parseCodesCsv(text)).toThrow(
        "1번째 줄이 code,group 헤더가 아니라",
      );
      expect(() => parseCodesCsv(text)).not.toThrow("VL-AAA2");
    },
  );
});

// 일부만 등록하면 빠진 참여자가 온보딩할 수 없어, 문제가 있는 줄이 하나라도 있으면 전부 거부한다
describe("parseCodesCsv — 문제가 있는 줄", () => {
  it("칸이 빈 줄은 줄 번호를 알리고 같은 명단의 올바른 줄도 돌려주지 않는다", () => {
    expect(() =>
      parseCodesCsv("code,group\nVL-AAA2,EXP\nVL-BBB3\n,CON\nVL-CCC4,"),
    ).toThrow("3번째 줄(빈 칸), 4번째 줄(빈 칸), 5번째 줄(빈 칸)");
  });

  it.each([
    ["따옴표로 감싼 code", '"VL-AAA2"'],
    ["자리 수가 틀린 code", "VL-AAA"],
    ["확장이 받지 않는 문자(1)", "VL-AAA1"],
  ])("%s는 code 형식 오류로 알리고 코드는 메시지에 넣지 않는다", (_l, code) => {
    const text = `code,group\nVL-BBB3,CON\n${code},EXP`;

    expect(() => parseCodesCsv(text)).toThrow("3번째 줄(code 형식)");
    expect(() => parseCodesCsv(text)).not.toThrow(code);
  });

  it("같은 code(대소문자 무관)가 다시 나오면 처음 나온 줄 번호와 함께 알린다", () => {
    expect(() =>
      parseCodesCsv("code,group\nVL-AAA2,EXP\nVL-BBB3,CON\nvl-aaa2,CON"),
    ).toThrow("4번째 줄(2번째 줄과 같은 code)");
  });

  it("줄 번호는 앞쪽 빈 줄까지 센 원본 파일 기준이고, 여러 문제를 한 번에 알린다", () => {
    expect(() =>
      parseCodesCsv("\n\ncode,group\nVL-AAA2,EXP\nVL-BBB3,XXX\n\nVL-CC,CON"),
    ).toThrow("5번째 줄(XXX), 7번째 줄(code 형식)");
  });
});

describe("seedCodes", () => {
  it("code와 group을 대문자로 맞춰 등록하고 새로 넣은 수와 전체 수를 돌려준다", () => {
    const result = seedCodes(db, [
      ["vl-aaa2", "exp"],
      ["VL-BBB3", "Con"],
    ]);

    expect(result).toEqual({ inserted: 2, total: 2 });
    expect(issued()).toEqual([
      { code: "VL-AAA2", group_code: "EXP" },
      { code: "VL-BBB3", group_code: "CON" },
    ]);
  });

  it("다시 실행해도 이미 있는 code는 건너뛰고 새 code만 더한다", () => {
    seedCodes(db, [["VL-AAA2", "EXP"]]);

    const result = seedCodes(db, [
      ["vl-aaa2", "CON"], // 같은 code(대소문자 무관)는 group이 달라도 덮지 않는다
      ["VL-BBB3", "CON"],
    ]);

    expect(result).toEqual({ inserted: 1, total: 2 });
    expect(issued()).toEqual([
      { code: "VL-AAA2", group_code: "EXP" },
      { code: "VL-BBB3", group_code: "CON" },
    ]);
  });
});

// 명단의 group은 서버 등록 때 그대로 참여자 그룹이 된다(participants-store.js) — 오타가 있으면 전부 거부한다
describe("group 검증", () => {
  it("소문자 exp·con은 대문자로 맞춰 받는다", () => {
    const rows = parseCodesCsv("code,group\nVL-AAA2,exp\nVL-BBB3,con");
    expect(seedCodes(db, rows)).toEqual({ inserted: 2, total: 2 });
  });

  it.each([
    ["오타", "EPX"],
    ["테스트 그룹", "TEST-EXP"],
  ])(
    "%s group(%s)이 있으면 줄 번호와 값을 알리고 코드는 메시지에 넣지 않는다",
    (_label, group) => {
      const text = `code,group\nVL-AAA2,EXP\nVL-BBB3,${group}`;

      expect(() => parseCodesCsv(text)).toThrow(`3번째 줄(${group})`);
      expect(() => parseCodesCsv(text)).not.toThrow("VL-BBB3");
    },
  );

  it("잘못된 group이 하나라도 있으면 같은 명단의 올바른 줄도 등록하지 않는다", () => {
    expect(() =>
      seedCodes(db, [
        ["VL-AAA2", "EXP"],
        ["VL-BBB3", "EPX"],
      ]),
    ).toThrow("EPX");
    expect(issued()).toEqual([]);
  });
});

describe("generate-codes → seed-codes 왕복", () => {
  it("generate-codes가 만든 CSV를 그대로 읽어 생성한 code와 group이 모두 등록된다", () => {
    const rows = generateCodes({ exp: 3, con: 2 });

    const result = seedCodes(db, parseCodesCsv(toCsv(rows)));

    expect(result).toEqual({ inserted: 5, total: 5 });
    expect(issued()).toEqual(
      rows
        .map((r) => ({ code: r.code, group_code: r.group }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    );
  });
});
