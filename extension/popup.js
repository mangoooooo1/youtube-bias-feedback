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
  // Step 3에서 구현
  console.log('[popup] categoryDistribution:', distribution);
}

function renderReview(review) {
  document.getElementById('review-text').textContent = review ?? '';
}

init();
