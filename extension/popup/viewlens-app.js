function _collectingTimerText() {
  const lastWatchedAt = VL._lastWatchedAt;
  if (!lastWatchedAt) return "";
  const TIMEOUT_MS = 10 * 60 * 1000;
  const elapsed = Date.now() - new Date(lastWatchedAt).getTime();
  const remaining = Math.max(0, TIMEOUT_MS - elapsed);
  if (remaining <= 0) return "";
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  return `피드백까지 ${mins}분 ${String(secs).padStart(2, "0")}초`;
}

// 대조군 홈 — 실제 세션 데이터 기반 총 누적 시청 영상 수 (진행 중 세션 포함).
function _controlTotalCount() {
  const sessions = VL._allSessions || [];
  const ended = sessions.reduce(
    (sum, s) => sum + (s.videoCount ?? s.videos?.length ?? 0),
    0,
  );
  return ended + (VL.today?.collectingCount ?? 0);
}

// 대조군 홈 — 오늘 시청한 영상 수 (오늘 종료된 세션 + 진행 중 세션).
function _controlTodayCount() {
  const sessions = VL._allSessions || [];
  const todayStr = new Date().toDateString();
  const ended = sessions.reduce(
    (sum, s) =>
      sum +
      (s.endTime && new Date(s.endTime).toDateString() === todayStr
        ? (s.videoCount ?? s.videos?.length ?? 0)
        : 0),
    0,
  );
  return ended + (VL.today?.collectingCount ?? 0);
}

// 설치일(installDate) 기준 실제 경과일(1일째부터). installDate가 없으면 목업 day로 폴백.
function _elapsedDay(fallback) {
  if (!VL._installDate) return fallback;
  const t = new Date(VL._installDate).getTime();
  if (!Number.isFinite(t)) return fallback; // 손상된 installDate → NaN 방지
  const d = Math.floor((Date.now() - t) / 86400000) + 1;
  return Math.max(1, d);
}

// Studio 전용 — "설치 N일째"를 오늘 기준 installDate로 역산한다(_elapsedDay의 역함수).
// 이렇게 만든 installDate를 mount/update에 넘기면 _isFeedbackActive의 베이스라인 게이트가
// Studio에서 고른 타임라인 시점을 실제 사용자처럼 그대로 반영한다.
function _installDateForDay(day) {
  return new Date(Date.now() - (day - 1) * 86400000).toISOString();
}

// 대조군 종료 후 리뷰 열람 게이트 — 시간(연구 기간 종료) 기준만 본다.
function _isStudyEndReviewReady(groupCfg, installDate) {
  return VL.isConGroup(groupCfg.code) && VL.isStudyEnded(installDate);
}

// 대조군 6주 리뷰 화면 상단에 붙는 뒤로가기 행
function _studyEndBackRow() {
  return `<div style="padding:12px 16px 0">
    <button id="vl-study-end-back" style="display:flex;align-items:center;gap:5px;padding:5px 2px;border:none;background:transparent;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:700;color:var(--vl-ink-2)">‹ 홈으로</button>
  </div>`;
}

function _popupHeader(groupCfg, day) {
  const isTest = groupCfg.code.startsWith("TEST");
  const badge = isTest
    ? vlBadge({ text: "연구자 모드", tone: "accent", size: "sm" })
    : vlBadge({ text: "참여 중", tone: "neutral", size: "sm" });
  const rightArea = isTest
    ? `<div style="display:flex;align-items:center;gap:7px">
        <button id="vl-researcher-reset" style="padding:3px 8px;border:1px solid var(--vl-line-2);border-radius:6px;background:transparent;cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;color:var(--vl-ink-2);line-height:1.7;white-space:nowrap">↩ 온보딩</button>
        ${badge}
      </div>`
    : badge;
  return `<div style="padding:13px 16px;border-bottom:1px solid var(--vl-line);display:flex;align-items:center;justify-content:space-between;background:var(--vl-card);position:sticky;top:0;z-index:10">
    <div style="display:flex;align-items:center;gap:9px">
      ${markSVG({ size: 26, accent: "var(--vl-accent)" })}
      <div style="display:flex;flex-direction:column;line-height:1.1">
        <span style="font-size:15px;font-weight:800;letter-spacing:-0.02em;color:var(--vl-ink)">View<span style="color:var(--vl-accent)">Lens</span></span>
        <span style="font-size:10.5px;color:var(--vl-ink-3);margin-top:2px">설치 ${day}일째 · 종료 D-${Math.max(0, VL.TOTAL_DAYS - day)}</span>
      </div>
    </div>
    ${rightArea}
  </div>`;
}

