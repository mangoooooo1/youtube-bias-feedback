function _lockIcon(size = 12) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" style="flex-shrink:0" xmlns="http://www.w3.org/2000/svg">
    <rect x="5" y="10" width="14" height="10" rx="2.5" fill="currentColor"/>
    <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="2.2" fill="none"/>
  </svg>`;
}

// ?? Onboarding ????????????????????????????????????????????????????????????????

function screenOnboarding() {
  return `<div style="padding:34px 22px 26px;display:flex;flex-direction:column;min-height:100%;box-sizing:border-box">
    <div style="display:flex;flex-direction:column;align-items:center;text-align:center;margin-top:18px">
      ${markSVG({ size: 64, accent: "var(--vl-accent)" })}
      <div style="margin-top:18px;font-size:25px;font-weight:800;letter-spacing:-0.03em;color:var(--vl-ink)">
        View<span style="color:var(--vl-accent)">Lens</span>
      </div>
      <p style="margin:10px 0 0;font-size:13.5px;line-height:1.6;color:var(--vl-ink-2);text-wrap:pretty;word-break:keep-all">
        異붿쿇 ?뚭퀬由ъ쬁???섏뼱 ?뱀떊???쒖껌 ?듦????뚯븘遊낅땲??<br />?곌뎄?먯뿉寃?諛쏆? 李몄뿬 肄붾뱶瑜??낅젰?섏뿬 ?쒖옉??二쇱꽭??
      </p>
    </div>

    <div style="margin-top:40px">
      <label style="font-size:12px; font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:var(--vl-ink-3)">李몄뿬 肄붾뱶</label>
      <input id="vl-onboard-input" value="" placeholder="?곌뎄?먯뿉寃?諛쏆? 李몄뿬 肄붾뱶" spellcheck="false" autocomplete="off"
        style="display:block;margin-top:9px;width:100%;box-sizing:border-box;padding:13px 15px;
          border:1.5px solid var(--vl-line-2);border-radius:13px;background:var(--vl-card-2);
          color:var(--vl-ink);outline:none;
          font-size:13px; letter-spacing:0.1em;text-transform:uppercase"/>
      <p id="vl-onboard-err" style="display:none;margin:9px 2px 0;font-size:12px;color:var(--vl-warn);line-height:1.5"></p>
      <button id="vl-onboard-btn"
        style="margin-top:14px;width:100%;padding:13px;border:none;border-radius:13px;
          background:var(--vl-accent);color:var(--vl-on-accent);font-size:14.5px;
          font-weight:700;cursor:pointer;font-family:inherit">?쒖옉?섍린</button>
    </div>

    <div style="margin-top:auto;padding-top:22px">
      <div style="display:flex;align-items:flex-start;gap:9px;padding:12px 13px;background:var(--vl-card-2);border:1px solid var(--vl-line);border-radius:12px">
        <div style="width:25px;height:25px;border-radius:7px;background:var(--vl-accent-soft);color:var(--vl-accent);display:grid;place-items:center;flex-shrink:0;margin-top:1px">
          ${_lockIcon(15)}
        </div>
        <p style="margin:0;font-size:11.5px;line-height:1.55;color:var(--vl-ink-2);text-wrap:pretty">
          ?쒖껌 湲곕줉? ?듬챸?쇰줈 ??λ맗?덈떎. ?꾧? ?대뼡 ?곸긽??遊ㅻ뒗吏???뱀젙?섏? ?딆쑝硫? ?섏쭛???곗씠?곕뒗 ?ㅼ쭅 ?곌뎄 紐⑹쟻?쇰줈留??ъ슜?⑸땲??
        </p>
      </div>
    </div>
  </div>`;
}

function bindOnboarding(root, onSubmit) {
  const input = root.querySelector("#vl-onboard-input");
  const errEl = root.querySelector("#vl-onboard-err");
  const btn = root.querySelector("#vl-onboard-btn");

  function submit() {
    const c = input.value.trim().toUpperCase();
    if (!c) {
      showErr("肄붾뱶瑜??낅젰??二쇱꽭??");
      return;
    }
    if (!VL.GROUPS[c]) {
      showErr("?좏슚?섏? ?딆? 肄붾뱶?덉슂. ?곌뎄?먯뿉寃?諛쏆? 肄붾뱶瑜??뺤씤??二쇱꽭??");
      return;
    }
    onSubmit(c);
  }
  function showErr(msg) {
    errEl.textContent = msg;
    errEl.style.display = "block";
    input.style.borderColor = "var(--vl-warn)";
  }
  input.addEventListener("input", () => {
    errEl.style.display = "none";
    input.style.borderColor = "var(--vl-line-2)";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  btn.addEventListener("click", submit);
}

// ?? Today ?????????????????????????????????????????????????????????????????????

function _collectingBanner(count) {
  if (!count) return "";
  const timerText = VL.today?.collectingTimer || "";
  return `<div id="vl-collecting-banner" style="display:flex;align-items:center;gap:9px;padding:10px 16px;background:var(--vl-accent-soft);border-bottom:1px solid var(--vl-line)">
    <span style="width:7px;height:7px;border-radius:50%;background:var(--vl-accent);flex-shrink:0;animation:vlBlink 1.6s ease-in-out infinite"></span>
    <div style="flex:1;min-width:0">
      <div id="vl-collecting-count" style="font-size:12.5px;font-weight:600;color:var(--vl-accent)">?곸긽 ${count}媛??섏쭛 以?/div>
      <div style="font-size:11px;color:var(--vl-accent);opacity:0.75;margin-top:1px">???쒓컙 ?덉뿉 ???쒖껌?섏? ?딆쑝硫??쇰뱶諛깆씠 ?앹꽦?쇱슂</div>
    </div>
    <span id="vl-collecting-timer" style="font-size:11px;font-weight:600;color:var(--vl-accent);opacity:0.8;white-space:nowrap;flex-shrink:0">${timerText}</span>
  </div>`;
}

function screenTodayEmpty(dateLabel, collectingCount, isToday = true) {
  return `<div style="display:flex;flex-direction:column;min-height:100%">
    ${_collectingBanner(collectingCount)}
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px 0">
      <button id="vl-date-prev" style="width:32px;height:32px;border:1px solid var(--vl-line);border-radius:9px;background:var(--vl-card);color:var(--vl-ink-2);cursor:pointer;font-size:15px;display:grid;place-items:center">??/button>
      <div style="font-size:13px;font-weight:700;color:var(--vl-ink-2)">${isToday ? "?ㅻ뒛" : dateLabel}</div>
      <button id="vl-date-next" style="width:32px;height:32px;border:1px solid var(--vl-line);border-radius:9px;background:var(--vl-card);color:${isToday ? "var(--vl-ink-3)" : "var(--vl-ink-2)"};cursor:${isToday ? "default" : "pointer"};font-size:15px;display:grid;place-items:center;opacity:${isToday ? 0.35 : 1}" ${isToday ? "disabled" : ""}>??/button>
    </div>
    <div style="flex:1;padding:24px 24px 40px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:10px">
      <div style="position:relative;width:80px;height:80px">
        <span style="position:absolute;inset:0;border-radius:50%;background:var(--vl-accent-soft);animation:vlPulse 2.4s ease-out infinite"></span>
        <span style="position:absolute;inset:0;border-radius:50%;border:2px solid var(--vl-accent);opacity:0.4;animation:vlPulse 2.4s ease-out infinite 0.6s"></span>
        <span style="position:absolute;inset:0;display:grid;place-items:center">
          ${markSVG({ size: 36, filled: false, accent: "var(--vl-accent)" })}
        </span>
      </div>
      <div>
        <div style="font-size:16px;font-weight:800;color:var(--vl-ink);letter-spacing:-0.02em">${isToday ? "?꾩쭅 ?ㅻ뒛 ?쒖껌 湲곕줉???놁뼱?? : "?????쒖껌 湲곕줉???놁뼱??}</div>
        ${
          isToday
            ? `<p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:var(--vl-ink-2);text-wrap:pretty;max-width:240px">
          ?좏뒠釉뚮? ?쒖껌?섎㈃ ?먮룞?쇰줈 ?섏쭛???쒖옉?쇱슂.<br>?쒖껌 醫낅즺 10遺???遺꾩꽍 寃곌낵媛 ?섑??섏슂.
        </p>`
            : ""
        }
      </div>
      <div style="font-size:11px;color:var(--vl-ink-3)">${dateLabel}</div>
    </div>
  </div>`;
}

function screenToday() {
  const d = VL.today;
  if (d.isEmpty) {
    const isToday = d.dateLabel === koreanDateLabel(new Date());
    return screenTodayEmpty(d.dateLabel, d.collectingCount, isToday);
  }
  const h = VL.entropy(d.dist);
  const delta = h - d.prevEntropy;

  const catRows = d.dist
    .map(
      (c) => `
    <div style="display:flex;align-items:center;gap:8px">
      <span style="width:8px;height:8px;border-radius:3px;background:${c.color};flex-shrink:0"></span>
      <span style="font-size:12px;color:var(--vl-ink);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.name}</span>
      <span style="font-size:12px;color:var(--vl-ink-2)">${Math.round(c.p * 100)}%</span>
    </div>
  `,
    )
    .join("");

  const isToday = d.dateLabel === koreanDateLabel(new Date());
  const isCollecting = d.collectingCount > 0 || !!d.collectingTimer;
  const collectingRow = isCollecting
    ? `
    <div style="display:flex;align-items:center;gap:6px">
      <span style="width:6px;height:6px;border-radius:50%;background:var(--vl-accent);flex-shrink:0;animation:vlBlink 1.6s ease-in-out infinite"></span>
      <div style="display:flex;flex-direction:column;gap:1px">
        <span id="vl-collecting-count" style="font-size:11.5px;font-weight:600;color:var(--vl-accent)">${d.collectingCount > 0 ? `?곸긽 ${d.collectingCount}媛??섏쭛 以? : "遺꾩꽍 以?.."}</span>
        <span id="vl-collecting-timer" style="font-size:10.5px;color:var(--vl-accent);opacity:0.8">${d.collectingTimer || ""}</span>
      </div>
    </div>`
    : "";
  return `<div style="display:flex;flex-direction:column">
    <div style="padding:16px 16px 22px;display:flex;flex-direction:column;gap:14px">
    <div style="display:flex;align-items:center;justify-content:space-between">
      <button id="vl-date-prev" style="width:32px;height:32px;border:1px solid var(--vl-line);border-radius:9px;background:var(--vl-card);color:var(--vl-ink-2);cursor:pointer;font-size:15px;display:grid;place-items:center">??/button>
      <div style="text-align:center">
        <div style="font-size:16px;font-weight:800;color:var(--vl-ink);letter-spacing:-0.02em">${isToday ? "?ㅻ뒛" : d.dateLabel}</div>
      </div>
      <button id="vl-date-next" style="width:32px;height:32px;border:1px solid var(--vl-line);border-radius:9px;background:var(--vl-card);color:${isToday ? "var(--vl-ink-3)" : "var(--vl-ink-2)"};cursor:${isToday ? "default" : "pointer"};font-size:15px;display:grid;place-items:center;opacity:${isToday ? 0.35 : 1}" ${isToday ? "disabled" : ""}>??/button>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between">
      <div>${collectingRow}</div>
      ${vlBadge({ text: `${d.videoCount}媛??곸긽 쨌 ${d.dist.length}媛?遺꾩빞`, tone: "neutral" })}
    </div>

    ${vlCard({
      pad: 16,
      children: `
      <div style="font-size:11.5px;color:var(--vl-ink-3);font-weight:600;margin-bottom:11px">吏곸쟾 ?쒖껌???鍮??ㅼ뼇??/div>
      <div style="display:flex;align-items:center;gap:13px">
        <div style="text-align:center">
          <div style=";font-size:18px;font-weight:700;color:var(--vl-ink-3);line-height:1">${d.prevEntropy.toFixed(2)}</div>
          <div style="font-size:10.5px;color:var(--vl-ink-3);margin-top:4px">${d.prevDateLabel}</div>
        </div>
        <span style="font-size:15px;color:var(--vl-ink-3)">??/span>
        <div style="text-align:center">
          <div style=";font-size:22px;font-weight:700;color:var(--vl-ink);line-height:1">${h.toFixed(2)}</div>
          <div style="font-size:10.5px;color:var(--vl-accent);margin-top:4px;font-weight:700">?ㅻ뒛</div>
        </div>
        <div style="margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:3px">
          ${vlDeltaChip({ value: delta })}
          <span style="font-size:11px;font-weight:700;color:${delta >= 0 ? "var(--vl-good)" : "var(--vl-warn)"}">${delta >= 0 ? "???ㅼ뼇?댁죱?댁슂" : "???몄쨷?먯뼱??}</span>
        </div>
      </div>
    `,
    })}

    ${vlCard({
      pad: 16,
      children: `
      ${vlSectionLabel({ text: "移댄뀒怨좊━ 遺꾪룷", right: `<span style="font-size:11px;color:var(--vl-ink-3)">?ㅻ뒛 ${d.videoCount}媛?/span>` })}
      <div style="display:flex;align-items:center;gap:16px;margin-top:6px">
        ${vlDonut({ data: d.dist, size: 124 })}
        <div style="flex:1;display:flex;flex-direction:column;gap:8px">${catRows}</div>
      </div>
    `,
    })}

    ${vlReview({ text: d.review, topic: d.reviewTopic, videos: d.videos })}
  </div>
  </div>`;
}

// ?? Feedback ??????????????????????????????????????????????????????????????????

function screenFeedback(currentWeek, selWeek) {
  const w = VL.weeks[selWeek - 1];
  const vsBase = w.entropy - VL.baselineH;
  const prevW = selWeek >= 2 ? VL.weeks[selWeek - 2] : null;
  const vsPrev = prevW ? w.entropy - prevW.entropy : 0;
  const showPrev = selWeek >= 3; // 吏곸쟾 二쇨? 泥?二쇱? ?ㅻ? ?뚮쭔 蹂꾨룄 ?쒖떆

  const weekBtns = VL.weeks
    .map((wk) => {
      const locked = wk.week > currentWeek;
      const active = wk.week === selWeek && !locked;
      return `<button data-week="${wk.week}" ${locked ? "disabled" : ""}
      style="flex:1;padding:10px 4px;border-radius:12px;cursor:${locked ? "default" : "pointer"};
        border:1.5px solid ${active ? "var(--vl-accent)" : "var(--vl-line)"};
        background:${active ? "var(--vl-accent-soft)" : "var(--vl-card)"};
        color:${locked ? "var(--vl-ink-3)" : active ? "var(--vl-accent)" : "var(--vl-ink-2)"};
        font-family:inherit;font-weight:700;font-size:13px;opacity:${locked ? 0.65 : 1};
        display:flex;flex-direction:column;align-items:center;gap:3px">
      <span style="display:flex;align-items:center;gap:4px">
        ${locked ? _lockIcon(10) : ""}${wk.label}
      </span>
      <span style="font-size:9.5px;font-weight:500;color:inherit;opacity:0.8;">
        ${locked ? `${wk.week}二쇱감 怨듦컻` : wk.isBaseline ? "泥?二? : ""}
      </span>
    </button>`;
    })
    .join("");

  const vsBaseContent = w.isBaseline
    ? `<p style="margin:0;font-size:12px;line-height:1.55;color:var(--vl-ink-2)">泥?二쇰씪 ?꾩쭅 鍮꾧탳???댁쟾 二쇨? ?놁뼱??</p>`
    : `<div>
        <div style="font-size:11.5px;color:var(--vl-ink-3);margin-bottom:4px">泥?二??鍮?/div>
        <div style="display:flex;align-items:center;gap:7px">
          ${vlDeltaChip({ value: vsBase })}
          <span style="font-size:12px;color:var(--vl-ink-2)">${vsBase >= 0 ? "???ㅼ뼇?댁슂" : "???ㅼ뼇?댁슂"}</span>
        </div>
        ${
          showPrev
            ? `<div style="margin-top:8px">
          <div style="font-size:11.5px;color:var(--vl-ink-3);margin-bottom:4px">吏곸쟾 二?${prevW.label}) ?鍮?/div>
          <div style="display:flex;align-items:center;gap:7px">
            ${vlDeltaChip({ value: vsPrev })}
            <span style="font-size:12px;color:var(--vl-ink-2)">${vsPrev >= 0 ? "???ㅼ뼇?댁슂" : "???ㅼ뼇?댁슂"}</span>
          </div>
        </div>`
            : ""
        }
      </div>`;

  const baselineLegend = !w.isBaseline
    ? `
    <div style="display:flex;align-items:center;gap:5px;margin-top:7px">
      <span style="width:14px;height:0;border-top:1px dashed var(--vl-ink-3)"></span>
      <span style="font-size:10.5px;color:var(--vl-ink-3)">?먯꽑 = 泥?二?${VL.baselineH.toFixed(2)}</span>
    </div>`
    : "";

  return `<div style="padding:16px 16px 22px;display:flex;flex-direction:column;gap:14px">
    <div style="display:flex;gap:8px" id="vl-week-btns">${weekBtns}</div>

    <div style="display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-size:16px;font-weight:800;color:var(--vl-ink)">
          ${w.label} 由ы룷??
          ${w.isBaseline ? '<span style="font-size:11px;color:var(--vl-ink-3);font-weight:600"> 쨌 ViewLens? ?④퍡??泥?二?/span>' : ""}
        </div>
        <div style=";font-size:11.5px;color:var(--vl-ink-3);margin-top:2px">${w.range}</div>
      </div>
    </div>

    ${vlCard({
      pad: 16,
      children: `
      <div style="display:flex;align-items:center;gap:14px">
        <div class="vl-tip" data-tip="?쒖껌???곸긽???щ윭 移댄뀒怨좊━??怨좊Ⅴ寃??쇱졇 ?덉쓣?섎줉 ?믪븘吏???먯닔?덉슂.&#10;??二쇱젣留?蹂대㈃ ??퀬, ?ㅼ뼇?섍쾶 蹂쇱닔濡??щ씪媛??" style="text-align:center;flex-shrink:0">
          <div style="font-weight:700;font-size:30px;color:var(--vl-ink);line-height:1;letter-spacing:-0.02em">${w.entropy.toFixed(2)}</div>
          <div style="font-size:10.5px;color:var(--vl-ink-3);margin-top:4px;font-weight:600">?ㅼ뼇???먯닔 ??/div>
        </div>
        <div style="width:1px;align-self:stretch;background:var(--vl-line)"></div>
        <div style="flex:1">${vsBaseContent}</div>
      </div>
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--vl-line)">
        ${vlSectionLabel({ text: "?쇰퀎 ?ㅼ뼇??異붿씠" })}
        ${vlMiniLine({ data: w.daily, baseline: w.isBaseline ? null : VL.baselineH })}
        ${baselineLegend}
      </div>
    `,
    })}

    ${vlCard({
      pad: 16,
      children: `
      ${vlSectionLabel({ text: "二쇨컙 移댄뀒怨좊━ 遺꾪룷" })}
      ${vlBarChart({ data: w.dist })}
    `,
    })}

    ${vlReview({ text: w.review, title: `${w.label} ?뚯븘蹂닿린` })}
  </div>`;
}

