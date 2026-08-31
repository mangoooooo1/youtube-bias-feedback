// 모니터링 스크립트용 JSON 상태 파일 저장소
// cron으로 반복 실행되며 계속 갱신되는 운영 상태라 git pull/배포와 분리해야하므로 repo 밖에 둔다.
// 각 모니터가 사용하는 커서·쿨다운 상태를 이름별로 분리된 JSON 파일 하나씩에 담는다.

const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_STATE_DIR = path.join(os.homedir(), ".viewlens-monitoring");

function statePath(
  name,
  dir = process.env.MONITOR_STATE_DIR || DEFAULT_STATE_DIR,
) {
  return path.join(dir, `${name}.json`);
}

/** 상태 파일이 없거나(최초 실행) 손상됐으면 fallback을 반환한다 — 절대 예외를 던지지 않는다. */
function readState(name, fallback = {}, dir) {
  const file = statePath(name, dir);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(
        `[monitoring] 상태 파일 읽기 실패(${file}), 기본값 사용:`,
        err.message,
      );
    }
    return fallback;
  }
}

/** 임시 파일에 쓴 뒤 rename하는 원자적 교체 — 쓰다 중단돼도 기존 상태 파일이 손상되지 않는다. */
function writeState(name, data, dir) {
  const file = statePath(name, dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { statePath, readState, writeState, DEFAULT_STATE_DIR };
