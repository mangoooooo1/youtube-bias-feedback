import { describe, it, expect } from "vitest";
import {
  isValidRemoteDir,
  isValidRemoteRetention,
} from "../../scripts/backup-db-validate.js";

describe("isValidRemoteDir — 원격 쉘 명령(mkdir/find)에 삽입되는 디렉터리 검증", () => {
  it.each(["db-backups", "backups/sub", "back_up-01", "a"])(
    "영문/숫자/_/-// 로만 이뤄진 경로 '%s'는 허용한다",
    (dir) => {
      expect(isValidRemoteDir(dir)).toBe(true);
    },
  );

  it.each([
    ["세미콜론으로 명령 연결", "db-backups; rm -rf /"],
    ["&&로 명령 연결", "db-backups && whoami"],
    ["파이프", "db-backups|cat /etc/passwd"],
    ["백틱 명령 치환", "db-backups`whoami`"],
    ["$() 명령 치환", "$(whoami)"],
    ["공백 포함", "db backups"],
    ["빈 문자열", ""],
    ["개행 포함", "db-backups\nwhoami"],
  ])("%s('%s')는 거부한다", (_label, dir) => {
    expect(isValidRemoteDir(dir)).toBe(false);
  });
});

describe("isValidRemoteRetention — 원격 find -mtime 인자로 쓰이는 보관일수 검증", () => {
  it.each([0, 1, 14, 365])("%i(0 이상의 정수)는 허용한다", (value) => {
    expect(isValidRemoteRetention(value)).toBe(true);
  });

  it.each([
    ["음수", -1],
    ["실수", 1.5],
    ["숫자 문자열(타입 강제 변환 없음)", "14"],
    ["NaN", NaN],
    ["Infinity", Infinity],
  ])("%s(%p)는 거부한다", (_label, value) => {
    expect(isValidRemoteRetention(value)).toBe(false);
  });
});
