import { YOUTUBE_API_KEY } from './config.js';

const API_BASE = 'https://www.googleapis.com/youtube/v3/videos';
const BATCH_SIZE = 50;

export async function fetchVideoCategories(videoIds) {
  const results = {};
  const chunks = chunkArray(videoIds, BATCH_SIZE);

  for (const chunk of chunks) {
    const url = `${API_BASE}?part=snippet&id=${chunk.join(',')}&key=${YOUTUBE_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    for (const item of data.items ?? []) {
      results[item.id] = item.snippet.categoryId;
    }
  }

  return results;
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
