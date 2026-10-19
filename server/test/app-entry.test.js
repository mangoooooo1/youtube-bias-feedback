import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 운영과 같은 방식(node app.js)으로 진입점을 자식 프로세스로 띄워 기동·종료를 확인한다.
// 자식 프로세스는 커버리지에 잡히지 않으므로 app.js 수치는 오르지 않는다.
const APP_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "app.js",
);
const BOOT_TIMEOUT_MS = 15000;

let child;
let workDir;

afterEach(() => {
  if (child && child.exitCode === null) child.kill();
  child = undefined;
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// 작업 디렉터리를 빈 임시 폴더로 두어 dotenv가 개발자의 server/.env를 읽지 않게 하고,
// 부모 프로세스의 환경 변수(운영 키·경로 등)도 넘기지 않는다.
function startApp(env) {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "viewlens-app-entry-"));
  env = typeof env === "function" ? env(workDir) : env;
  child = spawn(process.execPath, [APP_PATH], {
    cwd: workDir,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      NODE_ENV: "test",
      DD_TRACE_ENABLED: "false",
      ...env,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return { output: () => output, exited };
}

async function waitFor(condition, proc) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (!condition()) {
    if (child.exitCode !== null) {
      throw new Error(
        `기동 중 종료됨(code ${child.exitCode}):\n${proc.output()}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`기동 시간 초과:\n${proc.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("app.js 진입점", () => {
  it(
    "빈 DB로 기동해 스키마를 만들고 지정한 포트의 루프백에서 /health에 응답한다",
    async () => {
      const port = await freePort();
      // DB 파일은 작업 폴더 안에 두어 afterEach에서 함께 지운다
      const proc = startApp((dir) => ({
        DB_ENCRYPTION_KEY: "vitest-app-entry-only",
        DB_PATH: path.join(dir, "app-entry.db"),
        PORT: String(port),
      }));

      try {
        await waitFor(
          () => proc.output().includes(`Server running on port ${port}`),
          proc,
        );

        const res = await fetch(`http://127.0.0.1:${port}/health`);
        expect(res.status).toBe(200);
        expect((await res.json()).data).toMatchObject({
          status: "healthy",
          db: "ok",
        });
      } finally {
        // DB 파일 잠금이 풀린 뒤 폴더를 지우도록 종료를 기다린다
        child.kill();
        await proc.exited;
      }
    },
    BOOT_TIMEOUT_MS + 5000,
  );

  it(
    "DB_ENCRYPTION_KEY가 없으면 포트를 열지 않고 0이 아닌 종료 코드로 끝난다",
    async () => {
      const port = await freePort();
      const proc = startApp({ PORT: String(port) });

      const code = await proc.exited;

      expect(code).not.toBe(0);
      expect(proc.output()).toContain(
        "DB_ENCRYPTION_KEY 환경변수가 필요합니다.",
      );
      expect(proc.output()).not.toContain("Server running");
    },
    BOOT_TIMEOUT_MS + 5000,
  );
});
