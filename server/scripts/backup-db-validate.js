// offsitePush 오프사이트 백업의 원격 쉘 명령(mkdir/find) 인자 검증.
// remoteDir/remoteRetention은 execFileSync로 원격 쉘 명령 문자열에 그대로 삽입되므로,
// 쉘 메타문자·공백 유입이나 비정상 정수값이 원격에서 의도치 않은 실행/구문 오류로
// 이어지지 않도록 막는다. (실패해도 로컬 백업은 이미 성공했으므로 best-effort로 건너뜀)

function isValidRemoteDir(remoteDir) {
  return /^[a-zA-Z0-9_/-]+$/.test(remoteDir);
}

function isValidRemoteRetention(remoteRetention) {
  return Number.isInteger(remoteRetention) && remoteRetention >= 0;
}

module.exports = { isValidRemoteDir, isValidRemoteRetention };
