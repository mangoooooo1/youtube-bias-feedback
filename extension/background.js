import {
  endSession,
  getLastWatchedAt,
  getCurrentSession,
  getAllSessions,
  saveAnalysis,
  getOnboarding,
  getUnsentVideoEvents,
  markVideoEventSent,
  markVideoEventInvalid,
  getUnsentWatchStats,
  markWatchStatsSent,
  markWatchStatsInvalid,
  getParticipantSyncState,
  markParticipantSynced,
  recordParticipantSyncFailure,
  invalidateParticipantSync,
} from "./storage.js";
import { isBaselinePeriod } from "./pipeline/baseline.js";
import { SERVER_URL } from "./config.js";
import "./study-schedule.js";

const ALARM_NAME = "SESSION_TIMEOUT_CHECK";
const TIMEOUT_MS = 10 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 5000;
const SESSION_REQUEST_TIMEOUT_MS = 60000;
const MAX_ITEMS_PER_TICK = 50;

// 분석 완료 알림 대상 판정. EXP 그룹이면서 베이스라인 기간(설치 후 14일)이
// 끝난 경우에만 알림·배지를 노출한다.
const FEEDBACK_ELIGIBLE_GROUPS = new Set(["EXP", "TEST-EXP"]);

/**
 * TEST-EXP(연구자 모드)는 모든 화면을 미리 볼 수 있어야 하므로, 실제 참여자 온보딩과
 * 무관하게 베이스라인 게이트를 적용하면 안 된다.
 * @param {string} group - 참여자 그룹 코드
 * @returns {boolean} TEST- 접두사 그룹이면 true
 */
function isTestGroup(group) {
  return typeof group === "string" && group.startsWith("TEST");
}

/**
 * 분석 완료 알림 대상인지 판정한다. EXP 계열이면서 베이스라인 기간이 끝난 경우에만 true.
 * @param {string} group - 참여자 그룹 코드
 * @param {string} installDate - 설치일(ISO)
 * @returns {boolean}
 */
function isFeedbackNotificationEligible(group, installDate) {
  if (!FEEDBACK_ELIGIBLE_GROUPS.has(group)) return false;
  return isTestGroup(group) || !isBaselinePeriod(installDate);
}

const BASE_ICON_PATHS = {
  16: "assets/icons/icon16.png",
  32: "assets/icons/icon32.png",
  48: "assets/icons/icon48.png",
  128: "assets/icons/icon128.png",
};

/**
 * 미열람 표시를 배지 텍스트 대신 아이콘에 점으로 그려 넣는다(OS·Chrome 버전 간
 * 렌더링 차이를 피하기 위함).
 * @returns {Promise<void>}
 */
async function setUnviewedIconDot() {
  try {
    const imageData = {};
    for (const size of Object.keys(BASE_ICON_PATHS).map(Number)) {
      imageData[size] = await drawIconWithDot(size);
    }
    chrome.action.setIcon({ imageData });
  } catch (error) {
    // 아이콘 그리기가 실패해도(예: OffscreenCanvas 미지원) 알림 자체는 이미 떴으므로 무시.
    console.warn("[background] 미열람 아이콘 표시 실패:", error.message);
  }
}

/**
 * 미열람 아이콘 점을 원래 아이콘으로 되돌린다.
 * @returns {void}
 */
function clearUnviewedIconDot() {
  // setIcon의 상대 경로는 "확장 루트"가 아니라 "호출한 스크립트의 위치" 기준으로 풀린다.
  // background.js는 루트에 있어 상대 경로가 우연히 맞았을 뿐이므로, getURL로 명시적인
  // 절대 경로를 만들어 어디서 호출되든(팝업 등) 항상 정확하게 만든다.
  const path = Object.fromEntries(
    Object.entries(BASE_ICON_PATHS).map(([size, p]) => [
      size,
      chrome.runtime.getURL(p),
    ]),
  );
  chrome.action.setIcon({ path });
}

