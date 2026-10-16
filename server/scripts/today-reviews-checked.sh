#!/bin/bash
# 지난 날짜 오늘 리뷰 마감 생성 cron 래퍼 — generate-daily-today-reviews.js를 실행하고
# 성공/실패를 Healthchecks.io에 ping한다(데드맨스위치). period-reviews-checked.sh와 같은 구조.
#
# 사용: today-reviews-checked.sh
# crontab 예(서버 타임존 Asia/Seoul). 자정 직전까지 보던 세션이 끝나고(마지막 시청 10분 뒤)
# 시청 시간 기록이 늦게 도착할 여유를 두고 00:30에 실행한다. rsync 배포가 실행 비트를 보존한다고
# 가정하지 않도록 bash를 명시적으로 붙인다:
#   30 0 * * * bash /home/ubuntu/youtube-bias-feedback/server/scripts/today-reviews-checked.sh >> /home/ubuntu/today-reviews.log 2>&1

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ -f "$REPO_DIR/server/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$REPO_DIR/server/.env"
  set +a
fi
PING_URL="${TODAY_REVIEWS_PING_URL:-}"

# nvm으로 설치된 node를 cron(로그인 셸이 아님) 환경에서도 찾을 수 있게 한다.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd "$REPO_DIR" || exit 1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] today-reviews 시작"
node server/scripts/generate-daily-today-reviews.js
STATUS=$?

if [ -z "$PING_URL" ]; then
  echo "[today-reviews-checked] ping URL이 없어 Healthchecks 알림을 건너뜁니다." >&2
elif [ "$STATUS" -eq 0 ]; then
  # 네트워크 오류로 무한 대기해 다음 cron까지 막지 않도록 타임아웃·재시도 횟수를 제한한다.
  curl -fsS -m 10 --retry 3 "$PING_URL" -o /dev/null
else
  curl -fsS -m 10 --retry 3 "$PING_URL/fail" -o /dev/null
fi

exit "$STATUS"
