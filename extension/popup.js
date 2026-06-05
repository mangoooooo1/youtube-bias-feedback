import { getAllSessions, getRecentSessions, getOnboarding, saveOnboarding, markSurveyComplete, VALID_GROUPS } from './storage.js';
import { aggregateDailyData } from './analysis.js';

let hasSessionData = false;

async function init() {
  const sessions = await getAllSessions();
  const latestAnalyzed = sessions.findLast((s) => s.categoryDistribution);

  if (!latestAnalyzed) {
    showEmptyState();
    return;
  }

  hasSessionData = true;
  renderChart(latestAnalyzed.categoryDistribution);
  renderReview(latestAnalyzed.review);
}

function showEmptyState() {
  document.getElementById('empty-state').hidden = false;
  document.getElementById('chart-section').hidden = true;
  document.getElementById('review-section').hidden = true;
}

function renderChart(distribution) {
  const container = document.getElementById('chart-container');
  const entries = Object.entries(distribution).sort(([, a], [, b]) => b - a);

  if (entries.length === 0) {
    container.textContent = '카테고리 데이터가 없습니다.';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const [category, ratio] of entries) {
    fragment.appendChild(createBarItem(category, ratio));
  }
  container.appendChild(fragment);
}

function createBarItem(category, ratio) {
  const percent = Math.round(ratio * 100);

  const item = document.createElement('div');
  item.className = 'bar-item';

  const label = document.createElement('span');
  label.className = 'bar-item__label';
  label.textContent = category;

  const track = document.createElement('div');
  track.className = 'bar-item__track';

  const fill = document.createElement('div');
  fill.className = 'bar-item__fill';
  fill.style.width = `${percent}%`;
  track.appendChild(fill);

  const value = document.createElement('span');
  value.className = 'bar-item__value';
  value.textContent = `${percent}%`;

  item.append(label, track, value);
  return item;
}

function renderReview(review) {
  const loading = document.getElementById('review-loading');
  const text = document.getElementById('review-text');

  if (review == null) {
    loading.hidden = false;
    text.hidden = true;
    return;
  }

  loading.hidden = true;
  text.hidden = false;
  text.textContent = review;
}

function initTabs() {
  const buttons = document.querySelectorAll('.tab-nav__btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => {
        b.classList.remove('tab-nav__btn--active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('tab-nav__btn--active');
      btn.setAttribute('aria-selected', 'true');

      if (btn.dataset.tab === 'weekly') {
        showWeeklyTab();
      } else {
        showSessionTab();
      }
    });
  });
}

function showSessionTab() {
  document.getElementById('weekly-section').hidden = true;
  if (hasSessionData) {
    document.getElementById('chart-section').hidden = false;
    document.getElementById('review-section').hidden = false;
  } else {
    document.getElementById('empty-state').hidden = false;
  }
}

async function showWeeklyTab() {
  document.getElementById('chart-section').hidden = true;
  document.getElementById('review-section').hidden = true;
  document.getElementById('empty-state').hidden = true;
  document.getElementById('weekly-section').hidden = false;

  const sessions = await getRecentSessions(7);
  const dailyData = aggregateDailyData(sessions);

  const hasData = dailyData.distributions.some((d) => d !== null);
  document.getElementById('weekly-empty').hidden = hasData;
  document.getElementById('weekly-content').hidden = !hasData;

  if (hasData) {
    renderWeeklyChart(dailyData);
    renderEntropyChart(dailyData);
  }
}

const CATEGORY_COLORS = [
  '#ff4444', '#4a90d9', '#27ae60', '#f39c12', '#9b59b6',
  '#e67e22', '#1abc9c', '#3498db', '#e74c3c', '#95a5a6',
];
const OTHER_COLOR = '#d0d0d0';
const MAX_CATEGORIES = 5;

function buildColorMap(distributions) {
  const totals = {};
  for (const dist of distributions) {
    if (!dist) continue;
    for (const [cat, ratio] of Object.entries(dist)) {
      totals[cat] = (totals[cat] ?? 0) + ratio;
    }
  }
  const sorted = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  const top = sorted.slice(0, MAX_CATEGORIES);
  const colorMap = {};
  top.forEach((cat, i) => {
    colorMap[cat] = CATEGORY_COLORS[i];
  });
  return { colorMap, topCategories: top, hasOther: sorted.length > MAX_CATEGORIES };
}