/**
 * 기본 아이콘 위에 미열람 표시용 빨간 점을 그려 ImageData로 반환한다.
 * @param {number} size - 아이콘 픽셀 크기
 * @returns {Promise<ImageData>}
 */
async function drawIconWithDot(size) {
  const response = await fetch(chrome.runtime.getURL(BASE_ICON_PATHS[size]));
  const bitmap = await createImageBitmap(await response.blob());

  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, size, size);

  const radius = Math.max(2, Math.round(size * 0.22));
  const cx = size - radius - 1;
  const cy = radius + 1;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = "#E11D2E";
  ctx.fill();

  return ctx.getImageData(0, 0, size, size);
}

// service worker가 깨어날 때마다 실행 — 같은 이름의 alarm은 자동으로 교체됨
chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });

// content script가 읽을 수 있도록 SERVER_URL을 storage에 저장.
chrome.storage.local
  .set({ serverUrl: SERVER_URL })
  .catch((error) =>
    console.error(
      `[background] task=persist_server_url result=crashed error=${error?.message}`,
    ),
  );

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  runServerTasks().catch((error) =>
    console.error(
      `[background] task=server_tasks result=crashed error=${error?.message}`,
    ),
  );
  // 로컬 세션 종료 판정은 서버와 무관하므로 게이트를 기다리지 않는다.
  // 네 큐는 withQueueLock이 예외를 흡수하지만 이 경로는 그 밖이라 여기서 직접 받는다.
  checkSessionTimeout().catch((error) =>
    console.error(
      `[background] task=session_timeout result=crashed error=${error?.message}`,
    ),
  );
});

/**
 * 알람 틱의 서버 작업. 참여 전송 기간까지 끝났으면(ended) 등록·재시도 큐를 돌리지 않고
 * 종료 안내만 한 번 띄운다.
 * @returns {Promise<void>}
 */
export async function runServerTasks() {
  const onboarding = await getOnboarding();
  if (
    ViewLensStudy.getParticipationState(onboarding?.installDate) === "ended"
  ) {
    await notifyParticipationEndedOnce();
    return;
  }
  await ensureParticipantSynced().finally(() =>
    Promise.all([
      retryUnsyncedSessions(),
      retryUnsentVideoEvents().finally(() => retryUnsentWatchStats()),
    ]),
  );
}

const PARTICIPATION_ENDED_NOTIFICATION_ID = "viewlens-participation-ended";

/**
 * 참여 종료 안내 알림을 기기당 한 번만 띄운다. 서비스워커가 재시작돼도 다시 뜨지 않도록
 * 표시 시각을 storage에 남긴다.
 * @returns {Promise<void>}
 */
async function notifyParticipationEndedOnce() {
  const { participationEndedNotifiedAt } = await chrome.storage.local.get(
    "participationEndedNotifiedAt",
  );
  if (participationEndedNotifiedAt) return;
  await chrome.storage.local.set({
    participationEndedNotifiedAt: new Date().toISOString(),
  });
  chrome.notifications.create(PARTICIPATION_ENDED_NOTIFICATION_ID, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("assets/icons/icon128.png"),
    title: "ViewLens",
    message:
      "연구 참여 기간이 종료되었습니다. 참여해 주셔서 감사합니다. 확장 프로그램을 제거해 주세요.",
  });
}

// 알림 본문/버튼 클릭 모두 같은 동작 — notificationId가 곧 sessionId이므로 별도 매핑 없이 역추적한다.
chrome.notifications.onButtonClicked.addListener(handleNotificationOpen);
chrome.notifications.onClicked.addListener(handleNotificationOpen);

/**
 * 알림 클릭 시 팝업을 열고 아이콘 점을 지운 뒤 열람을 서버에 기록한다.
 * @param {string} sessionId - 알림 id(=sessionId, 참여 종료 알림은 예외)
 * @returns {Promise<void>}
 */
