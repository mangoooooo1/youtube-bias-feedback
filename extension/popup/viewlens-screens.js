function _lockIcon(size = 12) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" style="flex-shrink:0" xmlns="http://www.w3.org/2000/svg">
    <rect x="5" y="10" width="14" height="10" rx="2.5" fill="currentColor"/>
    <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="2.2" fill="none"/>
  </svg>`;
}

// ── Onboarding ────────────────────────────────────────────────────────────────

function screenOnboarding() {
  return `<div style="padding:34px 22px 26px;display:flex;flex-direction:column;min-height:100%;box-sizing:border-box">
    <div style="display:flex;flex-direction:column;align-items:center;text-align:center;margin-top:18px">
      ${markSVG({ size: 64, accent: "var(--vl-accent)" })}
      <div style="margin-top:18px;font-size:25px;font-weight:800;letter-spacing:-0.03em;color:var(--vl-ink)">
        View<span style="color:var(--vl-accent)">Lens</span>
      </div>
      <p style="margin:10px 0 0;font-size:13.5px;line-height:1.6;color:var(--vl-ink-2);text-wrap:pretty;word-break:keep-all">
        추천 알고리즘을 넘어 당신의 시청 습관을 돌아봅니다.<br />연구자에게 받은 참여 코드를 입력하여 시작해 주세요.
      </p>
    </div>

    <div style="margin-top:40px">
      <label style="font-size:12px; font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:var(--vl-ink-3)">참여 코드</label>
      <input id="vl-onboard-input" value="" placeholder="연구자에게 받은 참여 코드" spellcheck="false" autocomplete="off"
        style="display:block;margin-top:9px;width:100%;box-sizing:border-box;padding:13px 15px;
          border:1.5px solid var(--vl-line-2);border-radius:13px;background:var(--vl-card-2);
          color:var(--vl-ink);outline:none;
          font-size:13px; letter-spacing:0.1em;text-transform:uppercase"/>
      <p id="vl-onboard-err" style="display:none;margin:9px 2px 0;font-size:12px;color:var(--vl-warn);line-height:1.5"></p>
      <button id="vl-onboard-btn"
        style="margin-top:14px;width:100%;padding:13px;border:none;border-radius:13px;
          background:var(--vl-accent);color:var(--vl-on-accent);font-size:14.5px;
          font-weight:700;cursor:pointer;font-family:inherit">시작하기</button>
    </div>

    <div style="margin-top:auto;padding-top:22px">
      <div style="display:flex;align-items:flex-start;gap:9px;padding:12px 13px;background:var(--vl-card-2);border:1px solid var(--vl-line);border-radius:12px">
        <div style="width:25px;height:25px;border-radius:7px;background:var(--vl-accent-soft);color:var(--vl-accent);display:grid;place-items:center;flex-shrink:0;margin-top:1px">
          ${_lockIcon(15)}
        </div>
        <p style="margin:0;font-size:11.5px;line-height:1.55;color:var(--vl-ink-2);text-wrap:pretty">
          시청 기록은 익명으로 저장됩니다. 누가 어떤 영상을 봤는지는 특정되지 않으며, 수집된 데이터는 오직 연구 목적으로만 사용됩니다.
        </p>
      </div>
    </div>
  </div>`;
}

// 참여 코드 파싱 → { group, code } 또는 null(형식 오류)
// - 실전 코드: 난독 접두사(QWE=실험군, ASD=대조군) + 랜덤 4자, 예 "QWE-K7M2"
// - 테스트 코드: "TEST-EXP" / "TEST-CON" (그룹으로 그대로 사용)
// 접두사는 참여자에게 그룹(실험군/대조군)을 노출하지 않도록 난독화한 값이다.
function parseParticipantCode(raw) {
  const code = (raw || "").trim().toUpperCase();
  if (code === "TEST-EXP" || code === "TEST-CON") return { group: code, code };
  const m = code.match(/^(QWE|ASD)-[A-Z2-9]{4}$/);
  if (!m) return null;
  return { group: m[1] === "QWE" ? "EXP" : "CON", code };
}

function bindOnboarding(root, onSubmit) {
  const input = root.querySelector("#vl-onboard-input");
  const errEl = root.querySelector("#vl-onboard-err");
  const btn = root.querySelector("#vl-onboard-btn");

  const btnLabel = btn.textContent;

  async function submit() {
    const raw = input.value.trim();
    if (!raw) {
      showErr("코드를 입력해 주세요.");
      return;
    }
    const parsed = parseParticipantCode(raw);
    if (!parsed) {
      showErr("유효하지 않은 코드예요. 연구자에게 받은 코드를 확인해 주세요.");
      return;
    }

    // 서버 발급 명단 검증 — 오프라인/서버 미설정 시엔 통과(폴백)
    btn.disabled = true;
    btn.textContent = "확인 중…";
    const check = window.validateParticipantCode
      ? await window.validateParticipantCode(parsed.code)
      : { ok: true };
    btn.disabled = false;
    btn.textContent = btnLabel;

    if (!check.ok) {
      showErr("발급되지 않은 코드예요. 연구자에게 받은 코드를 확인해 주세요.");
      return;
    }
    // 서버가 그룹을 확정해 주면 그 값을 사용(권위), 아니면 코드 접두사 기준
    onSubmit({ group: check.group || parsed.group, code: parsed.code });
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

// ── Today ─────────────────────────────────────────────────────────────────────

function _collectingBanner(count) {
  if (!count) return "";
  const timerText = VL.today?.collectingTimer || "";
  return `<div id="vl-collecting-banner" style="display:flex;align-items:center;gap:9px;padding:10px 16px;background:var(--vl-accent-soft);border-bottom:1px solid var(--vl-line)">
    <span style="width:7px;height:7px;border-radius:50%;background:var(--vl-accent);flex-shrink:0;animation:vlBlink 1.6s ease-in-out infinite"></span>
    <div style="flex:1;min-width:0">
      <div id="vl-collecting-count" style="font-size:12.5px;font-weight:600;color:var(--vl-accent)">영상 ${count}개 수집 중</div>
      <div style="font-size:11px;color:var(--vl-accent);opacity:0.75;margin-top:1px">이 시간 안에 더 시청하지 않으면 피드백이 생성돼요</div>
    </div>
    <span id="vl-collecting-timer" style="font-size:11px;font-weight:600;color:var(--vl-accent);opacity:0.8;white-space:nowrap;flex-shrink:0">${timerText}</span>
  </div>`;
}

function screenTodayEmpty(dateLabel, collectingCount, isToday = true) {
  return `<div style="display:flex;flex-direction:column;min-height:100%">
    ${_collectingBanner(collectingCount)}
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px 0">
      <button id="vl-date-prev" style="width:32px;height:32px;border:1px solid var(--vl-line);border-radius:9px;background:var(--vl-card);color:var(--vl-ink-2);cursor:pointer;font-size:15px;display:grid;place-items:center">‹</button>
      <div style="font-size:13px;font-weight:700;color:var(--vl-ink-2)">${isToday ? "오늘" : dateLabel}</div>
      <button id="vl-date-next" style="width:32px;height:32px;border:1px solid var(--vl-line);border-radius:9px;background:var(--vl-card);color:${isToday ? "var(--vl-ink-3)" : "var(--vl-ink-2)"};cursor:${isToday ? "default" : "pointer"};font-size:15px;display:grid;place-items:center;opacity:${isToday ? 0.35 : 1}" ${isToday ? "disabled" : ""}>›</button>
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
        <div style="font-size:16px;font-weight:800;color:var(--vl-ink);letter-spacing:-0.02em">${isToday ? "아직 오늘 시청 기록이 없어요" : "이 날 시청 기록이 없어요"}</div>
        ${
          isToday
            ? `<p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:var(--vl-ink-2);text-wrap:pretty;max-width:240px">
          유튜브를 시청하면 자동으로 수집이 시작돼요.<br>시청 종료 10분 후 분석 결과가 나타나요.
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
  // 오늘의 실제 리뷰인데 아직 "확인하기"를 안 눌렀으면 블러 처리 — 지난 날짜는 대상 아님.
  const reviewLocked = isToday && !d.confirmed && isRealReview(d.review);
  const isCollecting = d.collectingCount > 0 || !!d.collectingTimer;
  const collectingRow = isCollecting
    ? `
    <div style="display:flex;align-items:center;gap:6px">
      <span style="width:6px;height:6px;border-radius:50%;background:var(--vl-accent);flex-shrink:0;animation:vlBlink 1.6s ease-in-out infinite"></span>
      <div style="display:flex;flex-direction:column;gap:1px">
        <span id="vl-collecting-count" style="font-size:11.5px;font-weight:600;color:var(--vl-accent)">${d.collectingCount > 0 ? `영상 ${d.collectingCount}개 수집 중` : "분석 중..."}</span>
        <span id="vl-collecting-timer" style="font-size:10.5px;color:var(--vl-accent);opacity:0.8">${d.collectingTimer || ""}</span>
      </div>
    </div>`
    : "";
  // 오늘 탭 안에 들어와 있어도 스크롤 안 하면 확인 카드가 안 보이니, 스크롤하지 않아도
  // 보이는 상단 영역에 내려가 보라는 안내를 띄운다(수집 중 표시와 자리를 공유).
  const scrollNudgeRow = reviewLocked
    ? `<div style="display:flex;align-items:center;gap:6px">
      <span style="display:inline-block;font-size:13px;line-height:1;color:var(--vl-accent);animation:vlBounceDown 1.2s ease-in-out infinite">↓</span>
      <span style="font-size:11.5px;font-weight:600;color:var(--vl-accent)">아래로 스크롤해서 피드백 확인하세요!</span>
    </div>`
    : "";
  return `<div style="display:flex;flex-direction:column">
    <div style="padding:16px 16px 22px;display:flex;flex-direction:column;gap:14px">
    <div style="display:flex;align-items:center;justify-content:space-between">
      <button id="vl-date-prev" style="width:32px;height:32px;border:1px solid var(--vl-line);border-radius:9px;background:var(--vl-card);color:var(--vl-ink-2);cursor:pointer;font-size:15px;display:grid;place-items:center">‹</button>
      <div style="text-align:center">
        <div style="font-size:16px;font-weight:800;color:var(--vl-ink);letter-spacing:-0.02em">${isToday ? "오늘" : d.dateLabel}</div>
      </div>
      <button id="vl-date-next" style="width:32px;height:32px;border:1px solid var(--vl-line);border-radius:9px;background:var(--vl-card);color:${isToday ? "var(--vl-ink-3)" : "var(--vl-ink-2)"};cursor:${isToday ? "default" : "pointer"};font-size:15px;display:grid;place-items:center;opacity:${isToday ? 0.35 : 1}" ${isToday ? "disabled" : ""}>›</button>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between">
      <div>${isCollecting ? collectingRow : scrollNudgeRow}</div>
      ${vlBadge({ text: `${d.videoCount}개 영상 · ${d.dist.length}개 분야`, tone: "neutral" })}
    </div>

    ${vlCard({
      pad: 16,
      children: `
      <div style="font-size:11.5px;color:var(--vl-ink-3);font-weight:600;margin-bottom:11px">직전 시청일 대비 다양성</div>
      <div style="display:flex;align-items:center;gap:13px">
        <div style="text-align:center">
          <div style=";font-size:18px;font-weight:700;color:var(--vl-ink-3);line-height:1">${d.prevEntropy.toFixed(2)}</div>
          <div style="font-size:10.5px;color:var(--vl-ink-3);margin-top:4px">${d.prevDateLabel}</div>
        </div>
        <span style="font-size:15px;color:var(--vl-ink-3)">→</span>
        <div style="text-align:center">
          <div style=";font-size:22px;font-weight:700;color:var(--vl-ink);line-height:1">${h.toFixed(2)}</div>
          <div style="font-size:10.5px;color:var(--vl-accent);margin-top:4px;font-weight:700">오늘</div>
        </div>
        <div style="margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:3px">
          ${vlDeltaChip({ value: delta })}
          <span style="font-size:11px;font-weight:700;color:${delta >= 0 ? "var(--vl-good)" : "var(--vl-warn)"}">${delta >= 0 ? "더 다양해졌어요" : "더 편중됐어요"}</span>
        </div>
      </div>
    `,
    })}

    ${vlCard({
      pad: 16,
      children: `
      ${vlSectionLabel({ text: "카테고리 분포", right: `<span style="font-size:11px;color:var(--vl-ink-3)">오늘 ${d.videoCount}개</span>` })}
      <div style="display:flex;align-items:center;gap:16px;margin-top:6px">
        ${vlDonut({ data: d.dist, size: 124 })}
        <div style="flex:1;display:flex;flex-direction:column;gap:8px">${catRows}</div>
      </div>
    `,
    })}

    ${vlReview({ text: d.review, topic: d.reviewTopic, videos: d.videos, locked: reviewLocked, sessionId: d.sessionId })}
  </div>
  </div>`;
}

// ── Feedback ──────────────────────────────────────────────────────────────────

function screenFeedback(currentWeek, selWeek) {
  const w = VL.weeks[selWeek - 1];
  const vsBase = w.entropy - VL.baselineH;
  const prevW = selWeek >= 2 ? VL.weeks[selWeek - 2] : null;
  const vsPrev = prevW ? w.entropy - prevW.entropy : 0;
  // 직전 주가 베이스라인 기간(1·2주차)과 다를 때만 별도 표시 — 개입 첫 주(3주차)의
  // "직전 주"는 베이스라인 2주차라 "베이스라인 대비"와 중복이라 4주차부터 보여준다.
  const showPrev = selWeek >= 4;

  const weekBtns = VL.weeks
    .map((wk) => {
      const locked = wk.week > currentWeek;
      const active = wk.week === selWeek && !locked;
      return `<button data-week="${wk.week}" ${locked ? "disabled" : ""}
      style="flex:0 0 72px;padding:10px 4px;border-radius:12px;cursor:${locked ? "default" : "pointer"};
        border:1.5px solid ${active ? "var(--vl-accent)" : "var(--vl-line)"};
        background:${active ? "var(--vl-accent-soft)" : "var(--vl-card)"};
        color:${locked ? "var(--vl-ink-3)" : active ? "var(--vl-accent)" : "var(--vl-ink-2)"};
        font-family:inherit;font-weight:700;font-size:13px;opacity:${locked ? 0.65 : 1};
        display:flex;flex-direction:column;align-items:center;gap:3px">
      <span style="display:flex;align-items:center;gap:4px;white-space:nowrap">
        ${locked ? _lockIcon(10) : ""}${wk.label}
      </span>
      <span style="font-size:9.5px;font-weight:500;color:inherit;opacity:0.8;white-space:nowrap">
        ${locked ? `${wk.week}주차 공개` : wk.isBaseline ? "베이스라인" : ""}
      </span>
    </button>`;
    })
    .join("");

  const vsBaseContent = w.isBaseline
    ? `<p style="margin:0;font-size:12px;line-height:1.55;color:var(--vl-ink-2)">베이스라인 기간이라 아직 비교할 데이터가 없어요.</p>`
    : `<div>
        <div style="font-size:11.5px;color:var(--vl-ink-3);margin-bottom:4px">베이스라인 대비</div>
        <div style="display:flex;align-items:center;gap:7px">
          ${vlDeltaChip({ value: vsBase })}
          <span style="font-size:12px;color:var(--vl-ink-2)">${vsBase >= 0 ? "더 다양해요" : "덜 다양해요"}</span>
        </div>
        ${
          showPrev
            ? `<div style="margin-top:8px">
          <div style="font-size:11.5px;color:var(--vl-ink-3);margin-bottom:4px">직전 주(${prevW.label}) 대비</div>
          <div style="display:flex;align-items:center;gap:7px">
            ${vlDeltaChip({ value: vsPrev })}
            <span style="font-size:12px;color:var(--vl-ink-2)">${vsPrev >= 0 ? "더 다양해요" : "덜 다양해요"}</span>
          </div>
        </div>`
            : ""
        }
      </div>`;

  const baselineLegend = !w.isBaseline
    ? `
    <div style="display:flex;align-items:center;gap:5px;margin-top:7px">
      <span style="width:14px;height:0;border-top:1px dashed var(--vl-ink-3)"></span>
      <span style="font-size:10.5px;color:var(--vl-ink-3)">점선 = 베이스라인 ${VL.baselineH.toFixed(2)}</span>
    </div>`
    : "";

  return `<div style="padding:16px 16px 22px;display:flex;flex-direction:column;gap:14px">
    <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:2px" id="vl-week-btns">${weekBtns}</div>

    <div style="display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-size:16px;font-weight:800;color:var(--vl-ink)">
          ${w.label} 리포트
          ${w.isBaseline ? '<span style="font-size:11px;color:var(--vl-ink-3);font-weight:600"> · 베이스라인 기간</span>' : ""}
        </div>
        <div style=";font-size:11.5px;color:var(--vl-ink-3);margin-top:2px">${w.range}</div>
      </div>
    </div>

    ${vlCard({
      pad: 16,
      children: `
      <div style="display:flex;align-items:center;gap:14px">
        <div class="vl-tip" data-tip="시청한 영상이 여러 카테고리에 고르게 퍼져 있을수록 높아지는 점수예요.&#10;한 주제만 보면 낮고, 다양하게 볼수록 올라가요." style="text-align:center;flex-shrink:0">
          <div style="font-weight:700;font-size:30px;color:var(--vl-ink);line-height:1;letter-spacing:-0.02em">${w.entropy.toFixed(2)}</div>
          <div style="font-size:10.5px;color:var(--vl-ink-3);margin-top:4px;font-weight:600">다양성 점수 ⓘ</div>
        </div>
        <div style="width:1px;align-self:stretch;background:var(--vl-line)"></div>
        <div style="flex:1">${vsBaseContent}</div>
      </div>
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--vl-line)">
        ${vlSectionLabel({ text: "일별 다양성 추이" })}
        ${vlMiniLine({ data: w.daily, baseline: w.isBaseline ? null : VL.baselineH })}
        ${baselineLegend}
      </div>
    `,
    })}

    ${vlCard({
      pad: 16,
      children: `
      ${vlSectionLabel({ text: "주간 카테고리 분포" })}
      ${vlBarChart({ data: w.dist })}
    `,
    })}

    ${vlReview({ text: w.review, title: `${w.label} 돌아보기` })}
  </div>`;
}

// ── Control group home ────────────────────────────────────────────────────────

function screenControlHome(day, stats = {}) {
  const cells = [
    { v: `${stats.todayCount ?? VL.con.todayCount}개`, l: "오늘 시청한 영상" },
    {
      v: `${stats.totalCount ?? VL.con.totalCount}개`,
      l: "지금까지 시청한 영상",
    },
    { v: `${day}일째`, l: "ViewLens와 함께한 지" },
    { v: `D-${Math.max(0, VL.TOTAL_DAYS - day)}`, l: "실험 종료까지" },
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
      <div style="margin-top:16px;font-size:16.5px;font-weight:800;color:var(--vl-ink)">시청 기록을 수집하고 있어요</div>
      <p style="margin:9px auto 0;max-width:250px;font-size:13px;line-height:1.6;color:var(--vl-ink-2);text-wrap:pretty">
        평소처럼 유튜브를 시청해 주세요. 연구 기간 동안 시청 데이터가 기기 안에 안전하게 기록돼요.
      </p>
      ${
        // 10-8: 베이스라인 중인 EXP에게만 보여주는 한 줄 — CON은 종료 후 일괄 제공(10-10)이라
        // "언제부터 분석을 받는지"라는 개념 자체가 없어 stats.baselineDaysLeft가 null로 온다.
        stats.baselineDaysLeft != null
          ? `<p style="margin:8px auto 0;max-width:250px;font-size:12.5px;line-height:1.6;color:var(--vl-accent);font-weight:600;text-wrap:pretty">
        베이스라인 이후(D-${stats.baselineDaysLeft})부터 나만의 시청 분석을 받아볼 수 있어요.
      </p>`
          : ""
      }
    `,
    })}

    ${vlCard({ pad: 0, children: `<div style="display:grid;grid-template-columns:1fr 1fr">${gridCells}</div>` })}

    <div style="display:flex;align-items:flex-start;gap:9px;padding:13px 14px;background:var(--vl-card-2);border:1px solid var(--vl-line);border-radius:13px">
      <div style="width:25px;height:25px;border-radius:7px;background:var(--vl-accent-soft);color:var(--vl-accent);display:grid;place-items:center;flex-shrink:0;margin-top:1px">
        ${_lockIcon(15)}
      </div>
      <p style="margin:0;font-size:11.5px;line-height:1.55;color:var(--vl-ink-2);text-wrap:pretty">
        실험 기간 중 피드백 제공 시점은 참여자마다 다를 수 있으며, 실험 종료 후 모든 참여자에게 결과를 공유합니다.
      </p>
    </div>
  </div>`;
}

// ── Survey modal ──────────────────────────────────────────────────────────────

function screenSurveyModal(week) {
  return `<div id="vl-survey-overlay" style="position:absolute;inset:0;z-index:40;background:color-mix(in oklab,var(--vl-ink) 42%,transparent);backdrop-filter:blur(2px)">
    <div style="position:absolute;left:0;right:0;bottom:0;background:var(--vl-card);border-radius:22px 22px 0 0;padding:22px 20px 20px;box-shadow:0 -16px 40px rgba(0,0,0,.18);animation:vlSheet .32s cubic-bezier(.2,.9,.2,1)">
      <div style="width:38px;height:4px;border-radius:999px;background:var(--vl-line-2);margin:0 auto 16px"></div>
      ${vlBadge({ text: `${week}주차 설문`, tone: "accent", size: "sm" })}
      <h3 style="margin:12px 0 0;font-size:18px;font-weight:800;color:var(--vl-ink);letter-spacing:-0.02em">${week}주차가 끝났어요!</h3>
      <p style="margin:8px 0 0;font-size:13.5px;line-height:1.6;color:var(--vl-ink-2);text-wrap:pretty">
        연구자가 개인적으로 보내드린 <b style="color:var(--vl-ink)">설문 링크</b>에 참여해 주세요.
        여러분의 응답이 연구에 큰 도움이 돼요.
      </p>
      <div style="display:flex;flex-direction:column;gap:9px;margin-top:18px">
        <button id="vl-survey-done"
          style="width:100%;padding:13px;border:none;border-radius:13px;cursor:pointer;background:var(--vl-accent);color:var(--vl-on-accent);font-size:14px;font-weight:700;font-family:inherit">설문 완료했어요</button>
        <button id="vl-survey-later"
          style="width:100%;padding:12px;border-radius:13px;cursor:pointer;background:transparent;color:var(--vl-ink-2);border:1px solid var(--vl-line-2);font-size:13.5px;font-weight:600;font-family:inherit">아직 안 했어요</button>
      </div>
      <p style="margin:12px 0 0;font-size:11px;color:var(--vl-ink-3);text-align:center;line-height:1.5">완료를 누르기 전까지 이 안내가 계속 표시돼요.</p>
    </div>
  </div>`;
}

window.screenOnboarding = screenOnboarding;
window.bindOnboarding = bindOnboarding;
window.screenToday = screenToday;
window.screenFeedback = screenFeedback;
window.screenControlHome = screenControlHome;
window.screenSurveyModal = screenSurveyModal;
