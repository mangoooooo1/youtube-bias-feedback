// "오늘" 탭 누적 리뷰의 근거 데이터 집계
//
// [의도적인 차이 — 참여자의 실제 "오늘"과 이 함수가 계산하는 "오늘"이 다를 수 있음]
// 원래 클라이언트 버전(extension/pipeline/analysis.js)은 new Date().toLocaleDateString("sv")를
// 시간대 지정 없이 호출해 "참여자 브라우저의 로컬 시간대" 자정을 기준으로 오늘을 나눴다.
// 서버는 참여자 브라우저의 시간대를 알 방법이 없으므로(전달받은 적이 없음), 이 파일은
// 서버의 다른 모든 기간 계산(period-boundaries.js의 kstDateStr, 화면 표시용 dateStr)과
// 동일하게 KST(Asia/Seoul) 고정 기준을 쓴다. 참여자 대부분이 KST권이라 실제 영향은
// 거의 없을 것으로 보이나, 자정 근처(KST 23:50~00:10 등)에 세션이 끝난 경우 "어느 날"로
// 집계되는지가 클라이언트 구버전과 갈릴 수 있다.
// (연구 무결성 점검 4번 항목 "시간대 처리 일관성"에서 별도로 다뤄야 할 사안.)
const { kstDateStr } = require("./period-boundaries");

function calculateEntropy(distribution) {
  const proportions = Object.values(distribution);
  if (proportions.length === 0) return 0;
  const H = -proportions.reduce(
    (sum, p) => (p > 0 ? sum + p * Math.log2(p) : sum),
    0,
  );
  return Math.round(H * 100) / 100 || 0;
}

// 서버 sessions 행에는 videos 배열이 없어(video_events로 분리 저장) videoCount만 본다.
function sessionVideoCount(session) {
  return session.videoCount ?? 1;
}

// videoCount 가중 평균으로 여러 세션의 categoryDistribution을 하나로 합친다.
// extension/pipeline/analysis.js의 mergeCategoryDistribution과 동일한 공식.
function mergeCategoryDistribution(sessions) {
  const totalVideos = sessions.reduce(
    (sum, s) => sum + sessionVideoCount(s),
    0,
  );
  if (totalVideos === 0) return {};

  const merged = {};
  for (const session of sessions) {
    const weight = sessionVideoCount(session) / totalVideos;
    for (const [cat, ratio] of Object.entries(session.categoryDistribution)) {
      merged[cat] = (merged[cat] ?? 0) + ratio * weight;
    }
  }
  for (const cat of Object.keys(merged)) {
    merged[cat] = Math.round(merged[cat] * 1000) / 1000;
  }
  return merged;
}

/**
 * @param {object} params
 * @param {Array}  params.sessions - [{ sessionId, endTime, categoryDistribution(파싱된 객체), videoCount }]
 * @param {Array}  params.titles   - [{ title, watchedAt }] (video_events 행)
 * @param {Date}   [params.now]    - 기준 시각(테스트용 주입, 기본값 현재 시각)
 * @returns {object|null} 오늘 세션이 하나도 없으면 null
 */
function aggregateTodayCumulative({ sessions, titles = [], now = new Date() }) {
  const today = kstDateStr(now);

  const analyzed = sessions.filter(
    (s) =>
      s.endTime &&
      s.categoryDistribution &&
      Object.keys(s.categoryDistribution).length > 0,
  );

  const todaySessions = analyzed.filter(
    (s) => kstDateStr(new Date(s.endTime)) === today,
  );
  if (todaySessions.length === 0) return null;

  const categoryDistribution = mergeCategoryDistribution(todaySessions);
  const entropy = calculateEntropy(categoryDistribution);
  const videoCount = todaySessions.reduce(
    (sum, s) => sum + sessionVideoCount(s),
    0,
  );
  const videoTitles = titles
    .filter((v) => v.watchedAt && kstDateStr(new Date(v.watchedAt)) === today)
    .map((v) => v.title)
    .filter(Boolean);
  const sessionIds = todaySessions.map((s) => s.sessionId);

  // "!==" 대신 "<"로 과거 날짜만 남긴다.
  const priorSessions = analyzed
    .filter((s) => kstDateStr(new Date(s.endTime)) < today)
    .sort((a, b) => new Date(b.endTime) - new Date(a.endTime));

  let prevEntropy = null;
  if (priorSessions.length > 0) {
    const prevDate = kstDateStr(new Date(priorSessions[0].endTime));
    const prevDaySessions = priorSessions.filter(
      (s) => kstDateStr(new Date(s.endTime)) === prevDate,
    );
    prevEntropy = calculateEntropy(mergeCategoryDistribution(prevDaySessions));
  }

  return {
    reviewDate: today,
    categoryDistribution,
    entropy,
    prevEntropy,
    videoCount,
    videoTitles,
    sessionCount: todaySessions.length,
    sessionIds,
  };
}

module.exports = { aggregateTodayCumulative };