export async function handleNotificationOpen(sessionId) {
  chrome.notifications.clear(sessionId);
  // 참여 종료 알림은 세션이 아니라 열람 기록 대상이 없다
  if (sessionId === PARTICIPATION_ENDED_NOTIFICATION_ID) {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html") });
    return;
  }
  clearUnviewedIconDot();
  chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html") });
  await markFeedbackViewed(sessionId);
}

/**
 * 알림 클릭을 "실제 열람 시작"으로 서버에 기록한다. 팝업 표시 기반 feedbackViewed보다
 * 엄격한 신호로, 알림을 거치지 않고 팝업만 연 경우는 기록하지 않는다.
 * @param {string} sessionId - 대상 세션 id
 * @returns {Promise<void>}
 */
async function markFeedbackViewed(sessionId) {
  if (!SERVER_URL || SERVER_URL.startsWith("YOUR_")) return;
  const onboarding = await getOnboarding();
  if (!onboarding?.anonymousId) return;

  const cleanUrl = SERVER_URL.replace(/\/$/, "");
  try {
    const response = await fetch(
      `${cleanUrl}/api/sessions/${encodeURIComponent(sessionId)}/feedback-viewed`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anonymousId: onboarding.anonymousId,
          participantToken: onboarding.participantToken,
        }),
      },
    );
    if (!response.ok) {
      console.warn("[background] 피드백 열람 기록 실패:", response.status);
    }
  } catch (error) {
    console.warn("[background] 피드백 열람 기록 오류:", error);
  }
}

/**
 * 마지막 시청 후 TIMEOUT_MS 이상 지났으면 현재 세션을 종료하고 분석을 시작한다.
 * @returns {Promise<void>}
 */
async function checkSessionTimeout() {
  const lastWatchedAt = await getLastWatchedAt();
  if (!lastWatchedAt) return;

  const elapsed = Date.now() - new Date(lastWatchedAt).getTime();
  if (elapsed < TIMEOUT_MS) return;

  const currentSession = await getCurrentSession();
  if (!currentSession) return;
  const sessionId = currentSession.sessionId;

  console.log("[background] 10분 비활성 감지, 세션 종료");
  await endSession();

  const sessions = await getAllSessions();
  const session = sessions.find((s) => s.sessionId === sessionId);
  if (!session || session.videos.length === 0) return;
  await analyzeSession(session);
}

/**
 * 세션 종료 시 videoCount를 먼저 로컬에 기록해 "분석 대기" 상태를 표시하고,
 * 이어서 서버로 전송한다(categoryDistribution/entropy는 응답 후 채워짐).
 * @param {object} session - 종료된 세션(sessionId, videos 등)
 * @returns {Promise<void>}
 */
export async function analyzeSession(session) {
  // 여기서는 videoCount만 먼저 로컬에 기록해 "세션 종료, 서버 응답 대기" 상태를 표시한다.
  // categoryDistribution/entropy는 서버 응답을 받은 뒤(syncSessionToServer)에야 채워진다.
  const t0 = Date.now();
  const videoCount = session.videos.length;

  // syncedToServer를 false로 명시해둬야, 곧이어 서버 전송이 오프라인/오류로 실패했을 때
  // retryUnsyncedSessions()가 이 세션을 재시도 대상으로 찾아낼 수 있다(이 필드가 아예
  // 없는 - 이 기능이 생기기 전에 이미 분석됐던 - 세션과 구분하기 위한 값이다).
  await saveAnalysis(session.sessionId, {
    videoCount,
    syncedToServer: false,
  });

  const totalMs = Date.now() - t0;
  await syncSessionToServer({ ...session, videoCount }, { totalMs });
}

/**
 * 세션 분석 결과를 서버로 보내고 응답에 따라 오늘 리뷰 반영·알림까지 처리한다.
 * analyzeSession(최초 전송)과 retryUnsyncedSessions(재시도)가 공유하며, 실패 시
 * syncedToServer가 false로 남아 다음 알람 틱에 다시 시도된다.
 * @param {object} session - 전송할 세션
 * @param {{totalMs?: number}} [metrics] - 소요 시간 등 부가 지표
 * @returns {ReturnType<typeof sendToServer>} 재시도 큐가 계속·중단을 판단할 전송 결과
 */
