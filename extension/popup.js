import { getAllSessions } from './storage.js';

async function init() {
  const sessions = await getAllSessions();
  const latestAnalyzed = sessions.filter((s) => s.categoryDistribution).at(-1);

  console.log('[popup] sessions:', sessions);
  console.log('[popup] latest analyzed session:', latestAnalyzed);

  if (!latestAnalyzed) {
    showEmptyState();
    return;
  }

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
  document.getElementById('review-text').textContent = review ?? '';
}

init();
