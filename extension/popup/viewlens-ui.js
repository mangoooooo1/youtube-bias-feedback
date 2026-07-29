function vlCard({ children = "", pad = 16, soft = false, style = "" } = {}) {
  return `<div style="background:${soft ? "var(--vl-card-2)" : "var(--vl-card)"};border:1px solid var(--vl-line);border-radius:16px;padding:${pad}px;${style}">${children}</div>`;
}

function vlSectionLabel({ text = "", right = "" } = {}) {
  return `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
    <span style=";font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:var(--vl-ink-3);white-space:nowrap">${text}</span>
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

function vlDeltaChip({ value = 0, unit = "", invertColor = false } = {}) {
  const up = value >= 0;
  const good = invertColor ? !up : up;
  const col =
    value === 0
      ? "var(--vl-ink-2)"
      : good
        ? "var(--vl-good)"
        : "var(--vl-warn)";
  const arrow = value === 0 ? "·" : up ? "▲" : "▼";
  return `<span style="display:inline-flex;align-items:center;gap:4px;color:${col};;font-weight:600;font-size:12px">
    <span style="font-size:9px">${arrow}</span>${up ? "+" : ""}${value.toFixed(2)}${unit}
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
        <span style="width:86px;font-size:12.5px;color:var(--vl-ink);font-weight:500;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${d.name}</span>
        <div style="flex:1;height:8px;background:var(--vl-line);border-radius:999px;overflow:hidden">
          <div style="width:${(d.p / top) * 100}%;height:100%;background:${d.color};border-radius:999px;${animate ? "transition:width .7s cubic-bezier(.2,.8,.2,1)" : ""}"></div>
        </div>
        <span style="width:34px;text-align:right;;font-size:12px;color:var(--vl-ink-2);flex-shrink:0">${Math.round(d.p * 100)}%</span>
      </div>
    `,
      )
      .join("")}
  </div>`;
}

function vlDonut({ data = [], size = 128, thickness = 18 } = {}) {
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
      const html = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${d.color}"
      stroke-width="${thickness}"
      stroke-dasharray="${Math.max(0, seg - gap)} ${C - Math.max(0, seg - gap)}"
      stroke-dashoffset="${-acc * C}"
      style="transition:stroke-dasharray .7s cubic-bezier(.2,.8,.2,1)"/>`;
      acc += d.p;
      return html;
    })
    .join("");
  return `<div style="position:relative;width:${size}px;height:${size}px;flex-shrink:0">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--vl-line)" stroke-width="${thickness}"/>
      <g transform="rotate(-90 ${cx} ${cy})">${segments}</g>
    </svg>
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
      <span style=";font-weight:700;font-size:22px;color:var(--vl-ink);line-height:1">${Math.round(top.p * 100)}%</span>
      <span style="font-size:10.5px;color:var(--vl-ink-3);margin-top:3px;font-weight:600">${top.name}</span>
    </div>
  </div>`;
}

function vlMiniLine({ data = [], baseline = null, height = 64 } = {}) {
  const W = 300,
    H = height,
    pad = 6;
  const vals = baseline != null ? [...data, baseline] : data;
  const lo = Math.min(...vals) - 0.25;
  const hi = Math.max(...vals) + 0.25;
  const x = (i) => pad + (i * (W - pad * 2)) / (data.length - 1);
  const y = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - pad * 2);
  const pts = data.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${pad},${H - pad} ${pts} ${W - pad},${H - pad}`;
  const dots = data
    .map(
      (v, i) =>
        `<circle cx="${x(i)}" cy="${y(v)}" r="2.6" fill="var(--vl-card)" stroke="var(--vl-accent)" stroke-width="2"/>`,
    )
    .join("");
  const baseLine =
    baseline != null
      ? `<line x1="${pad}" y1="${y(baseline)}" x2="${W - pad}" y2="${y(baseline)}" stroke="var(--vl-ink-3)" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>`
      : "";
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block;height:${height}px" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="vlFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--vl-accent)" stop-opacity="0.20"/>
        <stop offset="100%" stop-color="var(--vl-accent)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${baseLine}
    <polygon points="${area}" fill="url(#vlFill)"/>
    <polyline points="${pts}" fill="none" stroke="var(--vl-accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  </svg>`;
}