async function syncSessionToServer(session, metrics = {}) {
  // 알림 자격은 리뷰 생성 결과와 무관하게(그룹·베이스라인만으로) 미리 정해진다.
  // 이 값을 그대로 서버에 함께 보내 sessions.feedbackNotifiedAt에 기록한다.
  const onboarding = await getOnboarding();
  // 알람 틱 밖(세션 종료 직후 최초 전송)에서도 전송 기간이 끝났으면 보내지 않는다
  if (
    ViewLensStudy.getParticipationState(onboarding?.installDate) === "ended"
  ) {
    return failure(null, "participation_ended");
  }
  const eligibleForNotification = isFeedbackNotificationEligible(
    onboarding?.group,
    onboarding?.installDate,
  );
  const feedbackNotifiedAt = eligibleForNotification
    ? new Date().toISOString()
    : null;

  const result = await postSessionToServer(
    session,
    session.videoCount,
    onboarding,
    {
      ...metrics,
      feedbackNotifiedAt,
    },
  );

  // 409(중복 세션) — 이전 시도가 서버엔 이미 저장됐지만 응답만 못 받은 경우다. 서버가
  // 함께 보내주는 categoryDistribution/entropy로 로컬을 채우되, 값이 null이면
  // syncedToServer를 true로 확정하지 않아 다음 틱에 다시 시도되게 한다.
  if (result.status === 409) {
    const categoryDistribution = result.data?.categoryDistribution ?? null;
    await saveAnalysis(session.sessionId, {
      categoryDistribution,
      entropy: result.data?.entropy ?? null,
      syncedToServer: categoryDistribution !== null,
    });
    return result;
  }
  // 이번에도 실패 — syncedToServer는 false로 남아 다음 알람 틱에서 다시 시도된다.
  if (!result.ok || result.data === null) return result;
  const postResult = result.data;

  // 서버가 이번 응답으로 돌려준 categoryDistribution/entropy를 이제야 로컬에 채운다.
  await saveAnalysis(session.sessionId, {
    categoryDistribution: postResult.categoryDistribution,
    entropy: postResult.entropy,
    syncedToServer: postResult.categoryDistribution !== null,
  });

  const todayReview = postResult?.todayReview ?? null;
  if (todayReview) {
    await saveAnalysis(session.sessionId, {
      review: todayReview.review,
      reviewTopic: todayReview.reviewTopic,
    });
  }
  await mergeTodayReviewIntoCache(onboarding?.anonymousId, todayReview);
  console.log("[background] 오늘 리뷰 반영 완료:", todayReview);

  // 알림 자격은 그룹·베이스라인만으로 미리 정해지지만, 실제 알림은 todayReview가
  // 있을 때만 띄운다 — 전송 실패로 todayReview가 null이면 알림만 뜨고 팝업엔
  // "생성 중"만 보이는 불일치가 생기기 때문이다.
  if (eligibleForNotification && todayReview) {
    showFeedbackNotification(session);
  }
  return result;
}

/**
 * participants 등록이 확인되지 않은 상태면 서버에 다시 등록한다.
 *
 * 등록은 원래 팝업(viewlens-popup.js의 syncParticipant)에만 있었고, 실패하면 참여자가
 * 팝업을 다시 열 때까지 재시도 기회가 없었다. 그동안 모든 수집 API는 requireParticipant에서
 * 404로 거부되고, 데이터는 로컬 큐에 보존되지만 그날의 피드백(개입)과 기간 리뷰는 시간 창이
 * 지나 영구히 어긋난다. 대조군은 팝업을 열 동기가 없어 이 상태가 무기한 지속될 수 있다.
 * 그래서 재시도 주체를 알람(1분)으로 옮겨, 참여자가 아무 조작을 하지 않아도 풀리게 한다.
 *
 * 서버는 anonymousId 기준으로 멱등하므로(registerParticipant의 선조회 + UNIQUE 충돌 처리)
 * 팝업 쪽 호출과 겹쳐도 참여자가 중복 생성되지 않는다.
 * @returns {Promise<void>}
 */
