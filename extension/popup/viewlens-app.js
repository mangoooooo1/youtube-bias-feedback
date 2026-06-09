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

function _popupHeader(groupCfg, day) {
  const badge =
    groupCfg.code === "TEST"
      ? vlBadge({ text: "연구자 모드", tone: "accent", size: "sm" })
      : vlBadge({ text: "참여 중", tone: "neutral", size: "sm" });
  return `<div style="padding:13px 16px;border-bottom:1px solid var(--vl-line);display:flex;align-items:center;justify-content:space-between;background:var(--vl-card);position:sticky;top:0;z-index:10">
    <div style="display:flex;align-items:center;gap:9px">
      ${markSVG({ size: 26, accent: "var(--vl-accent)" })}
      <div style="display:flex;flex-direction:column;line-height:1.1">
        <span style="font-size:15px;font-weight:800;letter-spacing:-0.02em;color:var(--vl-ink)">View<span style="color:var(--vl-accent)">Lens</span></span>
        <span style="font-size:10.5px;color:var(--vl-ink-3);font-family:'JetBrains Mono',monospace;margin-top:2px">설치 ${day}일째 · 종료 D-${VL.TOTAL_DAYS - day}</span>
      </div>
    </div>
    ${badge}
  </div>`;
}

function _tabs(activeTab) {
  const list = [
    { id: "today", label: "오늘" },
    { id: "feedback", label: "주차별 피드백" },
  ];
  return `<div style="display:flex;gap:4px;padding:10px 16px 0;background:var(--vl-card)">
    ${list
      .map((t) => {
        const on = t.id === activeTab;
        return `<button data-tab="${t.id}" style="flex:1;padding:9px 6px 11px;border:none;background:transparent;cursor:pointer;font-family:inherit;font-size:13px;font-weight:700;color:${on ? "var(--vl-accent)" : "var(--vl-ink-3)"};border-bottom:2px solid ${on ? "var(--vl-accent)" : "transparent"};transition:color .15s">${t.label}</button>`;
      })
      .join("")}
  </div>`;
}

function _surveyBanner(week) {
  return `<button id="vl-banner" style="width:100%;box-sizing:border-box;display:flex;align-items:center;gap:9px;padding:10px 16px;border:none;border-bottom:1px solid var(--vl-line);cursor:pointer;background:var(--vl-accent-soft);font-family:inherit;text-align:left">
    <span style="width:7px;height:7px;border-radius:50%;background:var(--vl-accent);flex-shrink:0;animation:vlBlink 1.6s ease-in-out infinite"></span>
    <span style="flex:1;font-size:12.5px;font-weight:600;color:var(--vl-accent)">${week}주차 설문이 기다리고 있어요</span>
    <span style="font-size:11.5px;font-weight:700;color:var(--vl-accent)">열기 ›</span>
  </button>`;
}

// ── ViewLensPopup class ───────────────────────────────────────────────────────

class ViewLensPopup {
  /**
   * @param {HTMLElement} container - The popup root element
   */
  constructor(container) {
    this.container = container;
    this._tab = "today";
    this._completed = {}; // { [week]: true }
    this._snoozed = false;
    this._selWeek = 1;
    this._selectedDate = new Date();
    // External app state (set via mount)
    this._onboarded = false;
    this._group = null;
    this._timelineKey = "w1_mid";
    this._onChange = () => {};
  }

  /**
   * Mount with external state.
   * @param {object} opts
   * @param {boolean}  opts.onboarded
   * @param {string}   opts.group
   * @param {string}   opts.timelineKey
   * @param {Function} opts.onChange - called with { onboarded, group } on onboard submit
   */
  mount({ onboarded, group, timelineKey, onChange }) {
    this._onboarded = onboarded;
    this._group = group;
    this._timelineKey = timelineKey;
    this._onChange = onChange;
    this.render();
  }

