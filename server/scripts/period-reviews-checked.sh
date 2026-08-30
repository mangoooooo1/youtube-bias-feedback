#!/bin/bash
# period_reviews 생성 cron 래퍼 — generate-period-reviews.js를 실행하고
# 성공/실패를 Healthchecks.io에 ping한다(데드맨스위치).
#
# 예전엔 서버 로컬 파일(~/bin/period-reviews-checked.sh)로만 존재했다. 저장소에
# 코드로 편입해 재현 가능하게 한다. Ping URL은 코드에 두지 않고 인자로 받는다.
#
# 사용: period-reviews-checked.sh <healthchecks_ping_url>
# crontab 예(서버 타임존 Asia/Seoul). rsync 배포가 실행 비트를 보존한다고 가정하지 않도록
# bash를 명시적으로 붙인다:
#   0 4 * * * bash /home/ubuntu/youtube-bias-feedback/server/scripts/period-reviews-checked.sh "https://hc-ping.com/xxxx" >> /home/ubuntu/period-reviews.log 2>&1

set -uo pipefail

PING_URL="${1:-}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# nvm으로 설치된 node를 cron(로그인 셸이 아님) 환경에서도 찾을 수 있게 한다.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd "$REPO_DIR" || exit 1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] period-reviews 시작"
node server/scripts/generate-period-reviews.js
STATUS=$?

if [ -z "$PING_URL" ]; then
  echo "[period-reviews-checked] ping URL이 없어 Healthchecks 알림을 건너뜁니다." >&2
elif [ "$STATUS" -eq 0 ]; then
  # 네트워크 오류로 무한 대기해 다음 cron까지 막지 않도록 타임아웃·재시도 횟수를 제한한다.
  curl -fsS -m 10 --retry 3 "$PING_URL" -o /dev/null
else
  curl -fsS -m 10 --retry 3 "$PING_URL/fail" -o /dev/null
fi

exit "$STATUS"
