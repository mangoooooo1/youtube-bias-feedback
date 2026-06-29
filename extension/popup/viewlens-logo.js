const VL_APERTURE_LINES = [
  [71, 50, 69.5, 16.2],
  [60.5, 31.8, 30.5, 16.2],
  [39.5, 31.8, 11, 50],
  [29, 50, 30.5, 83.8],
  [39.5, 68.2, 69.5, 83.8],
  [60.5, 68.2, 89, 50],
];

/**
 * Returns an inline SVG string for the aperture mark.
 * @param {object} opts
 * @param {number}  opts.size    - px dimension (default 40)
 * @param {boolean} opts.filled  - squircle background (default true)
 * @param {string}  opts.accent  - accent color (default var(--vl-accent))
 * @param {string}  opts.face    - stroke color on filled bg (default var(--vl-on-accent))
 */
function markSVG({
  size = 40,
  filled = true,
  accent = "var(--vl-accent)",
  face = "var(--vl-on-accent)",
} = {}) {
  const ink = filled ? face : accent;
  const bg = filled
    ? `<rect x="0" y="0" width="100" height="100" rx="28" ry="28" fill="${accent}"/>`
    : "";
  const lines = VL_APERTURE_LINES.map(
    ([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`,
  ).join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100"
      style="display:block;flex-shrink:0" aria-label="ViewLens"
      xmlns="http://www.w3.org/2000/svg">
    ${bg}
    <g fill="none" stroke="${ink}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="50" cy="50" r="39"/>
      ${lines}
    </g>
  </svg>`;
}

/**
 * Returns an HTML string for the ViewLens wordmark (mark + logotype).
 * @param {object} opts
 * @param {number}  opts.size    - logotype font size in px (default 22)
 * @param {number}  opts.gap     - gap between mark and text in px (default 11)
 * @param {string}  opts.accent  - accent color
 * @param {boolean} opts.filled  - filled mark background
 * @param {string}  opts.color   - logotype base color
 * @param {string}  [opts.sub]   - optional subline text
 */
function wordmarkHTML({
  size = 22,
  gap = 11,
  accent = "var(--vl-accent)",
  filled = true,
  color = "var(--vl-ink)",
  sub,
} = {}) {
  const markSize = Math.round(size * 1.55);
  const subLine = sub
    ? `<span style="margin-top:5px;;font-weight:500;font-size:${size * 0.42}px;letter-spacing:0.14em;text-transform:uppercase;color:var(--vl-ink-3)">${sub}</span>`
    : "";
  return `<div style="display:flex;align-items:center;gap:${gap}px">
    ${markSVG({ size: markSize, filled, accent })}
    <div style="display:flex;flex-direction:column;line-height:1">
      <span style="font-family:Pretendard,system-ui,sans-serif;font-weight:800;font-size:${size}px;letter-spacing:-0.025em;color:${color}">
        View<span style="color:${accent}">Lens</span>
      </span>
      ${subLine}
    </div>
  </div>`;
}

window.VL_APERTURE_LINES = VL_APERTURE_LINES;
window.markSVG = markSVG;
window.wordmarkHTML = wordmarkHTML;
