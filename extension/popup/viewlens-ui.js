// innerHTML로 렌더되는 문자열에 외부 입력(영상 제목·LLM 생성 텍스트)을 넣기 전 이스케이프.
// MV3 CSP가 인라인 스크립트 실행은 막지만, 마크업 주입으로 카드 위조·임의 링크 삽입은 가능하다.
function vlEscapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function vlCard({ children = "", pad = 16, soft = false, style = "" } = {}) {
  return `<div style="background:${soft ? "var(--vl-card-2)" : "var(--vl-card)"};border-radius:16px;box-shadow:var(--vl-shadow-card);padding:${pad}px;${style}">${children}</div>`;
}

function vlSectionLabel({ text = "", right = "" } = {}) {
  return `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
    <span style=";font-size:var(--vl-fs-2);font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:var(--vl-ink-3);white-space:nowrap">${text}</span>
    ${right}
  </div>`;
}

function vlBadge({ text = "", tone = "accent", size = "md" } = {}) {
  const styles = {
    accent: "background:var(--vl-accent-soft);color:var(--vl-accent)",
    good: "background:color-mix(in oklab,var(--vl-good) 16%,transparent);color:var(--vl-good)",
    warn: "background:color-mix(in oklab,var(--vl-warn) 18%,transparent);color:var(--vl-warn)",
    neutral: "background:var(--vl-card-2);color:var(--vl-ink-2)",
  };
  const s = styles[tone] || styles.accent;
  const sm = size === "sm";
  return `<span style="display:inline-flex;align-items:center;gap:5px;${s};border-radius:999px;padding:${sm ? "2px 8px" : "4px 10px"};font-size:${sm ? 11 : 12}px;font-weight:700;line-height:1.2;white-space:nowrap">${text}</span>`;
}

// showValue:false: entropy 원값은 "얼마나 커야 좋은지" 기준을 알 수 없는 임의 숫자라
// (다양성 등급 라벨과 함께 쓸 땐) 화살표+색으로만 방향을 보여주고 숫자는 감춘다.
function vlDeltaChip({
  value = 0,
  unit = "",
  invertColor = false,
  showValue = true,
} = {}) {
  const up = value >= 0;
  const good = invertColor ? !up : up;
  const col =
    value === 0
      ? "var(--vl-ink-2)"
      : good
        ? "var(--vl-good)"
        : "var(--vl-warn)";
  const arrow = value === 0 ? "·" : up ? "▲" : "▼";
  const valueText = showValue
    ? `${up ? "+" : ""}${value.toFixed(2)}${unit}`
    : "";
  return `<span style="display:inline-flex;align-items:center;gap:4px;color:${col};;font-weight:600;font-size:var(--vl-fs-3)">
    <span style="font-size:var(--vl-fs-1)">${arrow}</span>${valueText}
  </span>`;
}

function vlBarChart({ data = [], maxVal, animate = true } = {}) {
  const top = maxVal || Math.max(...data.map((d) => d.p));
  return `<div style="display:flex;flex-direction:column;gap:11px">
    ${data
      .map(
        (d) => `
      <div style="display:flex;align-items:center;gap:10px">
        <span style="width:8px;height:8px;border-radius:3px;background:${d.color};flex-shrink:0"></span>
        <span style="width:86px;font-size:var(--vl-fs-3);color:var(--vl-ink);font-weight:500;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${d.name}</span>
        <div style="flex:1;height:8px;background:var(--vl-line);border-radius:999px;overflow:hidden">
          <div style="width:${(d.p / top) * 100}%;height:100%;background:${d.color};border-radius:999px;${animate ? "transition:width .7s cubic-bezier(.2,.8,.2,1)" : ""}"></div>
        </div>
        <span style="width:34px;text-align:right;;font-size:var(--vl-fs-3);color:var(--vl-ink-2);flex-shrink:0">${Math.round(d.p * 100)}%</span>
      </div>
    `,
      )
      .join("")}
  </div>`;
}

/**
 * 카테고리 비율을 하나의 막대에 이어붙인 100% 스택 바(도넛과 다른 시각 언어로 비율을
 * 보여준다). 도넛과 같은 방식으로 자기 비율만큼 delay를 줘 왼쪽부터 차례로 자라난다
 * (flex가 최종 폭을 이미 정하므로 width 대신 scaleX(0)→scaleX(1)을 애니메이션한다).
 * @param {object} opts
 * @param {{name: string, p: number, color: string}[]} opts.data
 * @param {number} [opts.drawMs] - 전체 draw-in 재생 시간(ms)
 * @returns {string} HTML
 */
