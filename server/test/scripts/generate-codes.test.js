import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateCodes,
  toCsv,
  writeCodesFile,
  parseArgs,
  CODE_CHARS,
} from "../../scripts/generate-codes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENS_PATH = path.join(
  __dirname,
  "../../../extension/popup/viewlens-screens.js",
);

// 참여자가 코드를 입력할 때 실제로 거치는 확장 프로그램의 검증 함수를 원본 그대로 실행한다 —
// 생성 규칙과 온보딩 규칙이 어긋나면 발급한 코드가 입력 단계에서 거부된다.
function loadParseParticipantCode() {
  const raw = fs.readFileSync(SCREENS_PATH, "utf8");
  const match = raw.match(
    /function parseParticipantCode\(raw\) \{[\s\S]*?\n\}/,
  );
  if (!match) {
    throw new Error(
      "parseParticipantCode를 찾지 못했습니다 — viewlens-screens.js 구조가 바뀌었을 수 있습니다.",
    );
  }
  return new Function(`${match[0]}\nreturn parseParticipantCode;`)();
}

describe("generateCodes", () => {
  it("요청한 개수만큼 그룹별로 만들고 중복이 없다", () => {
    const rows = generateCodes({ exp: 20, con: 20 });

    expect(rows.filter((r) => r.group === "EXP")).toHaveLength(20);
    expect(rows.filter((r) => r.group === "CON")).toHaveLength(20);
    expect(new Set(rows.map((r) => r.code)).size).toBe(40);
  });

  it("모든 코드가 확장 프로그램 온보딩 검증을 통과하고, 그 검증이 판정한 그룹과 같다", () => {
    const parseParticipantCode = loadParseParticipantCode();

    for (const { code, group } of generateCodes({ exp: 20, con: 20 })) {
      expect(parseParticipantCode(code)).toEqual({ group, code });
    }
  });

  it("손으로 입력할 때 헷갈리는 문자(0·1·I·L·O)를 쓰지 않는다", () => {
    expect(CODE_CHARS).not.toMatch(/[01ILO]/);
    for (const { code } of generateCodes({ exp: 50, con: 50 })) {
      expect(code.slice(4)).not.toMatch(/[01ILO]/);
    }
  });

  it("난수가 겹쳐도 다시 뽑아 요청한 개수를 채운다", () => {
    // 첫 코드와 같은 코드를 한 번 더 내다가 그다음부터 다른 코드를 낸다
    const sequence = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1];
    let i = 0;
    const rows = generateCodes({ exp: 2, con: 0 }, () => sequence[i++]);

    expect(rows.map((r) => r.code)).toEqual(["QWE-AAAA", "QWE-BBBB"]);
  });
});

describe("CSV 출력", () => {
  let dir;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("seed-codes.js가 읽는 code,group 형식이다", () => {
    const csv = toCsv([
      { code: "QWE-AB23", group: "EXP" },
      { code: "ASD-CD45", group: "CON" },
    ]);

    expect(csv.split("\n")).toEqual([
      "code,group",
      "QWE-AB23,EXP",
      "ASD-CD45,CON",
    ]);
  });

  it("이미 파일이 있으면 덮어쓰지 않는다(나눠준 명단 보호)", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codes-"));
    const file = path.join(dir, "codes.csv");
    fs.writeFileSync(file, "code,group\nQWE-KEEP,EXP\n");

    expect(() =>
      writeCodesFile(file, [{ code: "QWE-NEW2", group: "EXP" }]),
    ).toThrow(expect.objectContaining({ code: "EEXIST" }));
    expect(fs.readFileSync(file, "utf8")).toContain("QWE-KEEP");
  });
});

describe("parseArgs", () => {
  it("개수를 정수로 읽는다", () => {
    expect(parseArgs(["--exp", "20", "--con", "20"])).toMatchObject({
      exp: 20,
      con: 20,
    });
  });

  it.each([
    [["--exp", "20"]],
    [["--exp", "-1", "--con", "20"]],
    [["--exp", "2.5", "--con", "20"]],
    [["--exp", "20", "--con", "20", "--grp", "x"]],
  ])("잘못된 인자 %j는 거부한다", (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});