// ?? Control group home ????????????????????????????????????????????????????????

function screenControlHome(day, stats = {}) {
  const cells = [
    { v: `${stats.todayCount ?? VL.con.todayCount}媛?, l: "?ㅻ뒛 ?쒖껌???곸긽" },
    {
      v: `${stats.totalCount ?? VL.con.totalCount}媛?,
      l: "吏湲덇퉴吏 ?꾩쟻 ?쒖껌???곸긽",
    },
    { v: `${day}?쇱㎏`, l: "ViewLens? ?④퍡??吏" },
    { v: `D-${Math.max(0, VL.TOTAL_DAYS - day)}`, l: "?ㅽ뿕 醫낅즺源뚯?" },
  ];
  const gridCells = cells
    .map(
      (cell, i) => `
    <div style="padding:16px 18px;border-right:${i % 2 === 0 ? "1px solid var(--vl-line)" : "none"};border-bottom:${i < 2 ? "1px solid var(--vl-line)" : "none"}">
      <div style="font-weight:700;font-size:24px;color:var(--vl-ink);letter-spacing:-0.02em;line-height:1">${cell.v}</div>
      <div style="font-size:11.5px;color:var(--vl-ink-3);margin-top:6px;font-weight:500">${cell.l}</div>
    </div>
  `,
    )
    .join("");

  return `<div style="padding:20px 18px 24px;display:flex;flex-direction:column;gap:16px">
    ${vlCard({
      pad: 20,
      style: "text-align:center",
      children: `
      <div style="position:relative;width:76px;height:76px;margin:6px auto 0">
        <span style="position:absolute;inset:0;border-radius:50%;background:var(--vl-accent-soft)"></span>
        <span style="position:absolute;inset:0;border-radius:50%;border:2px solid var(--vl-accent);opacity:0.5;animation:vlPulse 2.4s ease-out infinite"></span>
        <span style="position:absolute;inset:0;display:grid;place-items:center">
          ${markSVG({ size: 36, filled: false, accent: "var(--vl-accent)" })}
        </span>
      </div>
      <div style="margin-top:16px;font-size:16.5px;font-weight:800;color:var(--vl-ink)">?쒖껌 湲곕줉???섏쭛?섍퀬 ?덉뼱??/div>
      <p style="margin:9px auto 0;max-width:250px;font-size:13px;line-height:1.6;color:var(--vl-ink-2);text-wrap:pretty">
        ?됱냼泥섎읆 ?좏뒠釉뚮? ?쒖껌??二쇱꽭?? ?곌뎄 湲곌컙 ?숈븞 ?쒖껌 ?곗씠?곌? 湲곌린 ?덉뿉 ?덉쟾?섍쾶 湲곕줉?쇱슂.
      </p>
    `,
    })}

    ${vlCard({ pad: 0, children: `<div style="display:grid;grid-template-columns:1fr 1fr">${gridCells}</div>` })}

    <div style="display:flex;align-items:flex-start;gap:9px;padding:13px 14px;background:var(--vl-card-2);border:1px solid var(--vl-line);border-radius:13px">
      <div style="width:25px;height:25px;border-radius:7px;background:var(--vl-accent-soft);color:var(--vl-accent);display:grid;place-items:center;flex-shrink:0;margin-top:1px">
        ${_lockIcon(15)}
      </div>
      <p style="margin:0;font-size:11.5px;line-height:1.55;color:var(--vl-ink-2);text-wrap:pretty">
        ?ㅽ뿕 湲곌컙 以??쇰뱶諛??쒓났 ?쒖젏? 李몄뿬?먮쭏???ㅻ? ???덉쑝硫? ?ㅽ뿕 醫낅즺 ??紐⑤뱺 李몄뿬?먯뿉寃?寃곌낵瑜?怨듭쑀?⑸땲??
      </p>
    </div>
  </div>`;
}

