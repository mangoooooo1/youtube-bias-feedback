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

// 리뷰 한 번에 LLM으로 넘기는 영상 제목 상한
const MAX_TITLES_PER_REVIEW = 100;

module.exports = {
  TOTAL_DAYS,
  DAYS_PER_PERIOD,
  BASELINE_DAYS,
  MIN_VALID_VIDEOS_PER_DAY,
  minValidVideosForPeriod,
  MAX_TITLES_PER_REVIEW,
};
