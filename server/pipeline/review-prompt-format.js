// 오늘·기간 리뷰 프롬프트와 대체 문구가 함께 쓰는 입력 표기
//
// 두 리뷰가 같은 숫자·같은 제목 묶음 형식을 쓰게 해, 한쪽만 기준이 바뀌는 일을 막는다.
// 지침 문구는 리뷰마다 동결 버전이 따로 있어 각 파일에 둔다.

const percent = (ratio) => Math.round(ratio * 100);

/**
 * 시청 시간 비중(시청 시간이 확인되고 분야가 있는 유효 영상 기준, 화면 도넛과 같은 대상).
 * 비어 있으면(확인된 영상이 모두 분야를 못 가져옴) 리뷰는 "분석하지 못했다"로 간다.
 * @returns {{label: string, entries: Array<[string, number]>}} 비중 큰 순
 */
function shareBasis({ timeDistribution }) {
  return {
    label: "분야별 시청 시간 비중",
    entries: Object.entries(timeDistribution ?? {}).sort(
      ([, a], [, b]) => b - a,
    ),
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

/** 마지막 글자에 받침이 있는지(한글이 아니면 받침 없음으로 본다) */
function hasFinalConsonant(word) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 !== 0;
}

const josa = (word, withFinal, withoutFinal) =>
  `${word}${hasFinalConsonant(word) ? withFinal : withoutFinal}`;

/**
 * 대체 문구의 비중 문장(상위 3개). basis.entries가 비어 있지 않을 때만 부른다.
 * - 분야 하나: "시청 시간은 모두 음악이었어요."
 * - 여럿: "전체 시청 시간 중 음악이 62%로 가장 많았어요. 그다음은 게임 38%, 교육 15%였어요."
 * - 1·2위가 같으면: "전체 시청 시간 중 음악과 게임이 각각 50%로 가장 많았어요."
 */
function sharesSentence(basis) {
  const top = basis.entries
    .slice(0, 3)
    .map(([name, ratio]) => ({ name, percent: percent(ratio) }));
  if (top.length === 1) {
    return `시청 시간은 모두 ${josa(top[0].name, "이었어요", "였어요")}.`;
  }
  const tied = top[0].percent === top[1].percent;
  const first = tied
    ? `전체 시청 시간 중 ${josa(top[0].name, "과", "와")} ${josa(top[1].name, "이", "가")} 각각 ${top[0].percent}%로 가장 많았어요.`
    : `전체 시청 시간 중 ${josa(top[0].name, "이", "가")} ${top[0].percent}%로 가장 많았어요.`;
  const rest = top.slice(tied ? 2 : 1);
  return rest.length > 0
    ? `${first} 그다음은 ${rest.map((s) => `${s.name} ${s.percent}%`).join(", ")}였어요.`
    : first;
}

module.exports = {
  shareBasis,
  formatShares,
  formatTitleGroups,
  sharesSentence,
};
