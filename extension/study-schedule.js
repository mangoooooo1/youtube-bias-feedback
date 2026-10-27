// 베이스라인·참여 기간 종료 판정
(() => {
  const TOTAL_DAYS = 12;
  // 실험 첫 4일은 그룹 무관하게 전원 피드백·알림을 받지 않는 베이스라인(첫 기간 전체)
  const BASELINE_DAYS = 4;
  const END_GRACE_DAYS = 3;
  const DAY_MS = 86400000;

  // 1구간과 같이 설치일(KST)부터 BASELINE_DAYS일째 24:00 KST까지가 베이스라인이다.
  // installDate가 없으면(온보딩 직후 등 비정상 상태) 안전하게 베이스라인으로 취급한다
  function isBaselinePeriod(installDate, now = new Date()) {
    if (!installDate) return true;
    // 손상된 설치일은 예전처럼 베이스라인이 아닌 것으로 본다(날짜 변환이 예외를 던지지 않게)
    if (!Number.isFinite(new Date(installDate).getTime())) return false;
    const today = now.toLocaleDateString("sv", { timeZone: "Asia/Seoul" });
    return today < kstDayFromInstall(installDate, BASELINE_DAYS);
  }

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
    // 없거나 손상된 설치일은 종료 신호로 보지 않는다 — NaN 비교가 전부 거짓이라 그대로 두면 ended가 된다
    if (!installDate || !Number.isFinite(new Date(installDate).getTime())) {
      return "active";
    }
    const collectionEndsAt = Date.parse(
      `${kstDayFromInstall(installDate, TOTAL_DAYS)}T00:00:00+09:00`,
    );
    const nowMs = now.getTime();
    if (nowMs < collectionEndsAt) return "active";
    // KST는 서머타임이 없어 일수 × DAY_MS가 항상 같은 시각(00:00 KST)에 떨어진다
    if (nowMs < collectionEndsAt + END_GRACE_DAYS * DAY_MS) return "grace";
    return "ended";
  }

  const ENDED_NOTICE = Object.freeze({
    title: "연구 참여 기간이 종료되었습니다.",
    body: "참여해 주셔서 감사합니다. 연구자가 보내드릴 설문 안내를 기다려 주세요.",
  });

  globalThis.ViewLensStudy = Object.freeze({
    TOTAL_DAYS,
    BASELINE_DAYS,
    END_GRACE_DAYS,
    isBaselinePeriod,
    ENDED_NOTICE,
    getParticipationState,
  });
})();
