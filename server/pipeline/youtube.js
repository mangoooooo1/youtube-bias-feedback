// 서버 측 YouTube Data API v3 호출
// video_metadata/channel_metadata 캐시 미스를 채우기 위한 순수 조회 모듈
const VIDEOS_API_URL = "https://www.googleapis.com/youtube/v3/videos";
const CHANNELS_API_URL = "https://www.googleapis.com/youtube/v3/channels";
// id 파라미터 1회 요청당 최대 개수(YouTube Data API 제약). 쿼터 비용은 이 개수와
// 무관하게 요청 1회당 고정이라, 가능한 한 이 크기로 묶어 보내는 것 자체가 쿼터 절감이다.
const BATCH_SIZE = 50;
const TIMEOUT_MS = 10000;

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function nullMap(ids) {
  return Object.fromEntries(ids.map((id) => [id, null]));
}

// YouTube 영상 길이는 년/월/일 단위가 없어(PnYnMnD 없이 항상 PT로 시작) 시/분/초만
// 처리한다. 형식이 예상과 다르면(라이브 방송 등 예외) null을 반환한다.
function parseIso8601Duration(duration) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration ?? "");
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  if (!hours && !minutes && !seconds) return null;
  return (
    Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)
  );
}

// 채널마다 topicCategories 배열의 순서·개수가 달라 단순 문자열 비교로는 그룹화가
// 과소평가되는 문제를 보정하기 위해 정렬한 뒤 저장
function normalizeTopicCategories(topicCategories) {
  if (!Array.isArray(topicCategories) || topicCategories.length === 0) {
    return null;
  }
  return JSON.stringify([...topicCategories].sort());
}

async function fetchJson(url, params) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${url}?${params}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`[youtube] API 오류: ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn("[youtube] 네트워크 오류:", error.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchVideoChunk(videoIds, apiKey) {
  const params = new URLSearchParams({
    part: "snippet,contentDetails,statistics",
    id: videoIds.join(","),
    key: apiKey,
  });
  const data = await fetchJson(VIDEOS_API_URL, params);
  // 청크 전체 호출이 실패하면(네트워크 오류/쿼터 초과 등) 빈 객체를 반환한다.
  if (!data) return {};

  // 응답은 성공했지만 삭제/비공개라 items에 없는 영상은 확정적으로 결측(null)이다.
  const result = nullMap(videoIds);
  for (const item of data.items ?? []) {
    result[item.id] = {
      categoryId: item.snippet?.categoryId ?? null,
      title: item.snippet?.title ?? null,
      // 쇼츠(<=60초) 여부 이진 판별 용도로만 사용(실제 시청 시간이 아님)
      durationSeconds: parseIso8601Duration(item.contentDetails?.duration),
      viewCount:
        item.statistics?.viewCount !== undefined
          ? Number(item.statistics.viewCount)
          : null,
      channelId: item.snippet?.channelId ?? null,
      // 원문 보관 전용
      description: item.snippet?.description ?? null,
    };
  }
  return result;
}

async function fetchChannelChunk(channelIds, apiKey) {
  const params = new URLSearchParams({
    part: "snippet,statistics,topicDetails,brandingSettings",
    id: channelIds.join(","),
    key: apiKey,
  });
  const data = await fetchJson(CHANNELS_API_URL, params);
  // videos.list와 동일한 이유로, 청크 전체 실패 시 빈 객체를 반환한다(위 fetchVideoChunk 주석 참고).
  if (!data) return {};

  const result = nullMap(channelIds);
  for (const item of data.items ?? []) {
    result[item.id] = {
      channelTitle: item.snippet?.title ?? null,
      // 구독자 수를 비공개로 설정한 채널은 hiddenSubscriberCount=true이고
      // subscriberCount 필드 자체가 없다 — 그 경우 null로 남는다.
      subscriberCount:
        item.statistics?.subscriberCount !== undefined
          ? Number(item.statistics.subscriberCount)
          : null,
      videoCount:
        item.statistics?.videoCount !== undefined
          ? Number(item.statistics.videoCount)
          : null,
      topicCategories: normalizeTopicCategories(
        item.topicDetails?.topicCategories,
      ),
      // 원문 보관 전용 — tags와 동일 계열 위험으로 실시간 기능에는 미반영(보고서 4·5절)
      keywords: item.brandingSettings?.channel?.keywords ?? null,
    };
  }
  return result;
}

// videoId -> { categoryId, title, durationSeconds, viewCount, channelId, description } | null
// (null = 확인 결과 존재하지 않는 영상). 청크 전체 호출이 실패한 videoId는 결과 맵에
// 키 자체가 없다 — 호출부가 이 경우를 재시도 대상으로 구분해야 한다.
async function fetchVideoMetadata(videoIds, apiKey) {
  const uniqueIds = [...new Set(videoIds)];
  const results = {};
  for (const chunk of chunkArray(uniqueIds, BATCH_SIZE)) {
    Object.assign(results, await fetchVideoChunk(chunk, apiKey));
  }
  return results;
}

// channelId -> { channelTitle, subscriberCount, videoCount, topicCategories, keywords } | null
// (null = 확인 결과 존재하지 않는 채널). 청크 전체 호출이 실패한 channelId는 결과 맵에
// 키 자체가 없다 — 호출부가 이 경우를 재시도 대상으로 구분해야 한다.
async function fetchChannelMetadata(channelIds, apiKey) {
  const uniqueIds = [...new Set(channelIds)];
  const results = {};
  for (const chunk of chunkArray(uniqueIds, BATCH_SIZE)) {
    Object.assign(results, await fetchChannelChunk(chunk, apiKey));
  }
  return results;
}

module.exports = {
  fetchVideoMetadata,
  fetchChannelMetadata,
  parseIso8601Duration,
  normalizeTopicCategories,
};