function vlStackedBar({ data = [], drawMs = 900 } = {}) {
  let acc = 0;
  const segments = data
    .map((d) => {
      const delayMs = Math.round(acc * drawMs);
      const durMs = Math.max(60, Math.round(d.p * drawMs));
      acc += d.p;
      return `<div class="vl-stack-seg" style="flex:${Math.max(d.p, 0.001)} 0 0%;background:${d.color};min-width:2px;transform:scaleX(0);transform-origin:left;transition:transform ${durMs}ms linear ${delayMs}ms" title="${d.name} ${Math.round(d.p * 100)}%"></div>`;
    })
    .join("");
  // 항상 다 보여야 해서(호버 뒤에 숨기지 않음) 줄바꿈으로 세로 공간을 줄인다. 배지 대신
  // 점+텍스트로 가볍게 — 이름은 진하게, %는 옅게 둬서 카테고리명이 먼저 읽히게 한다.
  const legend = data
    .map(
      (d) => `
    <span style="display:inline-flex;align-items:center;gap:6px">
      <span style="width:6px;height:6px;border-radius:50%;background:${d.color};flex-shrink:0"></span>
      <span style="font-size:var(--vl-fs-2);color:var(--vl-ink);font-weight:600;white-space:nowrap">${d.name}</span>
      <span style="font-size:var(--vl-fs-1);color:var(--vl-ink-3);white-space:nowrap">${Math.round(d.p * 100)}%</span>
    </span>`,
    )
    .join("");
  return `<div style="display:flex;flex-direction:column;gap:12px">
    <div style="display:flex;width:100%;height:16px;border-radius:8px;overflow:hidden">${segments}</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px 14px">${legend}</div>
  </div>`;
}

// render()가 매번 innerHTML을 통째로 교체해 이 원도 매번 새로 마운트된다.
// 그 점을 이용해 0으로 그렸다가 다음 프레임에 실제 값(data-final-dash)으로 바꿔 transition이
// 재생되게 한다(더블 rAF는 render()에서 처리). screenToday()의 카테고리 범례가 같은 타이밍으로
// 나타나야 해서 재생 시간을 상수로 공유한다.
const VL_DONUT_DRAW_MS = 900;

/**
 * 도넛 차트. 각 조각이 앞 조각들 몫만큼 delay 후 자기 비율만큼만 그려져, 하나의 선이
 * 링을 따라 죽 그어지듯 순차 애니메이션된다(_animateCharts가 트리거).
 * @param {object} opts
 * @param {{name: string, p: number, color: string}[]} opts.data
 * @param {number} [opts.size]
 * @param {number} [opts.thickness]
 * @param {number} [opts.drawMs]
 * @returns {string} HTML
 */
function vlDonut({
  data = [],
  size = 128,
  thickness = 18,
  drawMs = VL_DONUT_DRAW_MS,
} = {}) {
  const r = (size - thickness) / 2;
  const cx = size / 2,
    cy = size / 2;
  const C = 2 * Math.PI * r;
  const gap = 2;
  let acc = 0;
  const top = data[0] || { p: 0, name: "" };
  const segments = data
    .map((d) => {
      const seg = d.p * C;
      const finalDash = `${Math.max(0, seg - gap)} ${C - Math.max(0, seg - gap)}`;
      // 앞 조각이 차지한 비율만큼 delay를 주고, 재생 시간도 자기 비율만큼만 배정해
      // 전체 합이 drawMs가 되게 한다(선형 스윕처럼 보이도록 linear 사용).
      const delayMs = Math.round(acc * drawMs);
      const segDurMs = Math.max(60, Math.round(d.p * drawMs));
      const html = `<circle class="vl-donut-seg" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${d.color}"
      stroke-width="${thickness}"
      stroke-dasharray="0 ${C}"
      data-final-dash="${finalDash}"
      stroke-dashoffset="${-acc * C}"
      style="transition:stroke-dasharray ${segDurMs}ms linear ${delayMs}ms"/>`;
      acc += d.p;
      return html;
    })
    .join("");
  return `<div style="position:relative;width:${size}px;height:${size}px;flex-shrink:0">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <g transform="rotate(-90 ${cx} ${cy})">${segments}</g>
    </svg>
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
      <span class="vl-donut-count" data-target="${Math.round(top.p * 100)}" style=";font-weight:700;font-size:var(--vl-fs-6);color:var(--vl-ink);line-height:1">0%</span>
      <span style="font-size:var(--vl-fs-2);color:var(--vl-ink-3);margin-top:3px;font-weight:600">${top.name}</span>
    </div>
  </div>`;
}

