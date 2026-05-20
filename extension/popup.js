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

function renderWeeklyChart(dailyData) {
  // Step 5에서 구현
}

function renderEntropyChart(dailyData) {
  // Step 6에서 구현
}

init();
initTabs();