  /** Called by Studio when tweaks change */
  update({ onboarded, group, timelineKey }) {
    const tlChanged = timelineKey !== this._timelineKey;
    this._onboarded = onboarded;
    this._group = group;
    this._timelineKey = timelineKey;
    if (tlChanged) this._snoozed = false;
    this.render();
  }

  render() {
    if (!this._onboarded || !this._group) {
      this._renderOnboarding();
      return;
    }
    const tl = VL.TIMELINE[this._timelineKey] || VL.TIMELINE.w1_mid;
    const groupCfg = VL.GROUPS[this._group] || VL.GROUPS.EXP;
    const selWeek = Math.min(this._selWeek, tl.currentWeek);
    const surveyWeek = tl.surveyWeek;
    const surveyPending = surveyWeek != null && !this._completed[surveyWeek];
    const showModal = surveyPending && !this._snoozed;

    if (this._tab === "today") {
      const d = buildDataForDate(VL._allSessions || [], this._selectedDate);
      const isToday =
        this._selectedDate.toDateString() === new Date().toDateString();
      d.collectingCount = isToday ? (VL.today?.collectingCount ?? 0) : 0;
      d.collectingTimer = isToday ? _collectingTimerText() : "";
      VL.today = d;
    }

    let bodyHTML;
    if (groupCfg.feedback) {
      bodyHTML =
        this._tab === "today"
          ? screenToday()
          : screenFeedback(tl.currentWeek, selWeek);
    } else {
      bodyHTML = screenControlHome(tl.day);
    }

    this.container.innerHTML = `<div style="position:relative;height:100%;display:flex;flex-direction:column;background:var(--vl-bg)">
      ${_popupHeader(groupCfg, tl.day)}
      ${surveyPending && this._snoozed ? _surveyBanner(surveyWeek) : ""}
      ${groupCfg.feedback ? _tabs(this._tab) : ""}
      <div style="flex:1;overflow-y:auto;overflow-x:hidden">${bodyHTML}</div>
      ${showModal ? screenSurveyModal(surveyWeek) : ""}
    </div>`;

    this._bind(groupCfg, surveyWeek, surveyPending, tl.currentWeek);
  }

  _renderOnboarding() {
    this.container.innerHTML = `<div style="height:100%;overflow-y:auto">${screenOnboarding()}</div>`;
    bindOnboarding(this.container, (code) => {
      this._onboarded = true;
      this._group = code;
      this._onChange({ onboarded: true, group: code });
      this.render();
    });
  }

  _bind(groupCfg, surveyWeek, surveyPending, currentWeek) {
    // Tabs
    if (groupCfg.feedback) {
      this.container.querySelectorAll("[data-tab]").forEach((btn) => {
        btn.addEventListener("click", () => {
          this._tab = btn.dataset.tab;
          this.render();
        });
      });
    }
    // Survey banner → reopen modal
    const banner = this.container.querySelector("#vl-banner");
    if (banner)
      banner.addEventListener("click", () => {
        this._snoozed = false;
        this.render();
      });
    // Survey modal buttons
    const doneBtn = this.container.querySelector("#vl-survey-done");
    const laterBtn = this.container.querySelector("#vl-survey-later");
    if (doneBtn)
      doneBtn.addEventListener("click", () => {
        this._completed = { ...this._completed, [surveyWeek]: true };
        this.render();
      });
    if (laterBtn)
      laterBtn.addEventListener("click", () => {
        this._snoozed = true;
        this.render();
      });
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
      this._popup.update({
        onboarded: this._state.onboarded,
        group: this._state.group,
        timelineKey: this._state.timeline,
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
              <span style="color:#c9ccd1;font-size:12.5px;font-family:'JetBrains Mono',monospace">youtube.com<span style="color:#9aa0a6">/watch?v=dQw4w9WgXcQ</span></span>
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

        <div style="font-size:12px;color:#9a938c;font-family:'JetBrains Mono',monospace;letter-spacing:.04em">
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
    this._popup.mount({
      onboarded: this._state.onboarded,
      group: this._state.group,
      timelineKey: this._state.timeline,
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
