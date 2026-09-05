// video_metadata/channel_metadata 캐시 조회·upsert 로직
//
// video_metadata.channelId -> channel_metadata.channelId는 실제 FK로 강제돼 있으므로
// channel_metadata를 먼저 upsert한 뒤에만 그 channelId를 참조하는 video_metadata 행을 넣을 수 있다.
// channelId 확보에 실패한 videoId는 이번엔 캐싱하지 않고 다음 시청 시 영상·채널 조회를 통째로 다시 시도한다.
const {
  fetchVideoMetadata,
  fetchChannelMetadata,
} = require("../pipeline/youtube");

function findMissingVideoIds(db, videoIds) {
  const uniqueIds = [...new Set(videoIds)];
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT videoId FROM video_metadata WHERE videoId IN (${placeholders})`,
    )
    .all(...uniqueIds);
  const cached = new Set(rows.map((r) => r.videoId));
  return uniqueIds.filter((id) => !cached.has(id));
}

function findMissingChannelIds(db, channelIds) {
  const uniqueIds = [...new Set(channelIds)].filter((id) => id != null);
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT channelId FROM channel_metadata WHERE channelId IN (${placeholders})`,
    )
    .all(...uniqueIds);
  const cached = new Set(rows.map((r) => r.channelId));
  return uniqueIds.filter((id) => !cached.has(id));
}

// data가 null이면(채널이 삭제됐거나 API 응답에 없음이 확인된 경우) channelId만 있는
// 빈 행을 남긴다. "확인했지만 값이 없다"를 기록해, 존재하지 않는 채널을 향한 video_metadata
// FK를 만족시키면서도 매번 재조회하지 않게 한다.
function upsertChannelMetadata(db, channelId, data) {
  db.prepare(
    `INSERT INTO channel_metadata
      (channelId, channelTitle, subscriberCount, videoCount, topicCategories, keywords)
     VALUES
      (@channelId, @channelTitle, @subscriberCount, @videoCount, @topicCategories, @keywords)
     ON CONFLICT(channelId) DO NOTHING`,
  ).run({
    channelId,
    channelTitle: data?.channelTitle ?? null,
    subscriberCount: data?.subscriberCount ?? null,
    videoCount: data?.videoCount ?? null,
    topicCategories: data?.topicCategories ?? null,
    keywords: data?.keywords ?? null,
  });
}

// data가 null이면(영상이 삭제됐거나 API 응답에 없음이 확인된 경우) videoId만 있는 빈
// 행을 남겨 다음 시청 때 재조회하지 않게 한다.
function upsertVideoMetadata(db, videoId, data) {
  db.prepare(
    `INSERT INTO video_metadata
      (videoId, categoryId, title, durationSeconds, viewCount, channelId, description)
     VALUES
      (@videoId, @categoryId, @title, @durationSeconds, @viewCount, @channelId, @description)
     ON CONFLICT(videoId) DO NOTHING`,
  ).run({
    videoId,
    categoryId: data?.categoryId ?? null,
    title: data?.title ?? null,
    durationSeconds: data?.durationSeconds ?? null,
    viewCount: data?.viewCount ?? null,
    channelId: data?.channelId ?? null,
    description: data?.description ?? null,
  });
}

/**
 * videoIds 중 video_metadata에 없는 것만 골라 YouTube API로 채운다.
 * channel_metadata -> video_metadata 순서(FK 방향)를 지키고, 채널 확보에 실패한
 * videoId는 이번엔 건너뛴다. apiKey가 없으면 아무 것도 하지 않는다.
 */
async function ensureVideoMetadata(db, videoIds, apiKey) {
  if (!apiKey) return;

  const missingVideoIds = findMissingVideoIds(db, videoIds);
  if (missingVideoIds.length === 0) return;

  const videoData = await fetchVideoMetadata(missingVideoIds, apiKey);
  // 청크 전체 호출이 실패한 videoId는 videoData에 키 자체가 없다(fetchVideoMetadata
  // 계약) — 이번엔 캐싱하지 않고 다음 시청 시 다시 시도한다.
  const fetchedVideoIds = Object.keys(videoData);

  const referencedChannelIds = fetchedVideoIds
    .map((id) => videoData[id]?.channelId)
    .filter((id) => id != null);

  const missingChannelIds = findMissingChannelIds(db, referencedChannelIds);
  let channelData = {};
  if (missingChannelIds.length > 0) {
    channelData = await fetchChannelMetadata(missingChannelIds, apiKey);
    for (const [channelId, data] of Object.entries(channelData)) {
      upsertChannelMetadata(db, channelId, data);
    }
  }

  // 이미 캐시돼 있던 channelId(= missingChannelIds에 없었던 것) + 이번에 upsert된 channelId
  const resolvedChannelIds = new Set([
    ...referencedChannelIds.filter((id) => !missingChannelIds.includes(id)),
    ...Object.keys(channelData),
  ]);

  for (const videoId of fetchedVideoIds) {
    const data = videoData[videoId];
    if (data?.channelId != null && !resolvedChannelIds.has(data.channelId)) {
      continue;
    }
    upsertVideoMetadata(db, videoId, data);
  }
}

// videoIds 순서·중복(재시청)을 그대로 유지한 채 categoryId 배열로 변환한다.
// calculateDistribution이 다양성 계산 시 영상 개수(재시청 포함)로 가중하므로, 중복을 제거하면 안 된다.
// 캐시에 없거나 categoryId 자체가 null인 영상은 null로 남기고, calculateDistribution이 null을 걸러낸다.
function getCategoryIdsForVideos(db, videoIds) {
  const uniqueIds = [...new Set(videoIds)];
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT videoId, categoryId FROM video_metadata WHERE videoId IN (${placeholders})`,
    )
    .all(...uniqueIds);
  const categoryById = new Map(rows.map((r) => [r.videoId, r.categoryId]));
  return videoIds.map((id) => categoryById.get(id) ?? null);
}

module.exports = {
  ensureVideoMetadata,
  getCategoryIdsForVideos,
  findMissingVideoIds,
  findMissingChannelIds,
  upsertChannelMetadata,
  upsertVideoMetadata,
};
