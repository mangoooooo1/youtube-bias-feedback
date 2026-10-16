// 오늘·기간 리뷰 프롬프트와 대체 문구가 함께 쓰는 입력 표기
//
// 두 리뷰가 같은 숫자·같은 제목 묶음 형식을 쓰게 해, 한쪽만 기준이 바뀌는 일을 막는다.
// 지침 문구는 리뷰마다 동결 버전이 따로 있어 각 파일에 둔다.

const percent = (ratio) => Math.round(ratio * 100);

/**
 * 시청 시간 비중을 쓰고, 유효 영상이 모두 시청 시간을 모르는 드문 경우에만 영상 개수 비중으로 대신한다.
 * @returns {{label: string, unit: string, entries: Array<[string, number]>}} 비중 큰 순
 */
function shareBasis({ timeDistribution, categoryDistribution }) {
  const hasTime =
    timeDistribution != null && Object.keys(timeDistribution).length > 0;
  const distribution = hasTime ? timeDistribution : categoryDistribution;
  return {
    label: hasTime ? "분야별 시청 시간 비중" : "분야별 영상 개수 비중",
    unit: hasTime ? "시청 시간은" : "영상 개수는",
    entries: Object.entries(distribution ?? {}).sort(([, a], [, b]) => b - a),
  };
}

/** 프롬프트의 "- 분야별 … 비중:" 항목 */
function formatShares(basis) {
  const lines = basis.entries
    .map(([name, ratio]) => `  · ${name}: ${percent(ratio)}%`)
    .join("\n");
  return `- ${basis.label}:\n${lines}`;
}

/** 프롬프트의 "분야별 영상 제목" 항목. 제목이 없으면 빈 문자열 */
function formatTitleGroups(titleGroups = []) {
  if (titleGroups.length === 0) return "";
  const blocks = titleGroups.map((g) => {
    const lines = g.titles.map(({ title, count }) =>
      count > 1 ? `  · ${title} (${count}번)` : `  · ${title}`,
    );
    if (g.omittedCount > 0) lines.push(`  · 이 외 ${g.omittedCount}개`);
    return [`  [${g.category}] 영상 ${g.videoCount}개`, ...lines].join("\n");
  });
  return `\n- 분야별 영상 제목 (시청 시간이 많은 분야부터, 최근 본 순서, 괄호는 본 횟수):\n${blocks.join("\n")}`;
}

/** 대체 문구의 사실 문장 꼬리 "시청 시간은 음악 50%, 게임 30%, 교육 15%" (상위 3개) */
function topSharesPhrase(basis) {
  return `${basis.unit} ${basis.entries
    .slice(0, 3)
    .map(([name, ratio]) => `${name} ${percent(ratio)}%`)
    .join(", ")}`;
}

module.exports = {
  shareBasis,
  formatShares,
  formatTitleGroups,
  topSharesPhrase,
};