function _tabs(activeTab, needsConfirmNudge = false) {
  const list = [
    { id: "today", label: "오늘" },
    {
      id: "feedback",
      label:
        VL.DAYS_PER_PERIOD === 1
          ? "일별 피드백"
          : VL.DAYS_PER_PERIOD === 7
            ? "주차별 피드백"
            : "기간별 피드백",
    },
  ];
  return `<div style="display:flex;gap:4px;padding:10px 16px 0;background:var(--vl-card)">
    ${list
      .map((t) => {
        const on = t.id === activeTab;
        // 오늘 탭에 미확인 피드백이 있는데 지금 다른 탭을 보고 있으면 살짝 깜빡이는 점으로 알린다.
        const nudge =
          t.id === "today" && !on && needsConfirmNudge
            ? `<span style="display:inline-block;width:6px;height:6px;margin-left:5px;border-radius:50%;background:var(--vl-accent);vertical-align:middle;animation:vlBlink 1.4s ease-in-out infinite"></span>`
            : "";
        return `<button data-tab="${t.id}" style="flex:1;padding:9px 6px 11px;border:none;background:transparent;cursor:pointer;font-family:inherit;font-size:13px;font-weight:700;color:${on ? "var(--vl-accent)" : "var(--vl-ink-3)"};border-bottom:2px solid ${on ? "var(--vl-accent)" : "transparent"};transition:color .15s">${t.label}${nudge}</button>`;
      })
      .join("")}
  </div>`;
}

// ── ViewLensPopup class ───────────────────────────────────────────────────────

class ViewLensPopup {
  /**
   * @param {HTMLElement} container - The popup root element
   */
  constructor(container) {
    this.container = container;
    this._tab = "today";
    this._selWeek = 1;
    this._selectedDate = new Date();
    // 대조군 종료 후 리뷰 화면 보기 상태
    this._studyEndReviewOpen = false;
    // "어제 돌아보기" 리빌 모달을 이번 팝업 세션 안에서 이미 닫았는지
    this._pastDayRevealDismissed = false;
    // External app state (set via mount)
    this._onboarded = false;
    this._group = null;
    this._timelineKey = "w1_mid";
    this._installDate = null;
    this._onChange = () => {};
  }

  /**
   * Mount with external state.
   * @param {object} opts
   * @param {boolean}  opts.onboarded
   * @param {string}   opts.group
   * @param {string}   opts.timelineKey
   * @param {string}   [opts.installDate] - ISO 문자열. RealPopup의 베이스라인 게이트가 참조한다.
   * @param {Function} opts.onChange - called with { onboarded, group } on onboard submit
   */
  mount({ onboarded, group, timelineKey, installDate, onChange }) {
    this._onboarded = onboarded;
    this._group = group;
    this._timelineKey = timelineKey;
    this._installDate = installDate ?? null;
    this._onChange = onChange;
    this._studyEndReviewOpen = false;
    this.render();
  }

  /** Called by Studio when tweaks change */
  update({ onboarded, group, timelineKey, installDate }) {
    this._onboarded = onboarded;
    this._group = group;
    this._timelineKey = timelineKey;
    this._installDate = installDate ?? null;
    this._studyEndReviewOpen = false;
    this.render();
  }

  // 10-8: 그룹이 EXP여도 베이스라인 기간(설치 후 14일 미만)에는 피드백을 노출하지 않는다.
  // TEST-EXP(연구자 모드)는 예외(VL.isTestGroup). 실제 팝업과 Studio 프리뷰가
  // 이 하나의 구현을 공유한다 — Studio는 선택한 타임라인 시점에 맞는 installDate를 계산해
  // mount/update에 넘겨줘서(_installDateForDay), 실제 사용자가 그 시점에 보는 화면을 그대로 재현한다.
  _isFeedbackActive(groupCfg) {
    return (
      groupCfg.feedback &&
      (VL.isTestGroup(groupCfg.code) || !VL.isBaselinePeriod(this._installDate))
    );
  }

