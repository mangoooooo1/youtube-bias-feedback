import { YOUTUBE_API_KEY } from '../config.js';

const API_BASE = 'https://www.googleapis.com/youtube/v3/videos';
const BATCH_SIZE = 50;

export async function fetchVideoCategories(videoIds) {
  const chunks = chunkArray(videoIds, BATCH_SIZE);
  const results = {};

  for (const chunk of chunks) {
    const partial = await fetchChunk(chunk);
    Object.assign(results, partial);
  }

  return results;
}

async function fetchChunk(videoIds) {
  try {
    const params = new URLSearchParams({
      part: 'snippet',
      id: videoIds.join(','),
      key: YOUTUBE_API_KEY,
    });
    const response = await fetch(`${API_BASE}?${params}`);

    if (!response.ok) {
      console.warn(`[youtube] API 오류: ${response.status}`);
      return nullMap(videoIds);
    }

    const data = await response.json();

    // null을 기본값으로 초기화 → 삭제/비공개 영상은 null로 유지됨
    const partial = nullMap(videoIds);
    for (const item of data.items ?? []) {
      partial[item.id] = item.snippet?.categoryId ?? null;
    }

    return partial;
  } catch (error) {
    console.warn('[youtube] 네트워크 오류:', error.message);
    return nullMap(videoIds);
  }
}

function nullMap(videoIds) {
  return Object.fromEntries(videoIds.map((id) => [id, null]));
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
