import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statePath, readState, writeState } from "../../monitoring/state.js";

describe("state — 모니터링 상태 파일 저장소", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewlens-monitor-state-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("statePath는 dir 아래 <name>.json 경로를 만든다", () => {
    expect(statePath("error-monitor", dir)).toBe(
      path.join(dir, "error-monitor.json"),
    );
  });

  it("파일이 없으면(최초 실행) fallback을 반환한다", () => {
    const result = readState("error-monitor", { offset: 0 }, dir);
    expect(result).toEqual({ offset: 0 });
  });

  it("writeState로 저장한 값을 readState로 그대로 읽는다", () => {
    const data = { offset: 42, fingerprints: { abc123: { count: 3 } } };
    writeState("error-monitor", data, dir);

    expect(readState("error-monitor", {}, dir)).toEqual(data);
  });

  it("디렉터리가 아직 없어도 writeState가 생성한다", () => {
    const nested = path.join(dir, "nested", "sub");
    writeState("cursor", { offset: 1 }, nested);

    expect(readState("cursor", {}, nested)).toEqual({ offset: 1 });
  });

  it("쓰기 후 임시 파일(.tmp-*)이 남지 않는다(원자적 교체)", () => {
    writeState("error-monitor", { offset: 1 }, dir);

    const files = fs.readdirSync(dir);
    expect(files).toEqual(["error-monitor.json"]);
  });

  it("JSON이 손상돼도 예외를 던지지 않고 fallback을 반환한다", () => {
    const file = statePath("broken", dir);
    fs.writeFileSync(file, "{ not valid json");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = readState("broken", { safe: true }, dir);

    expect(result).toEqual({ safe: true });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("다시 쓰면 이전 값을 덮어쓴다", () => {
    writeState("error-monitor", { offset: 1 }, dir);
    writeState("error-monitor", { offset: 2 }, dir);

    expect(readState("error-monitor", {}, dir)).toEqual({ offset: 2 });
  });
});