  render() {
    if (!this._onboarded || !this._group) {
      this._renderOnboarding();
      return;
    }
    const tl = VL.TIMELINE[this._timelineKey] || VL.TIMELINE.w1_mid;
    const day = _elapsedDay(tl.day);
    const groupCfg = VL.GROUPS[this._group] || VL.GROUPS.EXP;
    const totalWeeks = VL.TOTAL_WEEKS;
    const currentWeek = Math.min(
      totalWeeks,
      Math.max(1, Math.ceil(day / VL.DAYS_PER_PERIOD)),
    );
    const selWeek = Math.min(this._selWeek, currentWeek);

    if (this._tab === "today") {
      const d = buildDataForDate(VL._allSessions || [], this._selectedDate);
      const isToday =
        this._selectedDate.toDateString() === new Date().toDateString();
      d.collectingCount = isToday ? (VL.today?.collectingCount ?? 0) : 0;
      d.collectingTimer = isToday ? _collectingTimerText() : "";
      VL.today = d;
    }

    const feedbackActive = this._isFeedbackActive(groupCfg);
    // 대조군 종료 후 6주 리뷰 열람(Story 10-10) — _isFeedbackActive와 독립된 축이라
    // feedbackActive가 false인 경로 안에서만 추가로 분기한다.
    const studyEndReady = _isStudyEndReviewReady(groupCfg, this._installDate);
    const showStudyEndModal = studyEndReady && !VL._studyEndModalShown;
    // 모달을 이미 본 뒤에만 CTA로 전환한다.
    const showStudyEndCta = studyEndReady && !!VL._studyEndModalShown;
    // "어제 돌아보기" 리빌
    const showPastDayReveal =
      !!VL._revealPastDay && !this._pastDayRevealDismissed;

    let bodyHTML;
    if (feedbackActive) {
      bodyHTML =
        this._tab === "today"
          ? screenToday()
          : screenFeedback(currentWeek, selWeek);
    } else if (studyEndReady && this._studyEndReviewOpen) {
      // currentWeek는 day(경과일)로 계산되는데, studyEndReady가 참이면 이미 day >= TOTAL_DAYS라
      bodyHTML = _studyEndBackRow() + screenFeedback(currentWeek, selWeek);
    } else {
      // 10-8: groupCfg.feedback이 true인데 feedbackActive가 false라는 건 "EXP인데 베이스라인
      // 게이트에 걸렸다"는 뜻이다(CON은 애초에 groupCfg.feedback이 false). 이 경우에만
      // "베이스라인 이후부터 분석을 받는다"는 안내를 추가한다 — CON에게는 해당 없는 개념.
      // day는 1일째부터 세는 이산값이라, 베이스라인 마지막 날(day=BASELINE_DAYS)에도 아직
      // 하루가 남은 것(내일인 BASELINE_DAYS+1일째부터 게이트가 풀림) — +1을 더해야
      // isBaselinePeriod의 실제 전환 시점과 표시되는 D-N이 어긋나지 않는다.
      const baselineDaysLeft = groupCfg.feedback
        ? Math.max(0, VL.BASELINE_DAYS - day + 1)
        : null;
      bodyHTML = screenControlHome(day, {
        todayCount: _controlTodayCount(),
        totalCount: _controlTotalCount(),
        baselineDaysLeft,
        studyEndCtaReady: showStudyEndCta,
      });
    }

    this.container.innerHTML = `<div style="position:relative;height:100%;display:flex;flex-direction:column;background:var(--vl-bg)">
      ${_popupHeader(groupCfg, day)}
      ${feedbackActive ? _tabs(this._tab, !VL._todayConfirmed) : ""}
      <div style="flex:1;overflow-y:auto;overflow-x:hidden">${bodyHTML}</div>
      ${showStudyEndModal ? screenStudyEndModal() : ""}
      ${showPastDayReveal ? screenPastDayRevealModal(VL._revealPastDay.data) : ""}
    </div>`;

    this._bind(groupCfg, currentWeek);
  }

