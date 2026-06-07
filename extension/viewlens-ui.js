function vlCard({ children = "", pad = 16, soft = false, style = "" } = {}) {
  return `<div style="background:${soft ? "var(--vl-card-2)" : "var(--vl-card)"};border:1px solid var(--vl-line);border-radius:16px;padding:${pad}px;${style}">${children}</div>`;
}

function vlSectionLabel({ text = "", right = "" } = {}) {
  return `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
    <span style="font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:var(--vl-ink-3);white-space:nowrap">${text}</span>
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
  return `<span style="display:inline-flex;align-items:center;gap:4px;color:${col};font-family:'JetBrains Mono',monospace;font-weight:600;font-size:12px">
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
        <span style="width:34px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--vl-ink-2);flex-shrink:0">${Math.round(d.p * 100)}%</span>
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
      <span style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:22px;color:var(--vl-ink);line-height:1">${Math.round(top.p * 100)}%</span>
      <span style="font-size:10.5px;color:var(--vl-ink-3);margin-top:3px;font-weight:600">${top.name}</span>
    </div>
  </div>`;
}

function vlDiversityMeter({
  value = 0,
  max = 3.17,
  lowAt = 1.9,
  highAt = 2.5,
} = {}) {
  const zones = [
    {
      key: "편중",
      lo: 0,
      hi: lowAt,
      col: "var(--vl-warn)",
      desc: `0–${lowAt}`,
    },
    {
      key: "보통",
      lo: lowAt,
      hi: highAt,
      col: "var(--vl-ink-2)",
      desc: `${lowAt}–${highAt}`,
    },
    {
      key: "다양",
      lo: highAt,
      hi: max,
      col: "var(--vl-good)",
      desc: `${highAt}+`,
    },
  ];
  const ai = value < lowAt ? 0 : value < highAt ? 1 : 2;
  const z = zones[ai];
  const local = Math.max(0, Math.min(1, (value - z.lo) / (z.hi - z.lo)));
  const markP = ((ai + local) / 3) * 100;
  const zoneBars = zones
    .map(
      (zn, i) =>
        `<div style="flex:1;border-right:${i < 2 ? "2px solid var(--vl-card)" : "none"};background:${i === ai ? zn.col : `color-mix(in oklab,${zn.col} 24%,var(--vl-line))`}"></div>`,
    )
    .join("");
  const zoneLabels = zones
    .map(
      (zn, i) =>
        `<div style="flex:1;text-align:center">
      <div style="font-size:12px;font-weight:${i === ai ? 800 : 600};color:${i === ai ? zn.col : "var(--vl-ink-3)"}">${zn.key}</div>
      <div style="font-size:9.5px;font-family:'JetBrains Mono',monospace;color:var(--vl-ink-3);margin-top:2px">${zn.desc}</div>
    </div>`,
    )
    .join("");
  return `<div style="width:100%">
    <div style="position:relative;height:24px">
      <div style="position:absolute;left:${markP}%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center">
        <span style="background:var(--vl-ink);color:var(--vl-card);font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;padding:2px 7px;border-radius:7px;white-space:nowrap;line-height:1.3">오늘 ${value.toFixed(2)}</span>
        <span style="width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid var(--vl-ink)"></span>
      </div>
    </div>
    <div style="display:flex;height:13px;border-radius:999px;overflow:hidden">${zoneBars}</div>
    <div style="display:flex;margin-top:7px">${zoneLabels}</div>
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

function vlReview({ text = "", title = "오늘의 코치 노트", videos = [] } = {}) {
  const cats = VL.CATS;
  const videoList =
    videos.length > 0
      ? `
    <div style="margin-top:13px;padding-top:12px;border-top:1px solid color-mix(in oklab,var(--vl-accent) 18%,transparent)">
      <div style="font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--vl-accent);margin-bottom:8px">분석한 영상 제목 (${videos.length})</div>
      <div style="display:flex;flex-direction:column;gap:7px">
        ${videos
          .slice(0, 4)
          .map(
            (v) => `
          <div style="display:flex;align-items:center;gap:8px">
            <span style="width:7px;height:7px;border-radius:2.5px;background:${(cats[v.cat] || {}).color || "var(--vl-ink-3)"};flex-shrink:0"></span>
            <span style="font-size:12px;color:var(--vl-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1">${v.title}</span>
          </div>
        `,
          )
          .join("")}
        ${videos.length > 4 ? `<div style="font-size:11px;color:var(--vl-ink-3);margin-top:1px">외 ${videos.length - 4}개 더 분석함</div>` : ""}
      </div>
    </div>
  `
      : "";
  return `<div style="background:var(--vl-accent-soft);border:1px solid color-mix(in oklab,var(--vl-accent) 22%,transparent);border-radius:16px;padding:15px">
    <div style="display:flex;align-items:center;gap:7px;margin-bottom:9px">
      ${markSVG({ size: 18, filled: false, accent: "var(--vl-accent)" })}
      <span style="font-size:12.5px;font-weight:700;color:var(--vl-accent)">${title}</span>
    </div>
    <p style="margin:0;font-size:13.5px;line-height:1.65;color:var(--vl-ink);text-wrap:pretty">${text}</p>
    ${videoList}
  </div>`;
}

window.vlCard = vlCard;
window.vlSectionLabel = vlSectionLabel;
window.vlBadge = vlBadge;
window.vlDeltaChip = vlDeltaChip;
window.vlBarChart = vlBarChart;
window.vlDonut = vlDonut;
window.vlDiversityMeter = vlDiversityMeter;
window.vlMiniLine = vlMiniLine;
window.vlReview = vlReview;