export function ensureParticipantSynced() {
  return withQueueLock("participants", async () => {
    const state = await getParticipantSyncState();
    if (!state) return; // 온보딩 전이거나 필수 값 누락
    if (state.synced) return; // 이미 등록됨
    // 서버가 400으로 거부한 실패는 "같은 요청"을 다시 보내야 영원히 같은 답이 온다.
    if (
      state.failure?.kind === "permanent" &&
      state.failure.requestKey === state.requestKey
    ) {
      return;
    }

    const attempts = (state.failure?.attempts ?? 0) + 1;
    const result = await sendToServer("/api/participants", "POST", {
      anonymousId: state.anonymousId,
      participantCode: state.participantCode,
      group_code: state.group,
      installDate: state.installDate,
    });

    // config.js 미설정 환경에서는 요청 자체가 나가지 않는다. 실패로 기록하면 1분마다 storage만 쓰게 되므로 조용히 넘긴다.
    if (result.code === "no_server_url") return;

    if (result.ok) {
      await markParticipantSynced(result.data?.participantToken ?? null);
      console.log(
        `[background] queue=participants result=synced attempts=${attempts}`,
      );
      return;
    }

    // sendToServer의 분류를 그대로 쓴다.
    const kind = result.kind === "item" ? "permanent" : "retryable";
    await recordParticipantSyncFailure(
      kind,
      result.status,
      result.code,
      state.failure,
      state.requestKey,
    );
    console.warn(
      `[background] queue=participants result=${kind} status=${result.status} code=${result.code} attempts=${attempts}`,
    );
  });
}

/**
 * syncedToServer가 false로 남은(오프라인/서버 오류로 전송 실패한) 세션을 재전송한다.
 * 서버 장애·일시 오프라인으로 인한 연구 데이터 유실을 막는 유일한 재시도 경로다.
 * @returns {Promise<void>}
 */
export function retryUnsyncedSessions() {
  return withQueueLock("sessions", async () => {
    const sessions = await getAllSessions();
    // categoryDistribution 유무는 이제 필터 기준이 아니다 — 그 값은 서버 응답으로만
    // 채워지므로, syncedToServer:false만이 "전송 대기"를 나타내는 유일한 신호다.
    const unsynced = sessions.filter((s) => s.syncedToServer === false);
    await drainQueue(
      "sessions",
      unsynced,
      async (session) => {
        // 재시도라 최초 지연시간(totalMs)은 더 이상 의미가 없어 보내지 않는다.
        const result = await syncSessionToServer(session);
        // 409는 서버에 이미 저장된 세션이라 이 큐에서는 성공이다
        return result.status === 409
          ? { ...result, ok: true, kind: "success" }
          : result;
      },
      (session) =>
        saveAnalysis(session.sessionId, { syncedToServer: "invalid" }),
    );
  });
}

/**
 * 아직 sent:true가 안 된 영상 이벤트를 찾아 서버로 재전송한다. content.js의 즉시
 * 전송(fire-and-forget)이 실패하면 재시도가 전혀 없었던 문제를 보완한다.
 * @returns {Promise<void>}
 */
export function retryUnsentVideoEvents() {
  return withQueueLock("video_events", async () => {
    const onboarding = await getOnboarding();
    if (!onboarding?.anonymousId) return;

    const events = await getUnsentVideoEvents();
    await drainQueue(
      "video_events",
      events,
      async (event) => {
        const result = await postVideoEventToServer(
          onboarding.anonymousId,
          onboarding.participantToken,
          event,
        );
        if (result.ok) await markVideoEventSent(event);
        return result;
      },
      markVideoEventInvalid,
    );
  });
}