  _renderOnboarding() {
    this.container.innerHTML = `<div style="height:100%;overflow-y:auto;background:var(--vl-bg)">${screenOnboarding()}</div>`;
    bindOnboarding(this.container, ({ group, code, recovered }) => {
      this._onboarded = true;
      this._group = group;
      this._onChange({
        onboarded: true,
        group,
        participantCode: code,
        recovered,
      });
      this.render();
    });
  }

  _bind(groupCfg, currentWeek) {
    // Tabs
    if (this._isFeedbackActive(groupCfg)) {
      this.container.querySelectorAll("[data-tab]").forEach((btn) => {
        btn.addEventListener("click", () => {
          this._tab = btn.dataset.tab;
          this.render();
        });
      });
    }
    // Week buttons
    this.container
      .querySelectorAll("#vl-week-btns [data-week]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const w = parseInt(btn.dataset.week, 10);
          if (w <= currentWeek) {
            this._selWeek = w;
            this.render();
          }
        });
      });
    // Date navigation
    const prevBtn = this.container.querySelector("#vl-date-prev");
    const nextBtn = this.container.querySelector("#vl-date-next");
    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        const d = new Date(this._selectedDate);
        d.setDate(d.getDate() - 1);
        const installDate = VL._installDate ? new Date(VL._installDate) : null;
        if (!installDate || d >= new Date(installDate.toDateString())) {
          this._selectedDate = d;
          this.render();
        }
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        const today = new Date();
        if (this._selectedDate.toDateString() !== today.toDateString()) {
          const d = new Date(this._selectedDate);
          d.setDate(d.getDate() + 1);
          this._selectedDate = d;
          this.render();
        }
      });
    }
    // 대조군 종료 안내 모달 — "지금 확인하기"는 리뷰 화면까지 바로 연다.
    const studyEndConfirm = this.container.querySelector(
      "#vl-study-end-modal-confirm",
    );
    if (studyEndConfirm) {
      studyEndConfirm.addEventListener("click", () => {
        VL._studyEndModalShown = true;
        this._studyEndReviewOpen = true;
        this.render();
      });
    }
    const studyEndLater = this.container.querySelector(
      "#vl-study-end-modal-later",
    );
    if (studyEndLater) {
      studyEndLater.addEventListener("click", () => {
        VL._studyEndModalShown = true;
        this.render();
      });
    }
    // 대조군 6주 리뷰 화면 → 대기 화면으로 돌아가기
    const studyEndBack = this.container.querySelector("#vl-study-end-back");
    if (studyEndBack) {
      studyEndBack.addEventListener("click", () => {
        this._studyEndReviewOpen = false;
        this.render();
      });
    }
    // 대조군 상시 CTA(모달을 이미 본 뒤 재진입) — 목적지는 모달의 "지금 확인하기"와 동일.
    const studyEndCta = this.container.querySelector("#vl-study-end-cta");
    if (studyEndCta) {
      studyEndCta.addEventListener("click", () => {
        this._studyEndReviewOpen = true;
        this.render();
      });
    }
    // "어제 돌아보기" 리빌 모달 닫기
    const revealDismiss = this.container.querySelector("#vl-reveal-dismiss");
    if (revealDismiss) {
      revealDismiss.addEventListener("click", () => {
        this._pastDayRevealDismissed = true;
        this.render();
      });
    }
    // 연구자 모드 전용 — 온보딩 화면으로 돌아가기
    const researcherReset = this.container.querySelector(
      "#vl-researcher-reset",
    );
    if (researcherReset) {
      researcherReset.addEventListener("click", () => {
        this._onboarded = false;
        this._group = null;
        this._onChange({ onboarded: false, group: null });
        this.render();
      });
    }
  }
}

// ── Studio (browser mock + tweaks panel) ─────────────────────────────────────

class Studio {
  constructor(rootEl) {
    this._root = rootEl;
    this._state = {
      tone: "indigo",
      dark: false,
      group: "EXP",
      onboarded: true,
      timeline: "w2_mid",
    };
    this._popup = null;
    this._panel = null;
    this._render();
    this._buildPanel();
    this._applyTokens();
  }