/**
 * 추이 꺾은선 차트. y축 기준선(bands)과 점별 호버 툴팁을 지원한다.
 * @param {object} opts
 * @param {number[]} opts.data
 * @param {string[]} [opts.labels] - 점 아래 x축 라벨(기간 이름)
 * @param {{boundaries: number[], labels: string[]}} [opts.bands] - y축 등급 경계선.
 *   boundaries는 오름차순[b1,b2], labels는 위 등급부터("다양","보통","편중")
 * @param {string[]} [opts.tooltips] - 점마다 호버 시 보여줄 문구(data와 같은 순서).
 *   SVG엔 ::after가 안정적으로 안 붙어 좌표만 맞춘 투명 span을 얹는 방식으로 구현한다
 * @param {number} [opts.height]
 * @returns {string} HTML
 */
function vlMiniLine({
  data = [],
  labels = [],
  bands = null,
  tooltips = [],
  height = 64,
} = {}) {
  const W = 300,
    H = height,
    padLeft = bands ? 24 : 10,
    padRight = 10,
    padTop = 6,
    padBottom = labels.length > 0 ? 20 : 6;
  const plotH = H - padTop - padBottom;
  const boundaries = bands?.boundaries || [];
  const allVals = [...data, ...boundaries];
  const lo = Math.min(...allVals) - 0.25;
  const hi = Math.max(...allVals) + 0.25;
  const x = (i) =>
    padLeft + (i * (W - padLeft - padRight)) / (data.length - 1 || 1);
  const y = (v) => padTop + plotH - ((v - lo) / (hi - lo)) * plotH;
  const pts = data.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${padLeft},${padTop + plotH} ${pts} ${W - padRight},${padTop + plotH}`;
  // 점마다 은은하게 퍼지는 핑 원을 하나씩 더 깔아 "살아있는 추이"처럼 보이게 한다
  // (vlDotPing, viewlens-tokens.css).
  const dots = data
    .map(
      (v, i) => `
      <circle cx="${x(i)}" cy="${y(v)}" r="2.6" fill="var(--vl-accent)" class="vl-dot-ping"/>
      <circle cx="${x(i)}" cy="${y(v)}" r="2.6" fill="var(--vl-accent)"/>`,
    )
    .join("");
  // 추이 선 draw-in: dasharray를 직접 애니메이션하면 다 그려질 때까지 실선처럼 보인다.
  // 대신 고정된 점선은 그대로 두고 그 위에 마스크를 씌워, 마스크 폴리라인의
  // dashoffset만 트랜지션시켜 점선이 왼쪽부터 드러나게 한다.
  const maskId = `vlLineMask${Math.round(Math.random() * 1e9)}`;
  const ptCoords = data.map((v, i) => [x(i), y(v)]);
  const polyLen = ptCoords
    .slice(1)
    .reduce(
      (sum, [px, py], i) =>
        sum + Math.hypot(px - ptCoords[i][0], py - ptCoords[i][1]),
      0,
    );
  const finalLineDash = "3 2.5";
  const lineStrokeWidth = 1.75;
  // 추이 선(실제 데이터)은 점선, 기준선들(등급 경계)은 실선 —
  // "지금 변하고 있는 값"과 "고정된 기준"을 선 스타일로도 구분한다.
  const zoneLines = bands
    ? boundaries
        .map(
          (v) =>
            `<line x1="${padLeft}" y1="${y(v)}" x2="${W - padRight}" y2="${y(v)}" stroke="var(--vl-line)" stroke-width="1"/>`,
        )
        .join("")
    : "";
  const zoneLabels =
    bands && bands.labels
      ? (() => {
          // edges: 위(hi)→아래(lo) 순으로, bands.labels도 같은 순서(위 등급부터)여야 한다.
          // boundaries는 오름차순[b1,b2]으로 들어오므로 뒤집어서 내림차순으로 맞춘다.
          const edges = [hi, ...[...boundaries].reverse(), lo];
          return bands.labels
            .map((label, i) => {
              const midY = (y(edges[i]) + y(edges[i + 1])) / 2;
              return `<text x="2" y="${midY + 3}" font-size="8.5" fill="var(--vl-ink-3)">${vlEscapeHtml(label)}</text>`;
            })
            .join("");
        })()
      : "";
  const xLabels = labels
    .map(
      (l, i) =>
        `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="var(--vl-ink-3)">${vlEscapeHtml(l)}</text>`,
    )
    .join("");
  // 오른쪽 절반의 점은 툴팁을 왼쪽으로 펼친다(.vl-tip-right, 카드 밖 잘림 방지).
  // 호버 시 halo로 커서 위치를 보여준다(.vl-chart-hit, viewlens-tokens.css).
  const hitAreas = data
    .map((v, i) => {
      if (!tooltips[i]) return "";
      const leftPct = (x(i) / W) * 100;
      const rightSide = x(i) > W / 2 ? " vl-tip-right" : "";
      return `<span class="vl-tip vl-chart-hit${rightSide}" data-tip="${tooltips[i]}"
        style="position:absolute;left:${leftPct}%;top:${y(v)}px;width:20px;height:20px;transform:translate(-50%,-50%);cursor:default"></span>`;
    })
    .join("");
  return `<div style="position:relative">
    <svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block;height:${height}px" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="vlFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--vl-accent)" stop-opacity="0.20"/>
          <stop offset="100%" stop-color="var(--vl-accent)" stop-opacity="0"/>
        </linearGradient>
        <mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">
          <polyline class="vl-trend-line-mask" points="${pts}" fill="none" stroke="#fff" stroke-width="${lineStrokeWidth + 3}" stroke-linejoin="round" stroke-linecap="round"
            stroke-dasharray="${polyLen} ${polyLen}" stroke-dashoffset="${polyLen}"
            style="transition:stroke-dashoffset .9s ease-out"/>
        </mask>
      </defs>
      ${zoneLines}
      <polygon points="${area}" fill="url(#vlFill)"/>
      <polyline class="vl-trend-line" points="${pts}" fill="none" stroke="var(--vl-accent)" stroke-width="${lineStrokeWidth}" stroke-linejoin="round" stroke-linecap="round"
        stroke-dasharray="${finalLineDash}" mask="url(#${maskId})"/>
      ${dots}
      ${zoneLabels}
      ${xLabels}
    </svg>
    ${hitAreas}
  </div>`;
}

/**
 * 리뷰 카드(오늘/누적 공용). 잠금 시 블러 처리하고 확인 버튼으로 해제한다.
 * @param {object} opts
 * @param {string} opts.text
 * @param {string} [opts.topic]
 * @param {string} [opts.title]
 * @param {{videoId?: string, title: string}[]} [opts.videos] - 10개 넘으면 페이지네이션
 * @param {string} [opts.videoListLabel]
 * @param {number|null} [opts.totalCount] - 실제 전체 영상 수. 제목 미기록 세션이 섞이면
 *   videos.length보다 클 수 있어 그럴 땐 "9/31개"처럼 전체 대비로 보여준다
 * @param {boolean} [opts.locked]
 * @param {string|null} [opts.sessionId]
 * @param {string} [opts.id] - 같은 화면에 여러 카드가 동시에 렌더될 때 DOM id 충돌 방지용
 * @returns {string} HTML
 */
function vlReview({
  text = "",
  topic = "",
  title = "오늘 돌아보기",
  videos = [],
  videoListLabel = "분석한 영상",
  totalCount = null,
  locked = false,
  sessionId = null,
  id = "vl-review-card",
} = {}) {
  // 영상별 실제 카테고리를 몰라서(세션 단위로만 근사) 색 점을 찍으면 같은 세션 안의
  // 무관한 영상까지 엉뚱한 색으로 보여 오해를 준다. 그래서 색 표시는 아예 뺀다.
  const videoRow = (v) => {
    const ytUrl = v.videoId
      ? `https://www.youtube.com/watch?v=${encodeURIComponent(v.videoId)}`
      : null;
    const label = `<span style="font-size:var(--vl-fs-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">${vlEscapeHtml(v.title)}</span>`;
    const base = `display:flex;align-items:center;min-width:0`;
    return ytUrl
      ? `<a href="${ytUrl}" target="_blank" rel="noopener" class="vl-vid-link"
        style="${base};text-decoration:none;color:var(--vl-ink);padding:3px 4px;border-radius:6px"
      >${label}</a>`
      : `<div style="${base};padding:3px 4px">${label}</div>`;
  };

  const topicBlock = topic
    ? `<p style="margin:0 0 10px;font-size:var(--vl-fs-5);font-weight:800;color:var(--vl-ink);line-height:1.4;letter-spacing:-0.02em;text-wrap:pretty">
        당신은 '<span style="color:var(--vl-accent)">${vlEscapeHtml(topic)}</span>'에 관심이 많습니다!
      </p>`
    : "";

  // 10개 넘으면 <details> 안에서 계속 스크롤하는 대신 10개씩 페이지로 나눠 가로로
  // 넘겨보게 한다(scroll-snap). 10개 이하면 화살표·페이지 표시 없이 세로 목록만 보여준다.
  // 넘기기·페이지 번호 갱신은 _bind()(viewlens-app.js)가 .vl-vid-pager를 찾아 건다.
  const PAGE_SIZE = 10;
  const pageCount = Math.ceil(videos.length / PAGE_SIZE);
  const videoListBody =
    pageCount <= 1
      ? `<div style="margin-top:9px;display:flex;flex-direction:column;gap:2px">${videos.map(videoRow).join("")}</div>`
      : `<div class="vl-vid-pager" data-pages="${pageCount}">
      <div class="vl-vid-scroll" style="display:flex;overflow-x:auto;scroll-snap-type:x mandatory;margin-top:9px">
        ${Array.from({ length: pageCount }, (_, p) => {
          const pageVideos = videos.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
          return `<div style="flex:0 0 100%;min-width:0;scroll-snap-align:start;display:flex;flex-direction:column;gap:2px">${pageVideos.map(videoRow).join("")}</div>`;
        }).join("")}
      </div>
      <div style="display:flex;align-items:center;justify-content:center;gap:14px;margin-top:6px">
        <button type="button" class="vl-vid-prev vl-press" aria-label="이전 페이지" style="border:none;background:transparent;color:var(--vl-ink-3);font-size:var(--vl-fs-3);cursor:pointer;padding:4px 6px;border-radius:6px">‹</button>
        <span class="vl-vid-page-label" style="font-size:var(--vl-fs-2);color:var(--vl-ink-3);min-width:32px;text-align:center">1/${pageCount}</span>
        <button type="button" class="vl-vid-next vl-press" aria-label="다음 페이지" style="border:none;background:transparent;color:var(--vl-ink-3);font-size:var(--vl-fs-3);cursor:pointer;padding:4px 6px;border-radius:6px">›</button>
      </div>
    </div>`;

  const videoList =
    videos.length > 0
      ? `
    <details class="vl-vid-details" style="margin-top:13px;padding-top:12px;border-top:1px solid color-mix(in oklab,var(--vl-accent) 18%,transparent)">
      <summary style="display:flex;align-items:center;justify-content:space-between;padding:2px 0;border-radius:6px;user-select:none">
        <span style="display:flex;align-items:center;gap:5px;font-size:var(--vl-fs-2);font-weight:600;color:var(--vl-accent)">
          <span class="vl-vid-chevron" style="font-size:var(--vl-fs-1);line-height:1">▸</span>
          ${videoListLabel}
        </span>
        <span style="font-size:var(--vl-fs-2);;color:var(--vl-ink-3)">${totalCount != null && totalCount > videos.length ? `${videos.length}/${totalCount}개` : `${videos.length}개`}</span>
      </summary>
      ${videoListBody}
    </details>
  `
      : "";

  // "피드백 확인하기"로 블러를 해제하기 전까지는 내용을 실제로 읽을 수 없게 만든다
  //  backdrop-filter 미지원 환경에서도 filter:blur만으로 판독 불가능하도록 이중 처리).
  const revealOverlay = locked
    ? `<div style="position:absolute;inset:0;border-radius:16px;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);background:color-mix(in oklab,var(--vl-accent-soft) 60%,transparent)">
        <button id="vl-feedback-confirm-btn" class="vl-press" data-session-id="${sessionId ?? ""}" style="display:flex;align-items:center;gap:7px;padding:11px 20px;border:none;border-radius:999px;background:var(--vl-card);color:var(--vl-accent);font-size:var(--vl-fs-3);font-weight:700;cursor:pointer;animation:vlGlow 2.4s ease-in-out infinite">
          ${markSVG({ size: 15, filled: false, accent: "var(--vl-accent)" })}
          피드백 확인하기
        </button>
      </div>`
    : "";

  return `<div id="${id}" style="position:relative;overflow:hidden;background:var(--vl-accent-soft);border-radius:16px;box-shadow:0 1px 3px color-mix(in oklab,var(--vl-accent) 10%,transparent),0 1px 2px rgba(0,0,0,.03);padding:15px">
    <div style="${locked ? "filter:blur(6px);user-select:none;pointer-events:none" : ""}">
      <div style="display:flex;align-items:center;gap:7px;margin-bottom:9px">
        ${markSVG({ size: 18, filled: false, accent: "var(--vl-accent)" })}
        <span style="font-size:var(--vl-fs-3);font-weight:700;color:var(--vl-accent)">${title}</span>
      </div>
      ${topicBlock}
      <p style="margin:0;font-size:var(--vl-fs-3);line-height:1.65;color:var(--vl-ink);text-wrap:pretty">${vlEscapeHtml(text)}</p>
      ${videoList}
    </div>
    ${revealOverlay}
  </div>`;
}