/**
 * 아직 서버에 확정 반영 못한 시청시간 원시 데이터를 재전송한다. "영상을 봤다"(sent)와
 * "얼마나 봤다"(watchStatsSent)는 서로 다른 시점에 확정되는 별개 신호라 독립된 큐로 돈다.
 * @returns {Promise<void>}
 */
export function retryUnsentWatchStats() {
  return withQueueLock("watch_stats", async () => {
    const onboarding = await getOnboarding();
    if (!onboarding?.anonymousId) return;

    const items = await getUnsentWatchStats();
    await drainQueue(
      "watch_stats",
      items,
      async (item) => {
        const result = await postWatchStatsToServer(
          onboarding.anonymousId,
          onboarding.participantToken,
          item,
        );
        if (result.ok) await markWatchStatsSent(item);
        return result;
      },
      markWatchStatsInvalid,
    );
  });
}

const inFlightQueues = new Set();

/**
 * 같은 큐의 이전 틱이 아직 진행 중이면(느린 응답·큰 백로그) 이번 틱을 건너뛴다.
 * 저장소 조회부터 잠가야 두 틱이 같은 항목을 동시에 보내지 않는다.
 * @param {string} name - 큐 이름
 * @param {() => Promise<void>} run
 * @returns {Promise<void>}
 */
async function withQueueLock(name, run) {
  if (inFlightQueues.has(name)) {
    console.log(`[background] queue=${name} result=reentry_blocked`);
    return;
  }
  inFlightQueues.add(name);
  try {
    await run();
  } catch (error) {
    // sendToServer는 네트워크 오류를 결과 객체로 바꿔 주지만 chrome.storage 실패는 그 바깥이라 그대로 튀어 오른다.
    console.error(
      `[background] queue=${name} result=crashed error=${error?.message}`,
    );
  } finally {
    inFlightQueues.delete(name);
  }
}

/**
 * 큐를 한 틱 처리한다. 큐 레벨 실패(참여자 미등록·서버 장애·네트워크 등)는 나머지 항목도
 * 같은 이유로 실패하므로 즉시 멈추고, 항목은 그대로 남겨 다음 틱에 다시 시도한다.
 * @param {string} name - 로그용 큐 이름
 * @param {object[]} items - 전송 대기 항목
 * @param {(item: object) => ReturnType<typeof sendToServer>} processItem - 전송·성공 표시 후 결과 반환
 * @param {(item: object) => Promise<void>} markInvalid - 서버가 400으로 영원히 거부한 항목을 큐에서 뺀다
 * @returns {Promise<void>}
 */
async function drainQueue(name, items, processItem, markInvalid) {
  if (items.length === 0) return;

  let sentThisTick = 0;
  let invalidThisTick = 0;
  let abortedBy = null;
  for (const item of items.slice(0, MAX_ITEMS_PER_TICK)) {
    const result = await processItem(item);
    if (result.ok) {
      sentThisTick += 1;
    } else if (result.kind === "queue") {
      abortedBy = result;
      break;
    } else {
      await markInvalid(item);
      invalidThisTick += 1;
      console.warn(
        `[background] queue=${name} result=skip_item status=${result.status} code=${result.code} id=${item.eventId ?? item.sessionId}`,
      );
    }
  }

  const pending = items.length - sentThisTick - invalidThisTick;
  const summary = `pending=${pending} sentThisTick=${sentThisTick} invalidThisTick=${invalidThisTick}`;
  if (abortedBy) {
    // 서버가 토큰을 거부했다면 participantSynced는 더 이상 진실이 아니다. 내려두면 다음 알람 틱에 게이트가 재등록해 토큰을 다시 받아온다.
    if (
      abortedBy.code === "INVALID_PARTICIPANT_TOKEN" &&
      (await invalidateParticipantSync())
    ) {
      console.warn(
        `[background] queue=${name} result=participant_invalidated status=${abortedBy.status}`,
      );
    }
    console.warn(
      `[background] queue=${name} result=abort status=${abortedBy.status} code=${abortedBy.code} ${summary}`,
    );
  } else {
    console.log(`[background] queue=${name} result=done ${summary}`);
  }
}

