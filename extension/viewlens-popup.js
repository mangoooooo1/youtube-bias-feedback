const EXPERIMENT_DAYS = 21;
const DEFAULT_TONE = "indigo";

// ── Token application ─────────────────────────────────────────────────────────

function applyTokens(el, toneName, dark) {
  const tone = VL.TONES[toneName] || VL.TONES.indigo;
  const tokens = dark ? tone.dark : tone.light;
  Object.entries(tokens).forEach(([k, v]) => el.style.setProperty(k, v));
  el.style.background = tokens["--vl-bg"];
}

// ── Timeline key from install date ────────────────────────────────────────────

function calcTimelineKey(installDate) {
  if (!installDate) return "w1_mid";
  const days = Math.max(
    1,
    Math.floor((Date.now() - new Date(installDate).getTime()) / 86400000) + 1,
  );
  if (days >= 21) return "w3_end";
  if (days >= 18) return "w3_mid";
  if (days >= 14) return "w2_end";
  if (days >= 11) return "w2_mid";
  if (days >= 7) return "w1_end";
  return "w1_mid";
}

// ── Survey status mapping ─────────────────────────────────────────────────────
// storage: { week1: bool, week2: bool, week3: bool }
// VL uses numeric week keys in completed: { 1: true, 2: true, 3: true }

function storageToCompleted(surveyStatus) {
  if (!surveyStatus) return {};
  return {
    ...(surveyStatus.week1 ? { 1: true } : {}),
    ...(surveyStatus.week2 ? { 2: true } : {}),
    ...(surveyStatus.week3 ? { 3: true } : {}),
  };
}

async function markWeekComplete(week) {
  const key = `week${week}`;
  const { surveyStatus } = await chrome.storage.local.get("surveyStatus");
  const updated = {
    week1: false,
    week2: false,
    week3: false,
    ...(surveyStatus || {}),
    [key]: true,
  };
  await chrome.storage.local.set({ surveyStatus: updated });
}

// ── Popup-aware ViewLensPopup subclass ────────────────────────────────────────
// Overrides survey completion and onboarding to persist to chrome.storage.

class RealPopup extends ViewLensPopup {
  constructor(container, surveyStatus) {
    super(container);
    // Seed completed state from storage so we don't re-show dismissed surveys
    this._completed = storageToCompleted(surveyStatus);
  }

  // Override: also persist survey completion to storage
  _bind(groupCfg, surveyWeek, surveyPending, currentWeek) {
    super._bind(groupCfg, surveyWeek, surveyPending, currentWeek);

    const doneBtn = this.container.querySelector("#vl-survey-done");
    if (doneBtn && surveyWeek != null) {
      // Replace the super listener by re-attaching (cloneNode trick isn't needed
      // since super only sets this._completed — we add storage persistence here)
      doneBtn.addEventListener("click", () => markWeekComplete(surveyWeek));
    }
  }
}

// ── Main boot ─────────────────────────────────────────────────────────────────

async function boot() {
  const { group, installDate, surveyStatus, tone, dark } =
    await chrome.storage.local.get([
      "group",
      "installDate",
      "surveyStatus",
      "tone",
      "dark",
    ]);

  const popEl = document.getElementById("vl-popup-root");
  const toneName = tone || DEFAULT_TONE;
  const darkMode = !!dark;

  applyTokens(popEl, toneName, darkMode);

  const onboarded = !!group;
  const timelineKey = calcTimelineKey(installDate);

  const popup = new RealPopup(popEl, surveyStatus);

  popup.mount({
    onboarded,
    group: group || null,
    timelineKey,
    onChange: async ({ onboarded: ob, group: g }) => {
      if (ob && g) {
        await chrome.storage.local.set({
          group: g,
          installDate: new Date().toISOString(),
          surveyStatus: { week1: false, week2: false, week3: false },
        });
      }
    },
  });
}

boot().catch((err) => {
  // Fallback for opening the HTML directly in browser (no chrome.storage)
  if (typeof chrome === "undefined" || !chrome.storage) {
    const popEl = document.getElementById("vl-popup-root");
    applyTokens(popEl, DEFAULT_TONE, false);
    const popup = new ViewLensPopup(popEl);
    popup.mount({
      onboarded: false,
      group: null,
      timelineKey: "w1_mid",
      onChange: () => {},
    });
  } else {
    console.error("[ViewLens popup] boot error:", err);
  }
});