// 확인/취소형 팝업(모달) — 연구 종료 안내처럼 "동의하면 진행" 흐름과, 에러 상황의
// 단순 확인 알림(cancelLabel 생략 시 버튼 1개)에 공통으로 쓴다. 버튼 id는 호출부가
// 직접 정해서 넘기고, 클릭 바인딩은 호출부(각 화면의 _bind)에서 그 id로 건다.
function vlConfirmModal({
  icon = "",
  title = "",
  message = "",
  confirmLabel = "확인",
  confirmId = "",
  cancelLabel = "",
  cancelId = "",
} = {}) {
  return `<div style="position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in oklab,var(--vl-ink) 45%,transparent)">
    <div style="width:100%;background:var(--vl-card);border-radius:18px;padding:26px 22px 22px;box-shadow:0 24px 60px -12px rgba(0,0,0,.4);text-align:center">
      ${
        icon
          ? `<div style="width:52px;height:52px;margin:0 auto;border-radius:50%;background:var(--vl-accent-soft);display:grid;place-items:center">${icon}</div>`
          : ""
      }
      <div style="margin-top:${icon ? 16 : 0}px;font-size:var(--vl-fs-5);font-weight:800;color:var(--vl-ink);letter-spacing:-0.02em">${title}</div>
      <p style="margin:9px 0 0;font-size:var(--vl-fs-3);line-height:1.6;color:var(--vl-ink-2);text-wrap:pretty">${message}</p>
      <div style="margin-top:20px;display:flex;flex-direction:column;gap:8px">
        <button id="${confirmId}" class="vl-press" style="padding:13px;border:none;border-radius:13px;background:var(--vl-accent);color:var(--vl-on-accent);font-size:var(--vl-fs-4);font-weight:700;cursor:pointer;font-family:inherit">${confirmLabel}</button>
        ${
          cancelLabel
            ? `<button id="${cancelId}" class="vl-press" style="padding:12px;border:none;border-radius:13px;background:transparent;color:var(--vl-ink-3);font-size:var(--vl-fs-3);font-weight:600;cursor:pointer;font-family:inherit">${cancelLabel}</button>`
            : ""
        }
      </div>
    </div>
  </div>`;
}

window.vlCard = vlCard;
window.vlSectionLabel = vlSectionLabel;
window.vlBadge = vlBadge;
window.vlDeltaChip = vlDeltaChip;
window.vlBarChart = vlBarChart;
window.vlStackedBar = vlStackedBar;
window.vlDonut = vlDonut;
window.VL_DONUT_DRAW_MS = VL_DONUT_DRAW_MS;
window.vlMiniLine = vlMiniLine;
window.vlReview = vlReview;
window.vlConfirmModal = vlConfirmModal;
