#!/bin/bash
# DB 백업 cron 래퍼
# backup-db.js를 실행하고 성공/실패를 Healthchecks.io에 ping한다.
#
# backup-db.js의 오프사이트 전송은 best-effort라 실패해도 exit 0을 반환한다
# exit code만 보면 이 실패를 놓치므로, 출력 로그에 "오프사이트 전송 실패" 문구가
# 있는지도 함께 확인해야만 성공으로 ping한다.
#
# 예전엔 서버 로컬 파일(~/bin/backup-checked.sh)로만 존재했다. 저장소에 코드로
# 편입해 재현 가능하게 한다.
#
#
# 사용: backup-checked.sh <night|morning>
# crontab 예(서버 타임존 Asia/Seoul). rsync 배포가 실행 비트를 보존한다고 가정하지 않도록
# bash를 명시적으로 붙인다:
#   0 23 * * * bash /home/ubuntu/youtube-bias-feedback/server/scripts/backup-checked.sh night >> /home/ubuntu/db-backups/backup.log 2>&1
#   0 8  * * * bash /home/ubuntu/youtube-bias-feedback/server/scripts/backup-checked.sh morning >> /home/ubuntu/db-backups/backup.log 2>&1

set -uo pipefail

RUN_LABEL="${1:-}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# server/.env는 KEY=VALUE 순수 형식이라 bash에서 그대로 source할 수 있다
# (server/db.js 등 node 스크립트가 dotenv로 읽는 것과 같은 파일, 같은 값).
if [ -f "$REPO_DIR/server/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$REPO_DIR/server/.env"
  set +a
fi

case "$RUN_LABEL" in
  night) PING_URL="${DB_BACKUP_NIGHT_PING_URL:-}" ;;
  morning) PING_URL="${DB_BACKUP_MORNING_PING_URL:-}" ;;
  *)
    echo "[backup-checked] 사용법: backup-checked.sh <night|morning> — 알 수 없는 레이블 '$RUN_LABEL', ping을 건너뜁니다." >&2
    PING_URL=""
    ;;
esac

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd "$REPO_DIR" || exit 1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] backup 시작"
OUTPUT="$(node server/scripts/backup-db.js 2>&1)"
STATUS=$?
echo "$OUTPUT"

OK=true
if [ "$STATUS" -ne 0 ]; then
  OK=false
# grep -q로 파이프를 태우지 않는다.
elif [[ "$OUTPUT" == *"오프사이트 전송 실패"* ]]; then
  OK=false
fi

if [ -z "$PING_URL" ]; then
  echo "[backup-checked] ping URL이 없어 Healthchecks 알림을 건너뜁니다." >&2
elif [ "$OK" = true ]; then
  curl -fsS -m 10 --retry 3 "$PING_URL" -o /dev/null
else
  # 실패 로그 본문을 함께 보내 Healthchecks.io에서 원인을 바로 확인할 수 있게 한다.
  curl -fsS -m 10 --retry 3 --data-binary "$OUTPUT" "$PING_URL/fail" -o /dev/null
fi

exit "$STATUS"