function renderWeeklyChart(dailyData) {
  const container = document.getElementById('weekly-chart');
  container.innerHTML = '';

  const { dates, distributions } = dailyData;
  const { colorMap, topCategories, hasOther } = buildColorMap(distributions);

  const barsEl = document.createElement('div');
  barsEl.className = 'weekly-chart__bars';

  for (let i = 0; i < dates.length; i++) {
    const dist = distributions[i];

    const group = document.createElement('div');
    group.className = 'weekly-chart__bar-group';

    const bar = document.createElement('div');

    if (!dist) {
      bar.className = 'weekly-chart__bar weekly-chart__bar--empty';
    } else {
      bar.className = 'weekly-chart__bar';
      let otherRatio = 0;
      const topEntries = topCategories
        .filter((cat) => dist[cat] != null)
        .map((cat) => [cat, dist[cat]]);
      for (const [cat, ratio] of Object.entries(dist)) {
        if (!topCategories.includes(cat)) otherRatio += ratio;
      }
      for (const [cat, ratio] of topEntries) {
        const seg = document.createElement('div');
        seg.className = 'weekly-chart__segment';
        seg.style.flex = String(ratio);
        seg.style.background = colorMap[cat];
        bar.appendChild(seg);
      }
      if (otherRatio > 0) {
        const seg = document.createElement('div');
        seg.className = 'weekly-chart__segment';
        seg.style.flex = String(otherRatio);
        seg.style.background = OTHER_COLOR;
        bar.appendChild(seg);
      }
    }

    const dateLabel = document.createElement('span');
    dateLabel.className = 'weekly-chart__date';
    dateLabel.textContent = dates[i].slice(5).replace('-', '/');

    group.append(bar, dateLabel);
    barsEl.appendChild(group);
  }

  const legendEl = document.createElement('div');
  legendEl.className = 'weekly-chart__legend';
  const legendCategories = [...topCategories, ...(hasOther ? ['기타'] : [])];
  for (const cat of legendCategories) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const dot = document.createElement('span');
    dot.className = 'legend-item__dot';
    dot.style.background = colorMap[cat] ?? OTHER_COLOR;
    const name = document.createElement('span');
    name.textContent = cat;
    item.append(dot, name);
    legendEl.appendChild(item);
  }

  container.append(barsEl, legendEl);
}

function renderEntropyChart(dailyData) {
  const container = document.getElementById('entropy-chart');
  container.innerHTML = '';

  const { dates, entropies } = dailyData;

  const nonNullEntropies = entropies.filter((e) => e !== null);
  if (nonNullEntropies.length === 1) {
    const single = document.createElement('p');
    single.className = 'entropy-single';
    single.textContent = `현재 Entropy: ${nonNullEntropies[0]}`;
    container.appendChild(single);
    return;
  }

  const VB_W = 300;
  const VB_H = 80;
  const PAD = { top: 8, right: 12, bottom: 20, left: 12 };
  const chartW = VB_W - PAD.left - PAD.right;
  const chartH = VB_H - PAD.top - PAD.bottom;

  const yMax = Math.max(Math.max(...nonNullEntropies) * 1.2, 1);
  const xStep = chartW / (dates.length - 1); // 항상 7일 고정이므로 / 6
  const toX = (i) => PAD.left + i * xStep;
  const toY = (val) => PAD.top + chartH - (val / yMax) * chartH;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(VB_H));
  svg.setAttribute('aria-label', 'Entropy 변화 추이 라인차트');

  // null인 날에서 라인을 끊어 연속 구간별로 polyline 생성
  let segment = [];
  for (let i = 0; i <= dates.length; i++) {
    if (i < dates.length && entropies[i] !== null) {
      segment.push(i);
    } else {
      if (segment.length >= 2) {
        const pts = segment.map((j) => `${toX(j)},${toY(entropies[j])}`).join(' ');
        const polyline = document.createElementNS(svgNS, 'polyline');
        polyline.setAttribute('points', pts);
        polyline.setAttribute('fill', 'none');
        polyline.setAttribute('stroke', '#6366f1');
        polyline.setAttribute('stroke-width', '1.5');
        polyline.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(polyline);
      }
      segment = [];
    }
  }

  // 첫 번째 non-null 인덱스가 베이스라인
  const baselineIdx = entropies.findIndex((e) => e !== null);

  for (let i = 0; i < dates.length; i++) {
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', String(toX(i)));
    label.setAttribute('y', String(VB_H - 2));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '9');
    label.setAttribute('fill', '#909090');
    label.textContent = dates[i].slice(5).replace('-', '/');
    svg.appendChild(label);

    if (entropies[i] === null) continue;

    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', String(toX(i)));
    circle.setAttribute('cy', String(toY(entropies[i])));
    circle.setAttribute('r', i === baselineIdx ? '4' : '3');
    circle.setAttribute('fill', i === baselineIdx ? '#f59e0b' : '#6366f1');
    svg.appendChild(circle);
  }

  container.appendChild(svg);

  const latestEntropy = nonNullEntropies.at(-1);
  const delta = Math.round((latestEntropy - nonNullEntropies[0]) * 100) / 100;
  if (delta !== 0) {
    const deltaEl = document.createElement('p');
    deltaEl.className = `entropy-delta entropy-delta--${delta > 0 ? 'up' : 'down'}`;
    deltaEl.textContent =
      delta > 0
        ? `▲ ${delta.toFixed(2)} 다양성 증가`
        : `▼ ${Math.abs(delta).toFixed(2)} 편향 심화`;
    container.appendChild(deltaEl);
  }
}