/**
 * 서버에 JSON 요청을 보내고 결과를 재시도 큐가 판단할 수 있는 형태로 분류한다.
 * - success: 2xx
 * - item: 400 — 이 항목만 서버가 영원히 거부한다
 * - queue: 그 외 전부(403·404·429·5xx·네트워크·타임아웃) — 큐의 다른 항목도 같은 이유로 실패한다
 * @param {string} path - /api/... 경로
 * @param {string} method
 * @param {object} body
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok: boolean, kind: "success"|"item"|"queue", status: number|null, code: string|null, data: any}>}
 */
export async function sendToServer(
  path,
  method,
  body,
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  if (!SERVER_URL || SERVER_URL.startsWith("YOUR_")) {
    return failure(null, "no_server_url");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${SERVER_URL.replace(/\/$/, "")}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await readJson(response);
    const status = response.status ?? (response.ok ? 200 : null);
    const code = typeof json?.code === "string" ? json.code : null;
    const data = json?.data ?? null;
    if (response.ok) {
      return { ok: true, kind: "success", status, code, data };
    }
    return {
      ok: false,
      kind: status === 400 ? "item" : "queue",
      status,
      code,
      data,
    };
  } catch (error) {
    return failure(null, error?.name === "AbortError" ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
}

function failure(status, code) {
  return { ok: false, kind: "queue", status, code, data: null };
}

// 본문이 JSON이 아니어도(프록시 오류 페이지 등) 전송 결과 분류는 status만으로 이어간다
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * 시청시간·배속·백그라운드 여부 하나를 PATCH로 서버에 반영한다.
 * @param {string} anonymousId
 * @param {string} participantToken
 * @param {{eventId: string, watchedSeconds: number, playbackRate: number, wasBackgrounded: 0|1}} item
 * @returns {ReturnType<typeof sendToServer>}
 */
async function postWatchStatsToServer(anonymousId, participantToken, item) {
  // 요청을 보내볼 수조차 없는 이 항목만의 결함이라 항목 레벨로 둔다
  if (!item.eventId) {
    return {
      ok: false,
      kind: "item",
      status: null,
      code: "missing_event_id",
      data: null,
    };
  }

  return sendToServer(
    `/api/video-events/${encodeURIComponent(item.eventId)}`,
    "PATCH",
    {
      anonymousId,
      participantToken,
      watchedSeconds: item.watchedSeconds,
      playbackRate: item.playbackRate,
      wasBackgrounded: item.wasBackgrounded,
    },
  );
}

/**
 * 영상 시청 이벤트 하나를 POST로 서버에 (재)전송한다. 같은 eventId는 서버가 멱등 처리한다.
 * @param {string} anonymousId
 * @param {string} participantToken
 * @param {object} event - videoId, title, watchedAt 등을 담은 이벤트
 * @returns {ReturnType<typeof sendToServer>}
 */
async function postVideoEventToServer(anonymousId, participantToken, event) {
  return sendToServer("/api/video-events", "POST", {
    anonymousId,
    participantToken,
    videoId: event.videoId,
    title: event.title ?? null,
    watchedAt: event.watchedAt,
    sessionId: event.sessionId,
    // 같은 eventId로 재전송되면 서버가 INSERT OR IGNORE로 걸러내 이미 성공했던 전송을 다시 보내도 중복 행이 남지 않는다.
    eventId: event.eventId,
    entryHost: event.entryHost,
    entryPath: event.entryPath,
    navigationTrigger: event.navigationTrigger,
    isShortsUrl: event.isShortsUrl,
  });
}

/**
 * 피드백 알림을 띄운다. notificationId로 sessionId를 그대로 써 별도 매핑 없이 역추적한다.
 * @param {object} session - 알림을 띄울 세션(sessionId 사용)
 * @returns {void}
 */
function showFeedbackNotification(session) {
  chrome.notifications.create(session.sessionId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("assets/icons/icon128.png"),
    title: "ViewLens",
    message: "방금 시청한 내용을 반영해 오늘의 피드백이 업데이트됐어요.",
    buttons: [{ title: "피드백 보러 가기" }],
  });
  // 개수 대신 있음/없음만 표시 — 정확한 미열람 개수는 연구 지표가 아니다.
  setUnviewedIconDot();
}

/**
 * 팝업이 읽는 "오늘 누적 리뷰 이력" 캐시에 방금 받은 리뷰 하나만 갈아 끼운다.
 * @param {string} anonymousId
 * @param {object|null} todayReview - 없으면(자격 없음) 아무 것도 하지 않음
 * @returns {Promise<void>}
 */
async function mergeTodayReviewIntoCache(anonymousId, todayReview) {
  if (!anonymousId || !todayReview) return;
  const { todayReviewsCache } =
    await chrome.storage.local.get("todayReviewsCache");
  const existing =
    todayReviewsCache?.anonymousId === anonymousId
      ? todayReviewsCache.reviews || []
      : [];
  const reviews = [
    ...existing.filter((r) => r.reviewDate !== todayReview.reviewDate),
    todayReview,
  ];
  await chrome.storage.local.set({
    todayReviewsCache: { anonymousId, reviews },
  });
}

/**
 * 세션 하나를 /api/sessions로 전송한다. 409(중복)면 서버가 이미 저장한
 * categoryDistribution/entropy가 result.data에 함께 담겨 온다.
 * @param {object} session - 전송할 세션(videos 포함)
 * @param {number} videoCount
 * @param {{anonymousId: string, participantToken: string}} onboarding
 * @param {{totalMs?: number, feedbackNotifiedAt?: string|null}} [metrics]
 * @returns {ReturnType<typeof sendToServer>}
 */
async function postSessionToServer(
  session,
  videoCount,
  onboarding,
  metrics = {},
) {
  if (!SERVER_URL || SERVER_URL.startsWith("YOUR_")) {
    console.warn(
      "[background] SERVER_URL이 설정되지 않았습니다. config.js 설정을 확인해주세요.",
    );
    return failure(null, "no_server_url");
  }

  if (!onboarding?.anonymousId) {
    console.warn("[background] anonymousId 없음, 서버 전송 건너뜀");
    return failure(null, "no_anonymous_id");
  }

  // categoryId 조회는 서버가 하므로, 이 세션에서 시청한 videoId 목록
  const videoIds = session.videos.map((v) => v.videoId);
  // videoIds와 병렬인 시청시간 원시값 — 서버가 video_events를 재조회하지 않고 이
  // 값을 그대로 쓴다(PATCH 재시도 지연으로 서버 쪽이 아직 비어있을 수 있어서).
  // 값 없는 영상은 null로 보내 서버 isValidWatch가 "모름"으로 처리한다.
  const watchedSecondsList = session.videos.map(
    (v) => v.watchedSeconds ?? null,
  );

  const result = await sendToServer(
    "/api/sessions",
    "POST",
    {
      anonymousId: onboarding.anonymousId,
      participantToken: onboarding.participantToken,
      sessionId: session.sessionId,
      startTime: session.startTime,
      endTime: session.endTime,
      videoCount,
      videoIds,
      watchedSecondsList,
      totalMs: metrics.totalMs,
      feedbackNotifiedAt: metrics.feedbackNotifiedAt,
    },
    SESSION_REQUEST_TIMEOUT_MS,
  );

  if (result.ok) {
    console.log("[background] 서버 전송 완료:", session.sessionId);
  } else {
    console.warn("[background] 서버 전송 실패:", result.status, result.code);
  }
  return result;
}