function vlReview({
  text = "",
  topic = "",
  title = "오늘 돌아보기",
  videos = [],
  locked = false,
  sessionId = null,
} = {}) {
  const cats = VL.CATS;

  const topicBlock = topic
    ? `<p style="margin:0 0 10px;font-size:17px;font-weight:800;color:var(--vl-ink);line-height:1.4;letter-spacing:-0.02em;text-wrap:pretty">
        당신은 '<span style="color:var(--vl-accent)">${topic}</span>'에 관심이 많습니다!
      </p>`
    : "";

  const videoList =
    videos.length > 0
      ? `
    <details class="vl-vid-details" style="margin-top:13px;padding-top:12px;border-top:1px solid color-mix(in oklab,var(--vl-accent) 18%,transparent)">
      <summary style="display:flex;align-items:center;justify-content:space-between;padding:2px 0;border-radius:6px;user-select:none">
        <span style="display:flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;color:var(--vl-accent)">
          <span class="vl-vid-chevron" style="font-size:9px;line-height:1">▸</span>
          분석한 영상
        </span>
        <span style="font-size:11px;;color:var(--vl-ink-3)">${videos.length}개</span>
      </summary>
      <div style="margin-top:9px;display:flex;flex-direction:column;gap:6px">
        ${videos
          .map((v) => {
            const color = (cats[v.cat] || {}).color || "var(--vl-ink-3)";
            const ytUrl = v.videoId
              ? `https://www.youtube.com/watch?v=${encodeURIComponent(v.videoId)}`
              : null;
            const dot = `<span style="width:7px;height:7px;border-radius:2.5px;background:${color};flex-shrink:0"></span>`;
            const label = `<span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">${v.title}</span>`;
            const base = `display:flex;align-items:center;gap:8px;min-width:0`;
            return ytUrl
              ? `<a href="${ytUrl}" target="_blank" rel="noopener" class="vl-vid-link"
                style="${base};text-decoration:none;color:var(--vl-ink);padding:3px 4px;border-radius:6px"
              >${dot}${label}</a>`
              : `<div style="${base};padding:3px 4px">${dot}${label}</div>`;
          })
          .join("")}
      </div>
    </details>
  `
      : "";

  // "피드백 확인하기"로 블러를 해제하기 전까지는 내용을 실제로 읽을 수 없게 만든다
  //  backdrop-filter 미지원 환경에서도 filter:blur만으로 판독 불가능하도록 이중 처리).
  const revealOverlay = locked
    ? `<div style="position:absolute;inset:0;border-radius:16px;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);background:color-mix(in oklab,var(--vl-accent-soft) 60%,transparent)">
        <button id="vl-feedback-confirm-btn" data-session-id="${sessionId ?? ""}" style="display:flex;align-items:center;gap:7px;padding:11px 20px;border:1px solid color-mix(in oklab,var(--vl-accent) 35%,transparent);border-radius:999px;background:var(--vl-card);color:var(--vl-accent);font-size:13px;font-weight:700;cursor:pointer;animation:vlGlow 2.4s ease-in-out infinite">
          ${markSVG({ size: 15, filled: false, accent: "var(--vl-accent)" })}
          피드백 확인하기
        </button>
      </div>`
    : "";

  return `<div id="vl-review-card" style="position:relative;overflow:hidden;background:var(--vl-accent-soft);border:1px solid color-mix(in oklab,var(--vl-accent) 22%,transparent);border-radius:16px;padding:15px">
    <div style="${locked ? "filter:blur(6px);user-select:none;pointer-events:none" : ""}">
      <div style="display:flex;align-items:center;gap:7px;margin-bottom:9px">
        ${markSVG({ size: 18, filled: false, accent: "var(--vl-accent)" })}
        <span style="font-size:12.5px;font-weight:700;color:var(--vl-accent)">${title}</span>
      </div>
      ${topicBlock}
      <p style="margin:0;font-size:13.5px;line-height:1.65;color:var(--vl-ink);text-wrap:pretty">${text}</p>
      ${videoList}
    </div>
    ${revealOverlay}
  </div>`;
}

window.vlCard = vlCard;
window.vlSectionLabel = vlSectionLabel;
window.vlBadge = vlBadge;
window.vlDeltaChip = vlDeltaChip;
window.vlBarChart = vlBarChart;
window.vlDonut = vlDonut;
window.vlMiniLine = vlMiniLine;
window.vlReview = vlReview;