// --- 온보딩 & 진입점 ---

const EXPERIMENT_DAYS = 21;

async function bootstrap() {
  const onboarding = await getOnboarding();
  if (!onboarding) {
    showOnboardingScreen();
  } else {
    await showMainContent(onboarding);
  }
}

function showOnboardingScreen() {
  const input = document.getElementById('group-code-input');
  const submitBtn = document.getElementById('onboarding-submit');

  submitBtn.addEventListener('click', handleOnboardingSubmit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleOnboardingSubmit();
  });
}

async function handleOnboardingSubmit() {
  const submitBtn = document.getElementById('onboarding-submit');
  if (submitBtn.disabled) return;

  const input = document.getElementById('group-code-input');
  const code = input.value.trim().toUpperCase();
  const error = document.getElementById('code-error');

  if (!VALID_GROUPS.includes(code)) {
    error.hidden = false;
    return;
  }

  submitBtn.disabled = true;
  input.disabled = true;
  error.hidden = true;

  try {
    await saveOnboarding(code);
    const onboarding = await getOnboarding();
    await showMainContent(onboarding);
  } catch (err) {
    console.error(err);
    submitBtn.disabled = false;
    input.disabled = false;
  }
}

async function showMainContent(onboarding) {
  document.getElementById('onboarding-screen').hidden = true;
  document.getElementById('main-content').hidden = false;

  renderExperimentBar(onboarding.installDate);
  renderSurveyBanner(onboarding);
  await init();
  initTabs();
}

function renderExperimentBar(installDate) {
  const elapsed = calcDaysElapsed(installDate);
  const remaining = Math.max(EXPERIMENT_DAYS - elapsed, 0);

  document.getElementById('days-elapsed').textContent = `설치 후 ${elapsed + 1}일째`;
  document.getElementById('days-remaining').textContent =
    remaining > 0 ? `실험 종료까지 ${remaining}일` : '실험 기간 종료';
}

function calcDaysElapsed(installDate) {
  return Math.floor((Date.now() - new Date(installDate).getTime()) / (1000 * 60 * 60 * 24));
}

const SURVEY_THRESHOLDS = { week1: 7, week2: 14, week3: 21 };
const SURVEY_LABELS = {
  week1: '1주차 설문을 완료해주세요.',
  week2: '2주차 설문을 완료해주세요.',
  week3: '3주차 설문을 완료해주세요.',
};

function renderSurveyBanner({ group, installDate, surveyStatus }) {
  const thresholds = group === 'TEST'
    ? { week1: 0, week2: 0, week3: 0 }
    : SURVEY_THRESHOLDS;

  const elapsed = calcDaysElapsed(installDate);

  const targetWeek = ['week1', 'week2', 'week3'].find(
    (week) => elapsed >= thresholds[week] && !surveyStatus[week]
  );

  if (!targetWeek) return;

  const banner = document.getElementById('survey-banner');
  document.getElementById('survey-banner-text').textContent = SURVEY_LABELS[targetWeek];
  banner.hidden = false;

  const doneBtn = document.getElementById('survey-done-btn');
  doneBtn.onclick = async () => {
    if (doneBtn.disabled) return;
    doneBtn.disabled = true;
    banner.hidden = true;
    await markSurveyComplete(targetWeek);
    doneBtn.disabled = false;
  };
}

bootstrap();
