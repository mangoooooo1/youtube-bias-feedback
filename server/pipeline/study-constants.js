// 이 연구(ViewLens)의 기간 캘린더 상수

const TOTAL_DAYS = 12;
const DAYS_PER_PERIOD = 4;
const BASELINE_DAYS = 4;

// 시청이 적은 날·구간 기준. 단위는 유효 시청 영상 수.
const MIN_VALID_VIDEOS_PER_DAY = 2;
/** 구간 일수에 맞춘 "시청이 적은 구간" 기준(하루 평균 MIN_VALID_VIDEOS_PER_DAY개). */
function minValidVideosForPeriod(days) {
  return days * MIN_VALID_VIDEOS_PER_DAY;
}

// 하루치 리뷰에서 LLM으로 넘기는 영상 제목 상한(오늘 리뷰). 기간 리뷰는 구간 일수만큼 늘린다
const MAX_TITLES_PER_DAY = 100;
/** 기간 리뷰의 제목 상한 — 하루 상한 × 구간 일수 */
function maxTitlesForPeriod(days) {
  return days * MAX_TITLES_PER_DAY;
}

// 기간 리뷰가 fallback이면 구간 끝난 날로부터 이 일수 안에서 매일 다시 만든다.
// 팝업(viewlens-data.js)이 같은 값으로 캐시를 다시 조회할지 판단한다
const FALLBACK_RETRY_WINDOW_DAYS = 3;

module.exports = {
  TOTAL_DAYS,
  DAYS_PER_PERIOD,
  BASELINE_DAYS,
  MIN_VALID_VIDEOS_PER_DAY,
  minValidVideosForPeriod,
  MAX_TITLES_PER_DAY,
  maxTitlesForPeriod,
  FALLBACK_RETRY_WINDOW_DAYS,
};