// ?? Survey modal ??????????????????????????????????????????????????????????????

function screenSurveyModal(week) {
  return `<div id="vl-survey-overlay" style="position:absolute;inset:0;z-index:40;background:color-mix(in oklab,var(--vl-ink) 42%,transparent);backdrop-filter:blur(2px)">
    <div style="position:absolute;left:0;right:0;bottom:0;background:var(--vl-card);border-radius:22px 22px 0 0;padding:22px 20px 20px;box-shadow:0 -16px 40px rgba(0,0,0,.18);animation:vlSheet .32s cubic-bezier(.2,.9,.2,1)">
      <div style="width:38px;height:4px;border-radius:999px;background:var(--vl-line-2);margin:0 auto 16px"></div>
      ${vlBadge({ text: `${week}二쇱감 ?ㅻЦ`, tone: "accent", size: "sm" })}
      <h3 style="margin:12px 0 0;font-size:18px;font-weight:800;color:var(--vl-ink);letter-spacing:-0.02em">${week}二쇱감媛 ?앸궗?댁슂!</h3>
      <p style="margin:8px 0 0;font-size:13.5px;line-height:1.6;color:var(--vl-ink-2);text-wrap:pretty">
        ?곌뎄?먭? 媛쒖씤?곸쑝濡?蹂대궡?쒕┛ <b style="color:var(--vl-ink)">?ㅻЦ 留곹겕</b>??李몄뿬??二쇱꽭??
        ?щ윭遺꾩쓽 ?묐떟???곌뎄?????꾩????쇱슂.
      </p>
      <div style="display:flex;flex-direction:column;gap:9px;margin-top:18px">
        <button id="vl-survey-done"
          style="width:100%;padding:13px;border:none;border-radius:13px;cursor:pointer;background:var(--vl-accent);color:var(--vl-on-accent);font-size:14px;font-weight:700;font-family:inherit">?ㅻЦ ?꾨즺?덉뼱??/button>
        <button id="vl-survey-later"
          style="width:100%;padding:12px;border-radius:13px;cursor:pointer;background:transparent;color:var(--vl-ink-2);border:1px solid var(--vl-line-2);font-size:13.5px;font-weight:600;font-family:inherit">?꾩쭅 ???덉뼱??/button>
      </div>
      <p style="margin:12px 0 0;font-size:11px;color:var(--vl-ink-3);text-align:center;line-height:1.5">?꾨즺瑜??꾨Ⅴ湲??꾧퉴吏 ???덈궡媛 怨꾩냽 ?쒖떆?쇱슂.</p>
    </div>
  </div>`;
}

window.screenOnboarding = screenOnboarding;
window.bindOnboarding = bindOnboarding;
window.screenToday = screenToday;
window.screenFeedback = screenFeedback;
window.screenControlHome = screenControlHome;
window.screenSurveyModal = screenSurveyModal;