  _setState(updates) {
    Object.assign(this._state, updates);
    this._applyTokens();
    if (this._popup) {
      const tl = VL.TIMELINE[this._state.timeline] || VL.TIMELINE.w1_mid;
      this._popup.update({
        onboarded: this._state.onboarded,
        group: this._state.group,
        timelineKey: this._state.timeline,
        installDate: _installDateForDay(tl.day),
      });
    }
  }

  _applyTokens() {
    const tone = VL.TONES[this._state.tone] || VL.TONES.indigo;
    const tokens = this._state.dark ? tone.dark : tone.light;
    const popEl = document.getElementById("vl-popup-root");
    if (!popEl) return;
    Object.entries(tokens).forEach(([k, v]) => popEl.style.setProperty(k, v));
  }

  _render() {
    const accent = (VL.TONES[this._state.tone] || VL.TONES.indigo).light[
      "--vl-accent"
    ];

    this._root.innerHTML = `
      <div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 24px 120px;gap:30px">
        <!-- brand header -->
        <div style="width:960px;max-width:100%;display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap">
          ${wordmarkHTML({ size: 26, accent, sub: "YouTube Bias Feedback" })}
          <div style="text-align:right;max-width:360px">
            <div style="font-size:13px;font-weight:700;color:#3a3531">시청 편향 피드백 · 크롬 확장 프로그램</div>
            <div style="font-size:12px;color:#8a837c;margin-top:3px;line-height:1.5">세션별 카테고리 다양성(Shannon Entropy)을 분석해 명확한 시청 분석으로 돌려줍니다.</div>
          </div>
        </div>

        <!-- browser mock -->
        <div id="vl-browser-mock" style="width:960px;max-width:100%;border-radius:14px;overflow:hidden;background:#2b2c2f;box-shadow:0 40px 90px -30px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.08)">
          <!-- tab strip -->
          <div style="height:42px;background:#202124;display:flex;align-items:center;padding-left:14px;gap:8px">
            <div style="display:flex;gap:8px">
              ${["#ff5f57", "#febc2e", "#28c840"].map((c) => `<span style="width:12px;height:12px;border-radius:50%;background:${c}"></span>`).join("")}
            </div>
            <div style="margin-left:14px;height:30px;align-self:flex-end;background:#35363a;border-radius:9px 9px 0 0;padding:0 14px;display:flex;align-items:center;gap:8px;font-size:12.5px;color:#e8eaed;max-width:230px">
              <span style="width:13px;height:13px;border-radius:3px;background:#ff0033"></span>
              <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">YouTube</span>
            </div>
          </div>
          <!-- toolbar -->
          <div style="height:46px;background:#35363a;display:flex;align-items:center;gap:6px;padding:0 12px">
            <span style="color:#9aa0a6;font-size:17px;opacity:.7">‹</span>
            <span style="color:#9aa0a6;font-size:17px;opacity:.35">›</span>
            <span style="color:#9aa0a6;font-size:14px;opacity:.7;margin-left:2px">⟳</span>
            <div style="flex:1;height:30px;border-radius:16px;background:#202124;display:flex;align-items:center;gap:8px;padding:0 14px;margin:0 8px">
              <span style="width:11px;height:11px;border-radius:50%;border:1.5px solid #9aa0a6;opacity:.6"></span>
              <span style="color:#c9ccd1;font-size:12.5px;">youtube.com<span style="color:#9aa0a6">/watch?v=dQw4w9WgXcQ</span></span>
            </div>
            <!-- extension icon -->
            <div style="width:28px;height:28px;border-radius:8px;display:grid;place-items:center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 4a2 2 0 1 1 4 0h3v3a2 2 0 1 0 0 4v3h-3a2 2 0 1 0-4 0H7v-3a2 2 0 1 1 0-4V4h3Z" stroke="#9aa0a6" stroke-width="1.6" stroke-linejoin="round"/></svg>
            </div>
            <div style="width:28px;height:28px;border-radius:8px;display:grid;place-items:center;background:rgba(234,88,12,.18);box-shadow:0 0 0 1px rgba(234,88,12,.45)">
              ${markSVG({ size: 20, accent })}
            </div>
            <span style="width:22px;height:22px;border-radius:50%;margin-left:4px;display:inline-block;background:linear-gradient(135deg,#8a6cff,#ff8a5c)"></span>
          </div>
          <!-- webpage backdrop + popup -->
          <div style="position:relative;height:612px;background:#ffffff;overflow:hidden">
            <!-- yt skeleton -->
            <div style="position:absolute;inset:0;padding:22px;opacity:.5">
              <div style="display:flex;gap:18px">
                <div style="width:150px;display:flex;flex-direction:column;gap:12px">
                  ${Array.from({ length: 6 }, (_, i) => `<div style="height:12px;border-radius:6px;background:#e5e5e5;width:${90 - i * 8}%"></div>`).join("")}
                </div>
                <div style="flex:1;display:grid;grid-template-columns:repeat(3,1fr);gap:16px">
                  ${Array.from(
                    { length: 9 },
                    () => `
                    <div>
                      <div style="aspect-ratio:16/9;border-radius:10px;background:#ececec"></div>
                      <div style="height:9px;border-radius:5px;background:#e5e5e5;margin:9px 0 5px;width:85%"></div>
                      <div style="height:8px;border-radius:5px;background:#ececec;width:55%"></div>
                    </div>
                  `,
                  ).join("")}
                </div>
              </div>
            </div>
            <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,0) 60%,rgba(255,255,255,.5))"></div>
            <!-- popup caret -->
            <div style="position:absolute;top:-1px;right:86px;width:0;height:0;border-left:9px solid transparent;border-right:9px solid transparent;border-bottom:10px solid var(--vl-card);filter:drop-shadow(0 -2px 2px rgba(0,0,0,.1));z-index:5"></div>
            <!-- the popup -->
            <div style="position:absolute;top:9px;right:18px;z-index:4">
              <div id="vl-popup-root" class="vl-pop"
                style="width:384px;height:600px;border-radius:16px;overflow:hidden;position:relative;font-family:Pretendard,system-ui,sans-serif;box-shadow:0 24px 60px -12px rgba(0,0,0,.5),0 0 0 1px rgba(0,0,0,.06)">
              </div>
            </div>
          </div>
        </div>

        <div style="font-size:12px;color:#9a938c;;letter-spacing:.04em">
          오른쪽 아래 <b id="vl-tweaks-hint" style="cursor:pointer">Tweaks ▲</b> 패널에서 톤 · 그룹 · 실험 시점을 바꿔 보세요
        </div>
      </div>
    `;

    // wire popup hint click to toggle panel
    const hint = document.getElementById("vl-tweaks-hint");
    if (hint)
      hint.addEventListener("click", () => {
        if (this._panel) this._panel.toggle();
      });

    // mount popup
    const popEl = document.getElementById("vl-popup-root");
    this._popup = new ViewLensPopup(popEl);
    const initialTl = VL.TIMELINE[this._state.timeline] || VL.TIMELINE.w1_mid;
    this._popup.mount({
      onboarded: this._state.onboarded,
      group: this._state.group,
      timelineKey: this._state.timeline,
      installDate: _installDateForDay(initialTl.day),
      onChange: ({ onboarded, group }) => {
        this._state.onboarded = onboarded;
        this._state.group = group;
        if (this._panel) this._panel._syncControls();
      },
    });
  }

  _buildPanel() {
    const tl = VL.TIMELINE;
    this._panel = new TweaksPanel({
      title: "Tweaks",
      defaults: this._state,
      onChange: (key, value) => {
        this._setState({ [key]: value });
      },
    });

    this._panel
      .addSection("디자인")
      .addToggle("다크 모드", "dark")
      .addSection("참여 · 그룹")
      .addRadio(
        "그룹",
        "group",
        Object.entries(VL.GROUPS).map(([k, v]) => ({
          value: k,
          label: v.name,
        })),
      )
      .addButton(
        "온보딩 다시 보기",
        () => this._setState({ onboarded: false }),
        true,
      )
      .addSection("실험 시점")
      .addSelect(
        "시점",
        "timeline",
        Object.entries(tl).map(([k, v]) => ({ value: k, label: v.label })),
      )
      .addHint("시점에 따라 열리는 주차 탭과 설문 팝업이 달라집니다.");

    this._panel.open();
  }
}

window.ViewLensPopup = ViewLensPopup;
window.Studio = Studio;
