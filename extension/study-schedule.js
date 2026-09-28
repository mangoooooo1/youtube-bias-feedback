// 참여 기간 종료 판정
(() => {
  const TOTAL_DAYS = 12;
  const END_GRACE_DAYS = 3;
  const DAY_MS = 86400000;

  function kstDayFromInstall(installDate, offsetDays) {
    const ms = new Date(installDate).getTime() + offsetDays * DAY_MS;
    return new Date(ms).toLocaleDateString("sv", { timeZone: "Asia/Seoul" });
  }

  /**
   * 수집은 서버의 마지막 기간이 끝나는 순간(마지막 기간 다음 날 00:00 KST)에 멈추고,
   * 그로부터 END_GRACE_DAYS 동안만 남은 데이터를 전송한다.
   * @param {string|undefined} installDate
   * @param {Date} [now]
   * @returns {"active"|"grace"|"ended"}
   */
  function getParticipationState(installDate, now = new Date()) {
    if (!installDate) return "active";
    const collectionEndsAt = Date.parse(
      `${kstDayFromInstall(installDate, TOTAL_DAYS)}T00:00:00+09:00`,
    );
    const nowMs = now.getTime();
    if (nowMs < collectionEndsAt) return "active";
    // KST는 서머타임이 없어 일수 × DAY_MS가 항상 같은 시각(00:00 KST)에 떨어진다
    if (nowMs < collectionEndsAt + END_GRACE_DAYS * DAY_MS) return "grace";
    return "ended";
  }

  globalThis.ViewLensStudy = Object.freeze({
    TOTAL_DAYS,
    END_GRACE_DAYS,
    getParticipationState,
  });
})();
