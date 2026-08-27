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
    const group = check.group || parsed.group;

    // 이 참여코드로 이미 등록된 이력이 있으면(TEST 코드는 서버가 항상 false를
    // 반환) 바로 신규 등록하지 않고 재설치 복구 여부를 먼저 확인한다.
    if (check.previouslyRegistered) {
      showRecoverConfirm(group, parsed.code);
      return;
    }
    onSubmit({ group, code: parsed.code });
  }

  // "이전에 설치한 적이 있는 [코드]님이 맞습니까?" 확인 모달 — "예"면 서버에서 기존
  // anonymousId/installDate를 복구해 그대로 쓰고, "아니오"/복구 실패 시 신규 등록으로 진행한다.
  function showRecoverConfirm(group, code) {
    root.insertAdjacentHTML("beforeend", screenRecoverConfirmModal(code));
    const modal = root.querySelector("#vl-recover-modal");
    const yesBtn = modal.querySelector("#vl-recover-yes");
    const noBtn = modal.querySelector("#vl-recover-no");

    noBtn.addEventListener("click", () => {
      modal.remove();
      onSubmit({ group, code });
    });

    yesBtn.addEventListener("click", async () => {
      yesBtn.disabled = true;
      yesBtn.textContent = "확인하는 중…";
      const recovered = window.recoverParticipant
        ? await window.recoverParticipant(code)
        : null;
      modal.remove();
      if (!recovered) {
        // 서버에 등록 이력이 없거나(경쟁 상태 등) 오프라인 — 조용히 신규 등록으로 폴백(6절).
        onSubmit({ group, code });
        return;
      }
      onSubmit({ group: recovered.group_code || group, code, recovered });
    });
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

// 실제 LLM 리뷰인지(플레이스홀더·빈 값 제외) — feedbackViewed 판정용.
// popup·Studio 양쪽에서 쓰이므로(Studio는 viewlens-popup.js를 로드하지 않음) 여기 둔다.
const POPUP_PLACEHOLDER_REVIEWS = new Set([
  "시청 패턴을 분석하고 있어요. 잠시 후 시청 분석이 업데이트돼요.",
]);
function isRealReview(text) {
  return (
    typeof text === "string" &&
    text.trim() !== "" &&
    !POPUP_PLACEHOLDER_REVIEWS.has(text.trim())
  );
}

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
  // 잠금 상태는 VL._todayCumulative에서 읽는다.
  // d(VL.today, sessions 기준)에서 따로 계산하면 세션 종료 시 두 storage 갱신 사이의 간극 동안 블러 없이 새 리뷰가 잠깐 보이는 경합이 생긴다
  const reviewLocked = isToday && !!VL._todayCumulative?.locked;
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
        <div style="font-size:13px;font-weight:700;color:var(--vl-ink-2)">${isToday ? "오늘" : d.dateLabel}</div>
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

    ${_todayCumulativeCard(isToday, d, reviewLocked)}
  </div>
  </div>`;
}

// "오늘" 하루 전체를 반영하는 누적 리뷰 카드
// 오늘은 서버의 today_reviews 캐시(VL._todayCumulative)를 쓰고, 과거 날짜는
// buildDataForDate가 그 날의 마지막 세션에서 이미 캡처해 둔 review 스냅샷(d.review)을
// 그대로 보여준다.
function _todayCumulativeCard(isToday, d, locked) {
  if (!isToday) {
    if (!isRealReview(d.review)) return "";
    return vlReview({
      title: `${d.dateLabel} 돌아보기`,
      text: d.review,
      topic: d.reviewTopic || "",
      videos: d.videos,
      locked: false,
      sessionId: d.sessionId ?? null,
    });
  }

  const cumulative = VL._todayCumulative;
  if (!cumulative?.eligible) return "";

  return vlReview({
    title: "오늘 하루 돌아보기",
    text: cumulative.generating
      ? "오늘 하루 전체 시청을 분석하고 있어요. 잠시 후 업데이트돼요."
      : cumulative.review || "",
    topic: cumulative.generating ? "" : cumulative.reviewTopic || "",
    videos: d.videos,
    locked: !!locked && !cumulative.generating,
    sessionId: cumulative.sessionId ?? null,
  });
}

// ── Feedback ──────────────────────────────────────────────────────────────────

function screenFeedback(currentWeek, selWeek) {
  const w = VL.weeks[selWeek - 1];
  const prevW = selWeek >= 2 ? VL.weeks[selWeek - 2] : null;
  const vsPrev = prevW ? w.entropy - prevW.entropy : 0;

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
        ${locked ? `${VL.periodLabel(wk.week)} 공개` : ""}
      </span>
    </button>`;
    })
    .join("");

  const vsBaseContent = prevW
    ? `<div>
        <div style="font-size:11.5px;color:var(--vl-ink-3);margin-bottom:4px">직전 기간(${prevW.label}) 대비</div>
        <div style="display:flex;align-items:center;gap:7px">
          ${vlDeltaChip({ value: vsPrev })}
          <span style="font-size:12px;color:var(--vl-ink-2)">${vsPrev >= 0 ? "더 다양해요" : "덜 다양해요"}</span>
        </div>
      </div>`
    : `<p style="margin:0;font-size:12px;line-height:1.55;color:var(--vl-ink-2)">첫 기간이라 비교할 데이터가 없어요.</p>`;

  const baselineLegend = !w.isBaseline
    ? `
    <div style="display:flex;align-items:center;gap:5px;margin-top:7px">
      <span style="width:14px;height:0;border-top:1px dashed var(--vl-ink-3)"></span>
      <span style="font-size:10.5px;color:var(--vl-ink-3)">점선 = 기준값 ${VL.baselineH.toFixed(2)}</span>
    </div>`
    : "";

  return `<div style="padding:16px 16px 22px;display:flex;flex-direction:column;gap:14px">
    <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:2px" id="vl-week-btns">${weekBtns}</div>

    <div style="display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-size:16px;font-weight:800;color:var(--vl-ink)">
          ${w.label} 리포트
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
        ${vlMiniLine({
          // 기간이 1일뿐이면 점 하나라 선을 못 그림(내부에서 0으로 나눠 깨짐) — 같은 값을
          // 2번 넣어 평평한 선으로라도 표시(테스트 기간 한정 임시 처리, 실제 연구 땐 불필요).
          data:
            w.daily.length > 1 ? w.daily : [w.daily[0] ?? 0, w.daily[0] ?? 0],
          baseline: w.isBaseline ? null : VL.baselineH,
        })}
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
        // 베이스라인 중인 EXP에게만 보여주는 한 줄 — CON은 종료 후 일괄 제공(10-10)이라
        // "언제부터 분석을 받는지"라는 개념 자체가 없어 stats.baselineDaysLeft가 null로 온다.
        stats.baselineDaysLeft != null
          ? `<p style="margin:8px auto 0;max-width:250px;font-size:12.5px;line-height:1.6;color:var(--vl-accent);font-weight:600;text-wrap:pretty">
        ${stats.baselineDaysLeft}일 뒤부터 나만의 시청 분석을 받아볼 수 있어요.
      </p>`
          : ""
      }
    `,
    })}

    ${vlCard({ pad: 0, children: `<div style="display:grid;grid-template-columns:1fr 1fr">${gridCells}</div>` })}

    ${
      // 종료 안내 모달을 이미 본 뒤엔 이 자리가 상시 재진입 CTA로 바뀐다.
      stats.studyEndCtaReady
        ? `<button id="vl-study-end-cta" style="display:flex;align-items:center;justify-content:space-between;gap:9px;padding:15px 16px;background:var(--vl-accent-soft);border:1px solid color-mix(in oklab,var(--vl-accent) 30%,transparent);border-radius:13px;cursor:pointer;font-family:inherit;text-align:left">
        <span style="font-size:13px;font-weight:700;color:var(--vl-accent)">6주간의 시청 리뷰가 준비됐어요</span>
        <span style="font-size:15px;color:var(--vl-accent);flex-shrink:0">→</span>
      </button>`
        : `<div style="display:flex;align-items:flex-start;gap:9px;padding:13px 14px;background:var(--vl-card-2);border:1px solid var(--vl-line);border-radius:13px">
      <div style="width:25px;height:25px;border-radius:7px;background:var(--vl-accent-soft);color:var(--vl-accent);display:grid;place-items:center;flex-shrink:0;margin-top:1px">
        ${_lockIcon(15)}
      </div>
      <p style="margin:0;font-size:11.5px;line-height:1.55;color:var(--vl-ink-2);text-wrap:pretty">
        실험 기간 중 피드백 제공 시점은 참여자마다 다를 수 있으며, 실험 종료 후 모든 참여자에게 결과를 공유합니다.
      </p>
    </div>`
    }
  </div>`;
}

// ── Study end code input ───────────────────────────────────────

function screenStudyEndCodeInput() {
  return `<div style="padding:34px 22px 26px;display:flex;flex-direction:column;min-height:100%;box-sizing:border-box">
    <div style="display:flex;flex-direction:column;align-items:center;text-align:center;margin-top:8px">
      ${markSVG({ size: 52, accent: "var(--vl-accent)" })}
      <div style="margin-top:16px;font-size:17px;font-weight:800;letter-spacing:-0.02em;color:var(--vl-ink)">시청 기록 리뷰 열람</div>
      <p style="margin:9px 0 0;font-size:13px;line-height:1.6;color:var(--vl-ink-2);text-wrap:pretty">설문에서 안내받은 코드를 입력해 주세요.</p>
    </div>

    <div style="margin-top:32px">
      <label style="font-size:12px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:var(--vl-ink-3)">코드</label>
      <input id="vl-study-end-code-input" value="" placeholder="설문에서 안내받은 코드" spellcheck="false" autocomplete="off"
        style="display:block;margin-top:9px;width:100%;box-sizing:border-box;padding:13px 15px;
          border:1.5px solid var(--vl-line-2);border-radius:13px;background:var(--vl-card-2);
          color:var(--vl-ink);outline:none;
          font-size:13px; letter-spacing:0.1em;text-transform:uppercase"/>
      <p id="vl-study-end-code-err" style="display:none;margin:9px 2px 0;font-size:12px;color:var(--vl-warn);line-height:1.5"></p>
      <button id="vl-study-end-code-btn"
        style="margin-top:14px;width:100%;padding:13px;border:none;border-radius:13px;
          background:var(--vl-accent);color:var(--vl-on-accent);font-size:14.5px;
          font-weight:700;cursor:pointer;font-family:inherit">확인</button>
    </div>
  </div>`;
}

// ── Study end notice modal ───────────────────────────────────────

// 종료 안내(그룹 무관) — 연구 종료 시점(시간 기준)에 최초 1회만 노출된다.
function screenStudyEndNoticeModal() {
  return vlConfirmModal({
    icon: markSVG({ size: 26, filled: false, accent: "var(--vl-accent)" }),
    title: "연구 기간이 종료되었습니다",
    message:
      "지금까지 참여해주셔서 감사합니다. 연구자로부터 곧 설문을 받게 되실 겁니다. 설문 완료 후 보상 규정에 맞는 참여율을 보이셨다면 보상이 제공될 예정입니다.",
    confirmLabel: "확인",
    confirmId: "vl-study-end-notice-confirm",
  });
}

// ── Past-day reveal modal (자정 경계 처리) ───────────────────────────────────────

// 하루가 지나면 그 전날의 "봉인된" 마지막 리뷰를 1회 리빌 애니메이션과 함께 보여준다.
// 별도 캡처 로직 없이 buildDataForDate가 이미 계산해 둔 그 날짜 데이터를 그대로 재사용한다.
function screenPastDayRevealModal(pastDay) {
  return `<div style="position:absolute;inset:0;z-index:20;display:flex;align-items:flex-end;justify-content:center;padding:16px;background:color-mix(in oklab,var(--vl-ink) 45%,transparent)">
    <div style="width:100%;max-height:88%;overflow-y:auto;background:var(--vl-card);border-radius:18px;padding:18px 16px 16px;box-shadow:0 -12px 40px -8px rgba(0,0,0,.35);animation:vlSheet .35s ease-out">
      ${vlReview({
        title: `${pastDay.dateLabel} 돌아보기`,
        text: pastDay.review,
        topic: pastDay.reviewTopic,
        videos: pastDay.videos,
        locked: false,
        id: "vl-reveal-review-card",
      })}
      <button id="vl-reveal-dismiss" style="margin-top:14px;width:100%;padding:13px;border:none;border-radius:13px;background:var(--vl-accent);color:var(--vl-on-accent);font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">확인했어요</button>
    </div>
  </div>`;
}

// ── Recover confirm modal (Story 10-10, 이슈 4) ─────────────────────────────────

// 온보딩 중 재설치 확인 모달 — 참여코드가 이미 등록된 이력이 있을 때만 노출된다
// (노출 여부는 bindOnboarding의 previouslyRegistered 분기가 판정). code는 사용자 입력을
// 그대로 화면에 표시하므로 vlEscapeHtml로 이스케이프한다.
function screenRecoverConfirmModal(code) {
  return `<div id="vl-recover-modal" style="position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in oklab,var(--vl-ink) 45%,transparent)">
    <div style="width:100%;background:var(--vl-card);border-radius:18px;padding:26px 22px 22px;box-shadow:0 24px 60px -12px rgba(0,0,0,.4);text-align:center">
      <div style="width:52px;height:52px;margin:0 auto;border-radius:50%;background:var(--vl-accent-soft);display:grid;place-items:center">
        ${markSVG({ size: 26, filled: false, accent: "var(--vl-accent)" })}
      </div>
      <div style="margin-top:16px;font-size:16px;font-weight:800;color:var(--vl-ink);letter-spacing:-0.02em">이전에 설치한 적이 있는<br/>${vlEscapeHtml(code)}님이 맞습니까?</div>
      <p style="margin:9px 0 0;font-size:13px;line-height:1.6;color:var(--vl-ink-2);text-wrap:pretty">
        맞다면 이전 기록을 그대로 이어서 확인할 수 있어요.
      </p>
      <div style="margin-top:20px;display:flex;flex-direction:column;gap:8px">
        <button id="vl-recover-yes" style="padding:13px;border:none;border-radius:13px;background:var(--vl-accent);color:var(--vl-on-accent);font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">예, 맞아요</button>
        <button id="vl-recover-no" style="padding:12px;border:none;border-radius:13px;background:transparent;color:var(--vl-ink-3);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">아니오, 처음이에요</button>
      </div>
    </div>
  </div>`;
}

// popup·Studio 양쪽에서 쓰는 헬퍼라 이 파일에는 호출부가 없을 수 있다(no-unused-vars 방지).
window.isRealReview = isRealReview;
window.screenOnboarding = screenOnboarding;
window.bindOnboarding = bindOnboarding;
window.screenToday = screenToday;
window.screenFeedback = screenFeedback;
window.screenControlHome = screenControlHome;
window.screenStudyEndCodeInput = screenStudyEndCodeInput;
window.screenStudyEndNoticeModal = screenStudyEndNoticeModal;
window.screenPastDayRevealModal = screenPastDayRevealModal;
window.screenRecoverConfirmModal = screenRecoverConfirmModal;
