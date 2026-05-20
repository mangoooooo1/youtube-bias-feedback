import { getAllSessions, getRecentSessions } from './storage.js';
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

  const hasData = dailyData.dates.length > 0;
  document.getElementById('weekly-empty').hidden = hasData;
  document.getElementById('weekly-chart').hidden = !hasData;
  document.getElementById('entropy-chart').hidden = !hasData;

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

    let otherRatio = 0;
    const topEntries = topCategories
      .filter((cat) => dist[cat] != null)
      .map((cat) => [cat, dist[cat]]);
    for (const [cat, ratio] of Object.entries(dist)) {
      if (!topCategories.includes(cat)) otherRatio += ratio;
    }

    const group = document.createElement('div');
    group.className = 'weekly-chart__bar-group';

    const bar = document.createElement('div');
    bar.className = 'weekly-chart__bar';

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
  // Step 6에서 구현
}

init();
initTabs();
