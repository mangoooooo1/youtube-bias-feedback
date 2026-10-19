import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import "../study-schedule.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_PATH = path.join(__dirname, "../content.js");

// content.js 전체를 새 인스턴스로 불러온다.
// 불러오는 순간 최상위 코드가 실행되므로 필요한 브라우저 전역을 먼저 가짜로 넣는다.
async function loadContent(env = {}) {
  vi.resetModules();
  const documentListeners = {};
  vi.stubGlobal("document", {
    referrer: "",
    title: "",
    hidden: false,
    addEventListener: (type, cb) => {
      (documentListeners[type] ??= []).push(cb);
    },
    querySelector: () => null,
    ...env.document,
  });
  vi.stubGlobal("window", { addEventListener: () => {}, ...env.window });
  vi.stubGlobal(
    "location",
    env.location ?? { href: "https://www.youtube.com/" },
  );
  vi.stubGlobal(
    "chrome",
    env.chrome ?? {
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
  );
  vi.stubGlobal("fetch", env.fetch ?? (() => Promise.resolve()));
  if (env.console) vi.stubGlobal("console", env.console);
  const api = (await import("../content.js")).default;
  return { api, documentListeners };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("content.js extractVideoId", () => {
  let extractVideoId;

  beforeEach(async () => {
    ({
      api: { extractVideoId },
    } = await loadContent());
  });

  it("/watch?v=ID 형태에서 영상 id를 추출한다", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=abc123")).toBe(
      "abc123",
    );
  });

  it("추가 쿼리 파라미터가 있어도 v 값만 추출한다", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=abc123&t=30s")).toBe(
      "abc123",
    );
  });

  it("/shorts/ID 형태에서 영상 id를 추출한다", () => {
    expect(extractVideoId("https://www.youtube.com/shorts/xyz789")).toBe(
      "xyz789",
    );
  });

  it("/shorts/ 뒤에 id가 없으면 null을 반환한다", () => {
    expect(extractVideoId("https://www.youtube.com/shorts/")).toBeNull();
  });

  it("/watch인데 v 파라미터가 없으면 null을 반환한다", () => {
    expect(extractVideoId("https://www.youtube.com/watch")).toBeNull();
  });

  it("/watch, /shorts/ 외의 경로는 null을 반환한다", () => {
    expect(
      extractVideoId("https://www.youtube.com/playlist?list=PL123"),
    ).toBeNull();
  });

  it("파싱 불가능한 URL 문자열은 예외 없이 null을 반환한다", () => {
    expect(extractVideoId("이건 URL이 아님")).toBeNull();
  });
});

describe("content.js parseEntryLocation", () => {
  let parseEntryLocation;

  beforeEach(async () => {
    ({
      api: { parseEntryLocation },
    } = await loadContent());
  });

  it("href가 없으면 entryHost/entryPath 모두 null을 반환한다", () => {
    expect(parseEntryLocation(null)).toEqual({
      entryHost: null,
      entryPath: null,
    });
  });

  it("유튜브 내부 URL이면 도메인과 경로를 모두 반환한다", () => {
    expect(
      parseEntryLocation("https://www.youtube.com/watch?v=abc123"),
    ).toEqual({ entryHost: "www.youtube.com", entryPath: "/watch" });
  });

  // 외부 사이트의 경로는 사용자명 등 직접 식별 정보를 담을 수 있어
  // 도메인만 남기고 경로는 애초에 수집하지 않아야 한다는 지적의 회귀 테스트.
  it("외부 URL이면 도메인만 반환하고 경로는 null로 비운다(개인 식별 정보 유출 방지)", () => {
    expect(
      parseEntryLocation("https://twitter.com/janedoe123/status/12345"),
    ).toEqual({ entryHost: "twitter.com", entryPath: null });
  });

  it("파싱 불가능한 값이면 entryHost/entryPath 모두 null을 반환한다", () => {
    expect(parseEntryLocation("이건 URL이 아님")).toEqual({
      entryHost: null,
      entryPath: null,
    });
  });
});

describe("content.js parseTitle", () => {
  let parseTitle;

  // parseTitle()은 인자 없이 전역 document.title을 읽으므로, 호출 전에 title을 바꿔 넣는 래퍼를 쓴다.
  beforeEach(async () => {
    const { api } = await loadContent();
    parseTitle = (title) => {
      globalThis.document.title = title;
      return api.parseTitle();
    };
  });

  it("안 읽은 알림 개수 접두사와 ' - YouTube' 접미사를 제거한다", () => {
    expect(parseTitle("(3) 영상 제목 - YouTube")).toBe("영상 제목");
  });

  it("접두사가 없어도 접미사만 제거한다", () => {
    expect(parseTitle("영상 제목 - YouTube")).toBe("영상 제목");
  });

  it("제목이 정확히 'YouTube'면 null을 반환한다(placeholder)", () => {
    expect(parseTitle("YouTube")).toBeNull();
  });

  it("접두사 제거 후 'YouTube'만 남아도 placeholder로 판정해 null을 반환한다", () => {
    expect(parseTitle("(5) YouTube")).toBeNull();
  });

  it("document.title이 빈 문자열이면 null을 반환한다", () => {
    expect(parseTitle("")).toBeNull();
  });

  it("공백만 있는 제목은 trim 후 빈 문자열이 되어 null을 반환한다", () => {
    expect(parseTitle("   ")).toBeNull();
  });
});

describe("content.js classifyNavigationTrigger", () => {
  let trigger;

  // lastEndedAt/lastInteractionAt은 모듈 내부 상태라, 그 시각으로 시계를 맞춘 뒤 content.js가
  // 실제로 등록한 ended/click 리스너를 실행해 기록하게 한다.
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { api, documentListeners } = await loadContent();
    const fire = (type, at) => {
      vi.setSystemTime(at);
      for (const cb of documentListeners[type]) cb();
    };
    trigger = {
      classify: api.classifyNavigationTrigger,
      setEndedAt: (t) => fire("ended", t),
      setInteractionAt: (t) => fire("click", t),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ended 신호가 최근이면 'ended'를 반환한다", () => {
    trigger.setEndedAt(1000);
    expect(trigger.classify(1500)).toBe("ended");
  });

  it("interaction 신호가 최근이면 'interaction'을 반환한다", () => {
    trigger.setInteractionAt(1000);
    expect(trigger.classify(1500)).toBe("interaction");
  });

  it("둘 다 없으면 알 수 없음(null)을 반환한다", () => {
    expect(trigger.classify(1500)).toBeNull();
  });

  it("둘 다 창(NAV_TRIGGER_WINDOW_MS)보다 오래됐으면 알 수 없음(null)을 반환한다", () => {
    trigger.setEndedAt(0);
    trigger.setInteractionAt(0);
    expect(trigger.classify(20000)).toBeNull();
  });

  it("더 최근에 일어난 쪽을 원인으로 고른다", () => {
    trigger.setEndedAt(1000);
    trigger.setInteractionAt(1400); // interaction이 더 최근
    expect(trigger.classify(1500)).toBe("interaction");
  });

  // 판정에 쓴 신호가 지워지지 않아, 신호 없이(뒤로가기 등)
  // 일어나는 다음 이동이 이미 써먹은 신호를 재사용해 잘못 분류되던 문제의 회귀 테스트.
  it("한 번 판정에 쓴 ended 신호는 다음 판정에 재사용되지 않는다", () => {
    trigger.setEndedAt(1000);
    expect(trigger.classify(1500)).toBe("ended"); // 1차 판정(자동재생 이동)

    // 새 신호 없이(예: 뒤로가기로 인한 popstate) 같은 창 안에서 다시 판정
    expect(trigger.classify(3000)).toBeNull();
  });

  it("한 번 판정에 쓴 interaction 신호도 다음 판정에 재사용되지 않는다", () => {
    trigger.setInteractionAt(1000);
    expect(trigger.classify(1500)).toBe("interaction");
    expect(trigger.classify(3000)).toBeNull();
  });
});

// recordVideo는 chrome.storage.local이라는 "탭 간에 공유되는" 저장소를 읽고(get) 고쳐서(modify)
// 다시 쓰는(set) 패턴이다. writeQueue는 같은 탭 안에서 recordVideo가 연달아 호출될 때만
// 순서를 보장한다 — 콘텐츠 스크립트는 유튜브 탭마다 완전히 독립된 실행 환경이라, 탭이
// 여러 개면 탭마다 별도의 writeQueue 변수를 갖는다. 이 테스트는 "탭 2개가 거의 동시에
// recordVideo를 호출하면" 두 writeQueue가 서로를 모른 채 같은 저장소를 놓고 경합해
// 한쪽의 기록이 사라지는지를 재현한다(연구 무결성 점검 항목 3).
//
// content.js를 새 인스턴스로 불러와 그 recordVideo를 돌려준다. 두 번 부르면 "서로 다른 탭 =
// 서로 다른 writeQueue"가 된다. 전역 chrome/fetch는 나중에 부른 쪽으로 바뀌므로, 탭끼리
// 저장소·fetch가 같아야 하는 테스트에서만 쓴다.
async function loadRecordVideo(chromeMock, fetchMock, consoleMock) {
  const { api } = await loadContent({
    chrome: chromeMock,
    fetch: fetchMock,
    console: consoleMock,
  });
  return api.recordVideo;
}

// 실제 chrome.storage.local과 동일하게 "탭이 몇 개든 저장소 자체는 하나"를 흉내 낸다.
// get()은 실제 API처럼 항상 독립된 사본을 돌려준다(구조적 복제) — 참조를 그대로 넘기면
// 여러 호출자가 같은 객체를 공유하는 비현실적인 상황이 된다.
function createSharedStorage(initial = {}) {
  let store = { ...initial };
  return {
    get(keys) {
      // 실제 chrome.storage.local.get()은 string|string[]|null 세 형태를 모두 받는다.
      // finalizePreviousWatchStats(content.js)가 videoKey 하나만 문자열로 넘기는
      // 호출부를 추가하면서 이 세 형태를 모두 지원하도록 맞췄다(storage.test.js의
      // createChromeStorageMock과 동일한 계약).
      const keyList = keys == null ? Object.keys(store) : [].concat(keys);
      const out = {};
      for (const k of keyList) {
        out[k] = store[k] === undefined ? undefined : structuredClone(store[k]);
      }
      return Promise.resolve(out);
    },
    set(obj) {
      store = { ...store, ...structuredClone(obj) };
      return Promise.resolve();
    },
    dump: () => structuredClone(store),
  };
}

// get()/set() 응답을 테스트가 원하는 순서로 하나씩 풀어주는 저장소 — 두 탭의 요청이
// 정확히 어떤 순서로 끼어드는지를 타이밍 운에 맡기지 않고 결정론적으로 재현하기 위함.
function createControllableStorage(initial = {}) {
  let store = { ...initial };
  const pending = [];
  function schedule(run) {
    return new Promise((resolve) => {
      pending.push(() => resolve(run()));
    });
  }
  return {
    get(keys) {
      return schedule(() => {
        // 실제 chrome.storage.local.get()은 확장 메시징 경계를 거쳐 값을 직렬화해
        // 돌려주므로 호출자마다 항상 독립된 사본을 받는다(참조 공유가 아님) — 여기서
        // 구조적 복제 없이 store[k]를 그대로 돌려주면, 두 탭이 "같은 객체"를 나눠 갖는
        // 비현실적인 상황이 되어 정작 재현하려는 경합이 숨어버린다.
        // createSharedStorage와 동일하게 string|string[]|null 세 형태를 모두 지원한다.
        const keyList = keys == null ? Object.keys(store) : [].concat(keys);
        const out = {};
        for (const k of keyList) {
          out[k] =
            store[k] === undefined ? undefined : structuredClone(store[k]);
        }
        return out;
      });
    },
    set(obj) {
      return schedule(() => {
        store = { ...store, ...structuredClone(obj) };
      });
    },
    dump: () => structuredClone(store),
    pendingCount: () => pending.length,
    // 대기 중인 응답 중 가장 오래된 것 하나를 지금 풀어준다(FIFO).
    release() {
      const op = pending.shift();
      if (op) op();
    },
  };
}

// release()가 프라미스를 resolve해도 그 이어지는 코드(await 다음 줄)는 다음 마이크로태스크에서
// 실행된다 — release 사이사이에 이걸로 큐를 완전히 비워 "다음 storage 호출이 pending에 실제로
// 잡혔는지"를 안정적으로 확인할 수 있게 한다.
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

function collectVideos(storeDump, sessionId) {
  return Object.entries(storeDump)
    .filter(([k]) => k.startsWith(`video__${sessionId}__`))
    .map(([, v]) => v);
}

// handleVideoChange 재진입 경합 — 실제 recordVideo가 저장소에 남긴 영상 기록으로 검증한다.
// 홈 화면 주소로 불러온다. 영상 주소로 불러오면 최상위 handleVideoChange()가 그 영상을 미리 기록해
// 테스트의 첫 호출이 "같은 영상"으로 무시된다.
describe("content.js handleVideoChange — 재진입 경합(연구 무결성 점검 항목 4)", () => {
  let handleVideoChange, storage, documentMock, locationMock;

  beforeEach(async () => {
    vi.useFakeTimers();
    storage = createSharedStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
    });
    const { api } = await loadContent({
      document: { title: "YouTube" },
      chrome: {
        runtime: { id: "fake-extension-id" },
        storage: { local: storage },
      },
      console: { log: () => {}, warn: () => {} },
    });
    handleVideoChange = api.handleVideoChange;
    documentMock = globalThis.document;
    locationMock = globalThis.location;
    locationMock.href = "https://www.youtube.com/watch?v=AAAA";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 실제로 관측된 데이터 오염 재현: 영상 A로 이동했지만 title이 아직 "YouTube"
  // 플레이스홀더라 A의 waitForTitle이 재시도 타이머로 대기하는 사이, 더 빠르게 영상 B로
  // 이동해 title이 곧바로 반영되면(B의 waitForTitle은 동기적으로 해결) — A의 재시도
  // 타이머가 나중에 돌 때도 document.title은 여전히 B의 값이라, 재진입 방지가 없으면
  // A가 B의 title을 가로채 videoId A + title B로 잘못 기록한다.
  it("빠른 연속 이동 시 이전 호출이 다음 이동의 title을 가로채 기록하지 않는다", async () => {
    const callA = handleVideoChange();

    locationMock.href = "https://www.youtube.com/watch?v=BBBB";
    documentMock.title = "영상 B 실제 제목 - YouTube";
    const callB = handleVideoChange();

    await callB;
    // A의 재시도 타이머(200ms)를 흘려보낸다 — 이 시점에도 document.title은 여전히 B의 값이다.
    await vi.advanceTimersByTimeAsync(250);
    await callA;

    const videos = collectVideos(storage.dump(), "s1");
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({
      videoId: "BBBB",
      title: "영상 B 실제 제목",
    });
  });

  it("겹치지 않는 순차 이동은 평소처럼 각각 기록된다(재진입 방지가 정상 흐름을 막지 않음)", async () => {
    documentMock.title = "영상 A 실제 제목 - YouTube";
    await handleVideoChange();

    locationMock.href = "https://www.youtube.com/watch?v=BBBB";
    documentMock.title = "영상 B 실제 제목 - YouTube";
    await handleVideoChange();

    const videos = collectVideos(storage.dump(), "s1");
    expect(videos).toHaveLength(2);
    expect(videos[0]).toMatchObject({
      videoId: "AAAA",
      title: "영상 A 실제 제목",
    });
    expect(videos[1]).toMatchObject({
      videoId: "BBBB",
      title: "영상 B 실제 제목",
    });
  });
});

describe("content.js recordVideo — 다중 탭 경합(연구 무결성 점검 항목 3)", () => {
  async function makeTab(sharedStorage) {
    const chromeMock = {
      runtime: { id: "fake-extension-id" },
      storage: { local: sharedStorage },
    };
    const fetchMock = () => Promise.resolve({ ok: true });
    const consoleMock = { log: () => {}, warn: () => {} };
    return loadRecordVideo(chromeMock, fetchMock, consoleMock);
  }

  it("한 탭에서 연달아 두 영상을 기록하면 각자 독립된 키에 둘 다 남는다", async () => {
    const storage = createSharedStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
    });
    const recordVideo = await makeTab(storage);

    await recordVideo("v1", "영상1");
    await recordVideo("v2", "영상2");

    const ids = collectVideos(storage.dump(), "s1")
      .map((v) => v.videoId)
      .sort();
    expect(ids).toEqual(["v1", "v2"]);
    expect(storage.dump().currentSession.videoCount).toBe(2);
    expect(storage.dump().lastRecordedVideo).toEqual({
      videoId: "v2",
      sessionId: "s1",
      eventId: expect.any(String),
    });
  });

  it("같은 영상이 새로고침으로 다시 감지되면(직전과 동일 videoId) 저장을 건너뛴다", async () => {
    const storage = createSharedStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
    });
    const recordVideo = await makeTab(storage);

    await recordVideo("v1", "영상1");
    await recordVideo("v1", "영상1"); // 새로고침으로 같은 영상이 다시 감지된 상황

    const videos = collectVideos(storage.dump(), "s1");
    expect(videos).toHaveLength(1);
    expect(storage.dump().currentSession.videoCount).toBe(1);
  });

  it("탭 두 개가 거의 동시에 서로 다른 영상을 기록해도 둘 다 남는다(다중 탭 경합 수정 확인)", async () => {
    const storage = createControllableStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
    });
    // 탭 A와 탭 B는 실제로도 서로 다른 콘텐츠 스크립트 인스턴스라 writeQueue를 공유하지
    // 않는다 — 별도로 만든 두 recordVideo가 정확히 그 상황을 재현한다.
    const recordVideoTabA = await makeTab(storage);
    const recordVideoTabB = await makeTab(storage);

    const pA = recordVideoTabA("vA", "탭A 영상");
    const pB = recordVideoTabB("vB", "탭B 영상");
    await flushMicrotasks();

    // recordVideo는 이제 탭당 storage 호출이 get() 1번 + set() 1번, 총 두 번뿐이다
    // (예전엔 get 1번 + set 2번). 두 탭 모두 서로의 쓰기를 모르는 상태로 읽게 만든다.
    expect(storage.pendingCount()).toBe(2); // A.get, B.get 대기 중
    storage.release(); // A: currentSession/lastRecordedVideo를 읽음
    storage.release(); // B: 마찬가지로 읽음(A의 쓰기가 아직 없었으므로 동일한 값)
    await flushMicrotasks();

    expect(storage.pendingCount()).toBe(2); // A.set, B.set — 각자 고유 키(video__s1__<uuid>)로 쓴다
    storage.release(); // A가 먼저 씀
    await flushMicrotasks();
    storage.release(); // B가 그다음 씀 — 서로 다른 키라 A의 기록을 건드리지 않는다
    await Promise.all([pA, pB]);

    const ids = collectVideos(storage.dump(), "s1")
      .map((v) => v.videoId)
      .sort();
    // 예전 구현(currentSession.videos 배열 하나를 공유)에서는 여기서 vA가 사라졌다.
    // 영상마다 독립된 키를 쓰는 지금은 어느 순서로 쓰든 절대 충돌하지 않는다.
    expect(ids).toEqual(["vA", "vB"]);

    // videoCount는 화면 표시용 참고치일 뿐이라, 이런 경합 상황에선 실제 영상 수(2)보다
    // 적게(1) 어긋날 수 있다는 걸 알고 넘어간다 — 데이터 유실이 아니라 표시 오차라는
    // 트레이드오프를 문서화해 둔다(session.js 주석 참고).
    expect(storage.dump().currentSession.videoCount).toBe(1);
  });
});

// 연구 무결성 점검: /api/video-events 즉시 전송이 fire-and-forget이라 실패해도 조용히
// 버려지던 문제. 이제 성공 여부를 sent 플래그로 남겨, background.js의 재시도 큐
// (retryUnsentVideoEvents)가 실패분을 찾아낼 수 있게 한다.

// captureWatchStatsSnapshot
// 파일을 처음 불러올 때 최상위 handleVideoChange()가 resetWatchTracker()보다 먼저 실행돼
// watchTracker가 아직 null이다. 이 순간에도 예외 없이 진행돼야 첫 영상이 기록된다.
describe("content.js captureWatchStatsSnapshot", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("영상 페이지에서 처음 불러올 때 watchTracker가 아직 없어도 예외 없이 첫 영상을 기록한다", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const set = vi.fn(async () => {});
    const { api } = await loadContent({
      document: { title: "첫 영상 - YouTube" },
      location: { href: "https://www.youtube.com/watch?v=FIRST" },
      chrome: {
        runtime: { id: "fake-extension-id" },
        storage: { local: { get: async () => ({}), set } },
      },
    });

    await vi.waitFor(() => expect(set).toHaveBeenCalled());
    expect(set.mock.calls[0][0].lastRecordedVideo.videoId).toBe("FIRST");
    // 최상위 resetWatchTracker()까지 끝나 이후에는 스냅샷을 만들 수 있다
    expect(api.captureWatchStatsSnapshot()).not.toBeNull();
  });
});

// currentWatchedMs — 순수 함수
describe("content.js currentWatchedMs", () => {
  let currentWatchedMs;

  beforeEach(async () => {
    ({
      api: { currentWatchedMs },
    } = await loadContent());
  });

  it("tracker가 없으면 0을 반환한다", () => {
    expect(currentWatchedMs(null)).toBe(0);
  });

  it("열린 구간이 없으면(재생 중이 아님) accumulatedMs만 반환한다", () => {
    expect(
      currentWatchedMs({ accumulatedMs: 12345, segmentStartAt: null }),
    ).toBe(12345);
  });

  it("열린 구간이 있으면 지금까지의 경과분을 더한다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    expect(
      currentWatchedMs({ accumulatedMs: 5000, segmentStartAt: 3000 }),
    ).toBe(5000 + (10000 - 3000));
    vi.useRealTimers();
  });
});

// ── 비디오 엘리먼트 계측 통합 테스트
// 벽시계 경과 시간(Date.now() 차이) 기반으로 바뀌었는지를 실제 play/pause/seeking/seeked 이벤트를 발생시켜 검증한다.
function createFakeVideoElement({ paused = true, playbackRate = 1 } = {}) {
  const listeners = {};
  return {
    paused,
    playbackRate,
    addEventListener(type, cb) {
      (listeners[type] ??= []).push(cb);
    },
    removeEventListener(type, cb) {
      listeners[type] = (listeners[type] || []).filter((fn) => fn !== cb);
    },
    dispatch(type) {
      for (const cb of listeners[type] || []) cb();
    },
  };
}

// 불러오는 순간의 최상위 resetWatchTracker()는 <video>가 없는 페이지로 지나가게 하고,
// 그 뒤 querySelector가 videoEl을 돌려주게 해 테스트의 reset() 시점에 연결되게 한다.
async function loadVideoTrackingSection(videoEl, { hidden = false } = {}) {
  let video = null;
  const { api } = await loadContent({
    document: { hidden, querySelector: () => video },
  });
  video = videoEl;
  return {
    reset: api.resetWatchTracker,
    snapshot: api.captureWatchStatsSnapshot,
    currentWatchedMs: () =>
      api.captureWatchStatsSnapshot().watchedSeconds * 1000,
  };
}

describe("content.js 비디오 엘리먼트 계측 — 벽시계 경과 시간 기반 누적 (코드리뷰 회귀)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("2배속으로 실제 15초를 재생해도 watchedSeconds는 15초로 기록된다(콘텐츠 소비량이 아니라 벽시계 경과 시간)", async () => {
    const videoEl = createFakeVideoElement({ paused: false, playbackRate: 2 });
    const section = await loadVideoTrackingSection(videoEl);

    section.reset(); // attachVideoTracking이 이미 재생 중임을 감지해 즉시 구간을 연다.
    vi.setSystemTime(15000); // 벽시계 15초 경과(재생 상태 유지)

    expect(section.currentWatchedMs()).toBe(15000);
  });

  it("0.5배속으로 실제 30초를 재생해도 watchedSeconds는 30초로 기록된다(과소평가되지 않음)", async () => {
    const videoEl = createFakeVideoElement({
      paused: false,
      playbackRate: 0.5,
    });
    const section = await loadVideoTrackingSection(videoEl);

    section.reset();
    vi.setSystemTime(30000);

    expect(section.currentWatchedMs()).toBe(30000);
  });

  it("pause 중에는 시간이 누적되지 않고, 재개하면 그 이후부터 다시 누적된다", async () => {
    const videoEl = createFakeVideoElement({ paused: false });
    const section = await loadVideoTrackingSection(videoEl);

    section.reset();
    vi.setSystemTime(10000); // 10초 재생

    videoEl.paused = true;
    videoEl.dispatch("pause");
    vi.setSystemTime(40000); // 30초간 일시정지 상태로 방치

    expect(section.currentWatchedMs()).toBe(10000); // 정지 구간은 누적 안 됨

    videoEl.paused = false;
    videoEl.dispatch("play");
    vi.setSystemTime(45000); // 재개 후 5초 더 재생

    expect(section.currentWatchedMs()).toBe(15000);
  });

  it("탐색(seeking) 중에는 시간이 누적되지 않고, 탐색 종료 후 재생 중이면 다시 누적된다", async () => {
    const videoEl = createFakeVideoElement({ paused: false });
    const section = await loadVideoTrackingSection(videoEl);

    section.reset();
    vi.setSystemTime(5000); // 5초 재생 후 탐색 시작
    videoEl.dispatch("seeking");
    vi.setSystemTime(5100); // 탐색 자체는 100ms 만에 끝났다고 가정
    videoEl.dispatch("seeked"); // paused=false이므로 다시 구간이 열린다
    vi.setSystemTime(15100); // 10초 더 재생

    expect(section.currentWatchedMs()).toBe(15000); // 5000 + 10000, 탐색 100ms는 제외
  });

  it("탐색 후 일시정지 상태로 남으면(paused=true) 재생을 다시 열지 않는다", async () => {
    const videoEl = createFakeVideoElement({ paused: false });
    const section = await loadVideoTrackingSection(videoEl);

    section.reset();
    vi.setSystemTime(3000);
    videoEl.dispatch("seeking");
    videoEl.paused = true; // 탐색 중 일시정지로 남겨둠
    videoEl.dispatch("seeked");
    vi.setSystemTime(20000); // 17초 동안 정지 상태

    expect(section.currentWatchedMs()).toBe(3000); // 늘어나지 않아야 함
  });

  it("영상이 처음부터 일시정지 상태면(자동재생 꺼짐) 시간이 쌓이지 않는다", async () => {
    const videoEl = createFakeVideoElement({ paused: true });
    const section = await loadVideoTrackingSection(videoEl);

    section.reset();
    vi.setSystemTime(20000);

    expect(section.currentWatchedMs()).toBe(0);
  });

  it("ratechange 발생 시 마지막 배속 값을 기록한다(시간 계산에는 영향 없이 원시 데이터로만 보존)", async () => {
    const videoEl = createFakeVideoElement({ paused: false, playbackRate: 1 });
    const section = await loadVideoTrackingSection(videoEl);

    section.reset();
    videoEl.playbackRate = 1.5;
    videoEl.dispatch("ratechange");

    expect(section.snapshot().playbackRate).toBe(1.5);
  });
});

async function loadTrackedVideoIdentityHelpers() {
  const { api } = await loadContent();
  return {
    remember: api.rememberTrackedVideo,
    capture: api.captureTrackedVideoIdentity,
  };
}

// pagehide 핸들러 — 코드리뷰 지적 회귀 테스트(탭 종료 시에도 공유 lastRecordedVideo가
// 아니라 이 탭 자신의 trackedVideoIdentity만 써야 한다). content.js가 window에 등록한
// 실제 핸들러를 받아 실행하고, applyWatchStatsPatch의 로컬 저장 결과로 검증한다.
async function loadPagehideHandler(sharedStorage, fetchMock) {
  let pagehide = null;
  let video = null;
  const { api } = await loadContent({
    chrome: {
      runtime: { id: "fake-extension-id" },
      storage: { local: sharedStorage },
    },
    fetch: fetchMock,
    window: {
      addEventListener: (type, cb) => {
        if (type === "pagehide") pagehide = cb;
      },
    },
    document: { querySelector: () => video },
    console: { log: () => {}, warn: () => {} },
  });
  return {
    api,
    pagehide: () => pagehide(),
    // 0초부터 seconds초까지 재생한 뒤 멈춘다 — 닫힌 구간 seconds초만 남는다
    watchThenPause(seconds) {
      const videoEl = createFakeVideoElement({ paused: false });
      video = videoEl;
      api.resetWatchTracker();
      vi.setSystemTime(seconds * 1000);
      videoEl.paused = true;
      videoEl.dispatch("pause");
    },
  };
}

describe("content.js pagehide 핸들러 — 탭별 식별자만 사용한다(코드리뷰 회귀: 다른 탭의 공유 lastRecordedVideo 오염 방지)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // pagehide는 로컬 저장에만 최선노력을 기울인다(네트워크 전송은 background.js의
  // 재시도 큐 몫 — 파일 상단 주석 "탭 종료 시... 로컬에만 남긴다" 참고). 그래서 이
  // 테스트는 network PATCH가 아니라 로컬 storage 갱신 결과로 검증한다.
  it("이 탭의 trackedVideoIdentity로만 로컬 video_events 기록을 갱신하고, 공유 lastRecordedVideo가 가리키는 다른 탭의 항목은 건드리지 않는다", async () => {
    const storage = createSharedStorage({
      anonymousId: "a1",
      serverUrl: "http://localhost:3000",
      // 다른 탭이 마지막으로 써 둔 값이라고 가정 — 이 값은 쓰이면 안 된다.
      lastRecordedVideo: {
        videoId: "other-tab-video",
        sessionId: "s-other",
        eventId: "evt-other",
      },
      "video__s1__evt-mine": {
        videoId: "vMine",
        eventId: "evt-mine",
        sent: true,
      },
      "video__s-other__evt-other": {
        videoId: "other-tab-video",
        eventId: "evt-other",
        sent: true,
      },
    });
    const fetchMock = () => Promise.resolve({ ok: true });
    const tab = await loadPagehideHandler(storage, fetchMock);
    // 이미 닫힌 구간 77초만 있고(재생 중은 아님) — captureWatchStatsSnapshot이
    // currentWatchedMs로 계산해 77초를 그대로 돌려줘야 한다.
    tab.watchThenPause(77);
    tab.api.rememberTrackedVideo("s1", "evt-mine");

    tab.pagehide();
    await flushMicrotasks();
    await flushMicrotasks();

    // 다른 탭 소유로 가정한 evt-other는 절대 건드리면 안 된다.
    const untouched = storage.dump()["video__s-other__evt-other"];
    expect(untouched.watchedSeconds).toBeUndefined();

    // 이 탭 자신의 항목(evt-mine)만 로컬에 갱신되고, watchStatsSent:false로 남아
    // background.js의 재시도 큐가 실제 전송을 맡는다.
    const mine = storage.dump()["video__s1__evt-mine"];
    expect(mine.watchedSeconds).toBe(77);
    expect(mine.watchStatsSent).toBe(false);
  });

  // watchTracker는 content.js를 불러오는 순간 만들어져 pagehide 시점에 없을 수 없다.
  // 그래서 "trackedVideoIdentity가 없을 때"만 검증한다. pagehide는 네트워크를 쓰지 않으므로
  // PATCH 0회만으로는 아무것도 지키지 못해, 저장소가 그대로인지까지 확인한다.
  it("trackedVideoIdentity가 없으면(첫 영상도 아직 없음) 아무 것도 하지 않는다", async () => {
    // 다른 탭이 써 둔 공유 값 — 자기 식별자가 없다고 이쪽으로 대신 쓰면 안 된다.
    const storage = createSharedStorage({
      anonymousId: "a1",
      lastRecordedVideo: {
        videoId: "other-tab-video",
        sessionId: "s-other",
        eventId: "evt-other",
      },
      "video__s-other__evt-other": {
        videoId: "other-tab-video",
        eventId: "evt-other",
        sent: true,
      },
    });
    const patchCalls = [];
    const fetchMock = (_url, options) => {
      if (options?.method === "PATCH") patchCalls.push(1);
      return Promise.resolve({ ok: true });
    };
    const tab = await loadPagehideHandler(storage, fetchMock);
    tab.watchThenPause(5);
    const before = storage.dump();

    tab.pagehide();
    await flushMicrotasks();

    expect(patchCalls).toHaveLength(0);
    expect(storage.dump()).toEqual(before);
  });
});

describe("content.js trackedVideoIdentity — 세션 타임아웃에 영향받지 않는 시청시간 확정 대상 추적 (코드리뷰 회귀)", () => {
  it("초기값은 null이다", async () => {
    const { capture } = await loadTrackedVideoIdentityHelpers();
    expect(capture()).toBeNull();
  });

  it("rememberTrackedVideo로 기억해 둔 값을 그대로 돌려준다", async () => {
    const { remember, capture } = await loadTrackedVideoIdentityHelpers();
    remember("s1", "evt-1");
    expect(capture()).toEqual({ sessionId: "s1", eventId: "evt-1" });
  });

  it("여러 번 기억하면 가장 최근 값으로 덮어쓴다(영상이 여러 번 전환된 경우)", async () => {
    const { remember, capture } = await loadTrackedVideoIdentityHelpers();
    remember("s1", "evt-1");
    remember("s1", "evt-2");
    expect(capture()).toEqual({ sessionId: "s1", eventId: "evt-2" });
  });
});

describe("content.js recordVideo — /api/video-events 전송 결과를 sent 플래그로 남긴다", () => {
  async function makeTabWithFetch(sharedStorage, fetchMock) {
    const chromeMock = {
      runtime: { id: "fake-extension-id" },
      storage: { local: sharedStorage },
    };
    const consoleMock = { log: () => {}, warn: () => {} };
    return loadRecordVideo(chromeMock, fetchMock, consoleMock);
  }

  it("서버가 200을 반환하면 해당 영상 키를 sent:true로 갱신한다", async () => {
    const storage = createSharedStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
      anonymousId: "a1",
      serverUrl: "http://localhost:3000",
    });
    const recordVideo = await makeTabWithFetch(storage, () =>
      Promise.resolve({ ok: true }),
    );

    await recordVideo("v1", "영상1");
    await flushMicrotasks();
    await flushMicrotasks();

    const videos = collectVideos(storage.dump(), "s1");
    expect(videos).toHaveLength(1);
    expect(videos[0].sent).toBe(true);
  });

  it("서버가 오류 응답을 반환하면 sent:false로 남아 재시도 큐의 대상이 된다", async () => {
    const storage = createSharedStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
      anonymousId: "a1",
      serverUrl: "http://localhost:3000",
    });
    const recordVideo = await makeTabWithFetch(storage, () =>
      Promise.resolve({ ok: false, status: 500 }),
    );

    await recordVideo("v1", "영상1");
    await flushMicrotasks();
    await flushMicrotasks();

    const videos = collectVideos(storage.dump(), "s1");
    expect(videos).toHaveLength(1);
    expect(videos[0].sent).toBe(false);
  });

  it("네트워크 오류로 fetch 자체가 실패해도 예외 없이 sent:false로 남는다", async () => {
    const storage = createSharedStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
      anonymousId: "a1",
      serverUrl: "http://localhost:3000",
    });
    const recordVideo = await makeTabWithFetch(storage, () =>
      Promise.reject(new TypeError("network down")),
    );

    await recordVideo("v1", "영상1");
    await flushMicrotasks();
    await flushMicrotasks();

    const videos = collectVideos(storage.dump(), "s1");
    expect(videos).toHaveLength(1);
    expect(videos[0].sent).toBe(false);
  });

  it("서버가 멱등 처리(OR IGNORE)할 수 있도록, 로컬에 저장한 eventId와 서버로 보낸 eventId가 같다", async () => {
    const storage = createSharedStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
      anonymousId: "a1",
      serverUrl: "http://localhost:3000",
    });
    let sentBody = null;
    const recordVideo = await makeTabWithFetch(storage, (_url, options) => {
      sentBody = JSON.parse(options.body);
      return Promise.resolve({ ok: true });
    });

    await recordVideo("v1", "영상1");
    await flushMicrotasks();
    await flushMicrotasks();

    const videos = collectVideos(storage.dump(), "s1");
    expect(videos[0].eventId).toEqual(expect.any(String));
    expect(sentBody.eventId).toBe(videos[0].eventId);
  });
});

// 시청시간 원시 데이터 — 다음 영상으로 전환될 때 직전 영상의 시청시간을
// PATCH로 확정 반영하는지 검증한다.
describe("content.js recordVideo — previousWatchStats로 직전 영상의 시청시간을 확정한다", () => {
  async function makeTabWithFetch(sharedStorage, fetchMock) {
    const chromeMock = {
      runtime: { id: "fake-extension-id" },
      storage: { local: sharedStorage },
    };
    const consoleMock = { log: () => {}, warn: () => {} };
    return loadRecordVideo(chromeMock, fetchMock, consoleMock);
  }

  it("직전 영상의 eventId로 PATCH /api/video-events/:eventId를 호출하고, 성공하면 로컬 기록을 watchStatsSent:true로 남긴다", async () => {
    const storage = createSharedStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
      anonymousId: "a1",
      serverUrl: "http://localhost:3000",
    });
    const patchCalls = [];
    const recordVideo = await makeTabWithFetch(storage, (url, options) => {
      if (options?.method === "PATCH") {
        patchCalls.push({ url: String(url), body: JSON.parse(options.body) });
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: true }); // POST(신규 영상 기록)
    });

    // 영상 A 기록(previousWatchStats 없음 — 아직 직전 영상이 없음)
    await recordVideo("vA", "영상A");
    await flushMicrotasks();
    const eventIdA = collectVideos(storage.dump(), "s1")[0].eventId;

    // 영상 B로 전환하며 영상 A의 시청시간 스냅샷과 식별자를 함께 전달 — 실제로는
    // handleVideoChange가 captureTrackedVideoIdentity()로 얻어 넘기는 값이다(이
    // 테스트는 recordVideo를 직접 호출하므로 그 값을 인자로 직접 재현한다).
    await recordVideo(
      "vB",
      "영상B",
      null,
      null,
      null,
      null,
      { watchedSeconds: 55.5, playbackRate: 1, wasBackgrounded: 0 },
      { sessionId: "s1", eventId: eventIdA },
    );
    await flushMicrotasks();
    await flushMicrotasks();

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].url).toBe(
      `http://localhost:3000/api/video-events/${eventIdA}`,
    );
    expect(patchCalls[0].body).toMatchObject({
      anonymousId: "a1",
      watchedSeconds: 55.5,
      playbackRate: 1,
      wasBackgrounded: 0,
    });

    const videoA = collectVideos(storage.dump(), "s1").find(
      (v) => v.eventId === eventIdA,
    );
    expect(videoA.watchStatsSent).toBe(true);
    expect(videoA.watchedSeconds).toBe(55.5);
  });

  it("PATCH가 실패하면 watchStatsSent:false로 남아 재시도 큐 대상이 된다", async () => {
    const storage = createSharedStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
      anonymousId: "a1",
      serverUrl: "http://localhost:3000",
    });
    const recordVideo = await makeTabWithFetch(storage, (_url, options) =>
      options?.method === "PATCH"
        ? Promise.resolve({ ok: false, status: 500 })
        : Promise.resolve({ ok: true }),
    );

    await recordVideo("vA", "영상A");
    await flushMicrotasks();
    const eventIdA = collectVideos(storage.dump(), "s1")[0].eventId;

    await recordVideo(
      "vB",
      "영상B",
      null,
      null,
      null,
      null,
      { watchedSeconds: 20, playbackRate: 1, wasBackgrounded: 0 },
      { sessionId: "s1", eventId: eventIdA },
    );
    await flushMicrotasks();
    await flushMicrotasks();

    const videoA = collectVideos(storage.dump(), "s1").find(
      (v) => v.eventId === eventIdA,
    );
    expect(videoA.watchStatsSent).toBe(false);
    expect(videoA.watchedSeconds).toBe(20);
  });

  it("previousWatchStats가 없으면(첫 영상 등) PATCH를 시도하지 않는다", async () => {
    const storage = createSharedStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
      anonymousId: "a1",
      serverUrl: "http://localhost:3000",
    });
    const patchCalls = [];
    const recordVideo = await makeTabWithFetch(storage, (_url, options) => {
      if (options?.method === "PATCH") patchCalls.push(1);
      return Promise.resolve({ ok: true });
    });

    await recordVideo("vA", "영상A");
    await flushMicrotasks();

    expect(patchCalls).toHaveLength(0);
  });

  // 코드리뷰 지적 회귀 테스트: 한 영상을 10분 넘게 끊기지 않고 계속 보면
  // checkSessionTimeout이 세션을 먼저 종료해(lastWatchedAt이 영상 "시작" 시각에
  // 고정돼 있으므로) video__ 키가 sessions[]로 옮겨가고 storage의 lastRecordedVideo도
  // null이 된다. 이 상황을 그대로 재현한다.
  it("세션이 먼저 타임아웃돼 storage의 lastRecordedVideo가 null이어도, previousVideoIdentity(이 탭 메모리)로 직전 영상을 찾아 확정한다", async () => {
    const storage = createSharedStorage({
      // endSession이 이미 실행된 상태를 재현: currentSession/lastRecordedVideo는
      // null이고, 영상 A는 sessions[].videos[]로 옮겨가 있다(라이브 video__ 키 없음).
      currentSession: null,
      lastRecordedVideo: null,
      anonymousId: "a1",
      serverUrl: "http://localhost:3000",
      sessions: [
        {
          sessionId: "s1",
          videos: [
            {
              videoId: "vA",
              title: "영상A",
              eventId: "evt-A",
              sent: true,
              watchStatsSent: undefined,
            },
          ],
        },
      ],
    });
    const patchCalls = [];
    const recordVideo = await makeTabWithFetch(storage, (url, options) => {
      if (options?.method === "PATCH") {
        patchCalls.push({ url: String(url), body: JSON.parse(options.body) });
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: true });
    });

    // handleVideoChange가 captureTrackedVideoIdentity()로 얻어 전달했을 값을 그대로
    // 재현 — 세션 타임아웃과 무관하게 이 탭이 기억하고 있던 영상 A의 식별자.
    await recordVideo(
      "vB",
      "영상B",
      null,
      null,
      null,
      null,
      { watchedSeconds: 620, playbackRate: 1, wasBackgrounded: 0 },
      { sessionId: "s1", eventId: "evt-A" },
    );
    await flushMicrotasks();
    await flushMicrotasks();

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].url).toBe(
      "http://localhost:3000/api/video-events/evt-A",
    );
    expect(patchCalls[0].body).toMatchObject({ watchedSeconds: 620 });

    // 라이브 키가 아니라 sessions[].videos[] 안의 해당 항목이 갱신됐는지 확인 —
    // dual-location 조회가 실제로 동작했다는 증거.
    const { sessions } = storage.dump();
    const videoA = sessions[0].videos.find((v) => v.eventId === "evt-A");
    expect(videoA.watchedSeconds).toBe(620);
    expect(videoA.watchStatsSent).toBe(true);
  });

  // 코드리뷰 지적 회귀 테스트: storage의 lastRecordedVideo는 모든 탭이 공유한다.
  // previousVideoIdentity(이 탭 자신의 메모리)가 비어 있다고 해서(탭 재로드 직후 등)
  // 공유 storage 값으로 대체하면, 그게 실은 "다른 탭이 마지막으로 기록한 영상"일 수
  // 있어 엉뚱한 eventId에 이 탭의 시청시간을 붙이게 된다. 그런 폴백을 두지 않고
  // 조용히 포기하는지 확인한다(데이터 유실 < 데이터 오염).
  it("previousVideoIdentity가 없으면(탭 재로드 등) storage의 lastRecordedVideo로 대체하지 않고 PATCH를 시도하지 않는다", async () => {
    const storage = createSharedStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
      // 다른 탭이 마지막으로 써 둔 값이라고 가정 — 이 값을 오인해 쓰면 안 된다.
      lastRecordedVideo: { videoId: "vA", sessionId: "s1", eventId: "evt-A" },
      anonymousId: "a1",
      serverUrl: "http://localhost:3000",
      "video__s1__evt-A": {
        videoId: "vA",
        eventId: "evt-A",
        sent: true,
      },
    });
    const patchCalls = [];
    const recordVideo = await makeTabWithFetch(storage, (_url, options) => {
      if (options?.method === "PATCH") patchCalls.push(1);
      return Promise.resolve({ ok: true });
    });

    // previousVideoIdentity를 아예 안 넘긴다(탭 재로드로 이 탭의 메모리가 비어있는 상황) —
    // 7번째 인자 생략.
    await recordVideo("vB", "영상B", null, null, null, null, {
      watchedSeconds: 33,
      playbackRate: 1,
      wasBackgrounded: 0,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(patchCalls).toHaveLength(0);
    // 공유 storage의 값(다른 탭 소유로 가정한 evt-A)도 건드리지 않았어야 한다.
    const untouched = storage.dump()["video__s1__evt-A"];
    expect(untouched.watchedSeconds).toBeUndefined();
  });

  // 코드리뷰가 지적한 시나리오를 두 개의 독립된 recordVideo 인스턴스(=탭)로 직접
  // 재현한다: 탭 A가 영상1을 기록한 뒤, 탭 B가(별도 실행 컨텍스트) 영상2를 기록해
  // 공유 storage의 lastRecordedVideo를 자신의 것으로 덮어쓴다. 그 다음 탭 A가
  // 영상3으로 이동하면, 탭 A는 (공유 storage가 아니라) 자신이 기억해 둔 영상1의
  // eventId로만 확정해야 한다.
  it("탭 A의 시청시간 확정이 탭 B가 덮어쓴 공유 lastRecordedVideo의 영향을 받지 않는다(다중 탭 격리)", async () => {
    const storage = createSharedStorage({
      anonymousId: "a1",
      serverUrl: "http://localhost:3000",
    });
    const patchCalls = [];
    const fetchMock = (_url, options) => {
      if (options?.method === "PATCH") {
        patchCalls.push({ url: String(_url) });
      }
      return Promise.resolve({ ok: true });
    };
    const recordVideoTabA = await makeTabWithFetch(storage, fetchMock);
    const recordVideoTabB = await makeTabWithFetch(storage, fetchMock);

    // 탭 A: 영상1 기록 — 탭 A 자신의 trackedVideoIdentity에 영상1의 eventId가 남는다
    // (이 테스트에서는 recordVideoTabA 클로저 자체가 그 역할을 못하므로, 탭 A가
    // 이후 넘길 previousVideoIdentity를 직접 캡처해 재사용한다).
    await recordVideoTabA("video1", "영상1");
    await flushMicrotasks();
    const videoKey1 = Object.keys(storage.dump()).find((k) =>
      k.startsWith("video__"),
    );
    const [, sessionId1, eventId1] = videoKey1.split("__");

    // 탭 B: 별도 세션에서 영상2 기록 — 공유 storage의 lastRecordedVideo를 자신의
    // 것(영상2)으로 덮어쓴다.
    await recordVideoTabB("video2", "영상2");
    await flushMicrotasks();
    expect(storage.dump().lastRecordedVideo.videoId).toBe("video2");

    // 탭 A: 영상3으로 이동. previousVideoIdentity로 "자신이 기억해 둔" 영상1의
    // eventId를 명시적으로 전달한다(handleVideoChange가 실제로 하는 일을 재현).
    await recordVideoTabA(
      "video3",
      "영상3",
      null,
      null,
      null,
      null,
      { watchedSeconds: 40, playbackRate: 1, wasBackgrounded: 0 },
      { sessionId: sessionId1, eventId: eventId1 },
    );
    await flushMicrotasks();
    await flushMicrotasks();

    // 탭 A가 확정한 PATCH는 영상1(자신의 직전 영상)의 eventId여야 하고, 탭 B가
    // 공유 storage에 남긴 영상2의 eventId로는 절대 나가면 안 된다.
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].url).toBe(
      `http://localhost:3000/api/video-events/${eventId1}`,
    );
  });

  it("라이브 키·sessions[] 어디에도 대상이 없으면(참여자가 데이터를 지운 경우 등) 예외 없이 조용히 포기한다", async () => {
    const storage = createSharedStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
      anonymousId: "a1",
      serverUrl: "http://localhost:3000",
    });
    const patchCalls = [];
    const recordVideo = await makeTabWithFetch(storage, (_url, options) => {
      if (options?.method === "PATCH") patchCalls.push(1);
      return Promise.resolve({ ok: true });
    });

    await expect(
      recordVideo(
        "vB",
        "영상B",
        null,
        null,
        null,
        null,
        { watchedSeconds: 10, playbackRate: 1, wasBackgrounded: 0 },
        { sessionId: "s-gone", eventId: "evt-gone" },
      ),
    ).resolves.toBeUndefined();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(patchCalls).toHaveLength(0);
  });

  // 직전 영상(A)의 POST가 아직 응답을 못 받은 상태에서,
  // 다음 영상(B)으로 전환하며 A의 시청시간 확정(PATCH 경로, applyWatchStatsPatch)이
  // 먼저 끝나버리면 그 뒤 뒤늦게 도착한 A의 POST 성공 콜백이 옛 클로저 값으로
  // videoKey 전체를 재작성해 방금 병합된 watchedSeconds/watchStatsSent를 지워버리는지
  // 확인한다. 이 테스트는 POST 응답을 의도적으로 지연시켜(deferred) 그 순서를
  // 결정론적으로 재현한다.
  it("직전 영상의 POST 응답이 늦게 도착해도, 먼저 병합된 시청시간을 덮어쓰지 않는다", async () => {
    const storage = createSharedStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
      anonymousId: "a1",
      serverUrl: "http://localhost:3000",
    });
    let resolveVideoAPost;
    const videoAPostPromise = new Promise((resolve) => {
      resolveVideoAPost = () => resolve({ ok: true });
    });
    const recordVideo = await makeTabWithFetch(storage, (_url, options) => {
      if (options?.method === "PATCH") return Promise.resolve({ ok: true });
      const body = JSON.parse(options.body);
      if (body.videoId === "vA") return videoAPostPromise; // 아직 응답 안 옴
      return Promise.resolve({ ok: true }); // vB의 POST 등
    });

    // 영상 A 기록 — POST가 발사되지만 위 deferred promise 때문에 아직 끝나지 않는다.
    await recordVideo("vA", "영상A");
    await flushMicrotasks();
    const eventIdA = collectVideos(storage.dump(), "s1")[0].eventId;
    expect(collectVideos(storage.dump(), "s1")[0].sent).toBe(false); // 아직 미확정

    // 영상 B로 전환 — A의 시청시간 확정(merge + PATCH)이 A의 POST보다 먼저 끝난다.
    await recordVideo(
      "vB",
      "영상B",
      null,
      null,
      null,
      null,
      { watchedSeconds: 88, playbackRate: 1, wasBackgrounded: 0 },
      { sessionId: "s1", eventId: eventIdA },
    );
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    // 이 시점에 A의 시청시간은 이미 병합·확정돼 있어야 한다.
    let videoA = collectVideos(storage.dump(), "s1").find(
      (v) => v.eventId === eventIdA,
    );
    expect(videoA.watchedSeconds).toBe(88);
    expect(videoA.watchStatsSent).toBe(true);

    // 이제야 A의 POST가 뒤늦게 응답한다 — 이 시점의 성공 콜백이 병합된 값을
    // 지우면 안 된다.
    resolveVideoAPost();
    await flushMicrotasks();
    await flushMicrotasks();

    videoA = collectVideos(storage.dump(), "s1").find(
      (v) => v.eventId === eventIdA,
    );
    expect(videoA.sent).toBe(true); // POST 성공 반영은 여전히 일어나야 한다
    expect(videoA.watchedSeconds).toBe(88); // 하지만 지워지면 안 된다
    expect(videoA.watchStatsSent).toBe(true);
  });
});

// handleVideoChange부터 resetWatchTracker까지 실제 파일 그대로 통째로 이어 붙여 실행한다.
// resetWatchTracker를 별도 리스너로 두면 handleVideoChange가 스냅샷을
// 만들기도 전에 watchTracker를 초기화해, 영상A → 비영상 페이지 → 무관한 영상C로 이동할 때
// A의 시청시간이 0으로 오염될 수 있었다는 지적을 "영상 엘리먼트 재생 → 실제 URL 이동" 흐름
// 그대로 재현해 검증한다.
// 영상 수명주기 전체를 실제 content.js로 돌린다. loadContent는 document를 복사해 전역에 넣으므로,
// 테스트가 title을 바꿀 수 있게 실제로 들어간 전역 document를 함께 돌려준다.
// getTrackedVideoIdentity는 실제 captureTrackedVideoIdentity와 같은 함수다(trackedVideoIdentity를 그대로 반환).
async function loadFullVideoLifecycle(
  documentMock,
  locationMock,
  chromeMock,
  fetchMock,
) {
  const { api } = await loadContent({
    document: documentMock,
    location: locationMock,
    chrome: chromeMock,
    fetch: fetchMock,
    console: { log: () => {}, warn: () => {} },
  });
  return {
    api: {
      handleVideoChange: api.handleVideoChange,
      getTrackedVideoIdentity: api.captureTrackedVideoIdentity,
    },
    document: globalThis.document,
  };
}

// finalizePreviousWatchStats는 handleVideoChange 안에서 await 없이(fire-and-forget) 호출된다.
// vi.useFakeTimers() 아래에서는 setTimeout 기반 flushMicrotasks가 동작하지 않으므로(타이머를 실제로 진행시켜야
// resolve됨), 순수 마이크로태스크만 여러 번 흘려보내 그 내부의 await 체인이 다 끝나게 한다.
async function flushPendingMicrotasks(times = 10) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

// lastRecordedVideo도 eventId 필드를 갖고 있어 storage 전체를 eventId로만 뒤지면 그쪽이
// 먼저 잡힐 수 있다 — 실제 video_events 행("video__" 키)만 대상으로 좁혀 찾는다.
function findVideoRecordByEventId(storeDump, eventId) {
  return Object.entries(storeDump)
    .filter(([k]) => k.startsWith("video__"))
    .map(([, v]) => v)
    .find((v) => v?.eventId === eventId);
}

describe("content.js handleVideoChange 전체 수명주기 — 비영상 페이지 경유 시 직전 영상 시청시간 오염 방지 (코드리뷰 회귀 5)", () => {
  let videoEl, documentMock, locationMock, storage, api;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    videoEl = createFakeVideoElement({ paused: true });
    documentMock = {
      title: "YouTube",
      referrer: "",
      hidden: false,
      addEventListener: () => {},
      querySelector: () => videoEl,
    };
    locationMock = { href: "https://www.youtube.com/" };
    // serverUrl을 비워 둬 PATCH/POST 네트워크 전송은 건너뛰고(다른 테스트에서 이미 검증됨)
    // 로컬 storage 병합 결과만으로 오염 여부를 확인한다.
    storage = createSharedStorage({});
    const chromeMock = {
      runtime: { id: "fake-extension-id" },
      storage: { local: storage },
    };
    const fetchMock = () =>
      Promise.reject(new Error("이 테스트는 네트워크 전송이 없어야 한다"));

    // 불러오는 순간 최상위 handleVideoChange()·resetWatchTracker()가 실행된다
    // (비영상 페이지라 조용히 반환됨) — 실제 스크립트 로드 순서와 동일하다.
    ({ api, document: documentMock } = await loadFullVideoLifecycle(
      documentMock,
      locationMock,
      chromeMock,
      fetchMock,
    ));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("영상A 시청 후 비영상 페이지를 거쳐 무관한 영상C로 이동해도 A의 시청시간은 42초로 확정되고 이후 0으로 재오염되지 않는다", async () => {
    // 1) 영상 A 진입
    locationMock.href = "https://www.youtube.com/watch?v=AAAA";
    documentMock.title = "영상 A 실제 제목 - YouTube";
    await api.handleVideoChange();

    const eventIdA = api.getTrackedVideoIdentity()?.eventId;
    expect(eventIdA).toEqual(expect.any(String));

    // 2) A를 42초 동안 실제로 재생
    videoEl.paused = false;
    videoEl.dispatch("play");
    vi.setSystemTime(42000);
    videoEl.paused = true;
    videoEl.dispatch("pause");

    // 3) 비영상 페이지(홈)로 이탈 — 여기서 A의 시청시간이 먼저 확정돼야 한다.
    locationMock.href = "https://www.youtube.com/";
    await api.handleVideoChange();
    await flushPendingMicrotasks(); // finalizePreviousWatchStats(비동기, 미대기)를 흘려보낸다

    // lastRecordedVideo도 eventId 필드를 갖고 있어 find로 통째로 뒤지면 그쪽이 먼저 잡힌다 —
    // 실제 video_events 행("video__" 키)만 대상으로 찾는다.
    let videoA = findVideoRecordByEventId(storage.dump(), eventIdA);
    expect(videoA.watchedSeconds).toBe(42);

    // 비영상 페이지 이탈 시 이 탭의 추적 대상은 비워져야 다음 영상이 A를 잘못 재확정하지 않는다.
    expect(api.getTrackedVideoIdentity()).toBeNull();

    // 4) 완전히 무관한 영상 C로 이동
    locationMock.href = "https://www.youtube.com/watch?v=CCCC";
    documentMock.title = "영상 C 실제 제목 - YouTube";
    await api.handleVideoChange();
    await flushPendingMicrotasks();

    // A는 두 번째로 확정되지 않아(previousVideoIdentity가 이미 비워짐) 42초 그대로 남아야 한다 —
    // 고쳐지기 전에는 리셋된 watchTracker(0초)가 다시 A의 eventId에 병합돼 0으로 덮어썼다.
    videoA = findVideoRecordByEventId(storage.dump(), eventIdA);
    expect(videoA.watchedSeconds).toBe(42);

    // C는 정상적으로 새로 기록된다.
    const videoC = Object.entries(storage.dump())
      .filter(([k]) => k.startsWith("video__"))
      .map(([, v]) => v)
      .find((v) => v?.videoId === "CCCC");
    expect(videoC).toBeDefined();
  });

  it("같은 영상이 계속 재생 중일 때(스퓨리어스 재이벤트)는 누적 중인 시청시간이 초기화되지 않는다", async () => {
    locationMock.href = "https://www.youtube.com/watch?v=AAAA";
    documentMock.title = "영상 A 실제 제목 - YouTube";
    await api.handleVideoChange();
    const eventIdA = api.getTrackedVideoIdentity()?.eventId;
    expect(eventIdA).toEqual(expect.any(String));

    videoEl.paused = false;
    videoEl.dispatch("play");
    vi.setSystemTime(20000); // 20초 재생 중

    // 스퓨리어스 재이벤트: 같은 videoId로 다시 호출됨
    await api.handleVideoChange();

    vi.setSystemTime(25000); // 5초 더 재생(초기화됐다면 여기서 5초만 잡혀야 함)
    videoEl.dispatch("pause");

    // 재이벤트가 resetWatchTracker를 호출했다면 20초가 사라지고 5초만 남았을 것이다.
    // 아직 확정 전이라 storage에는 watchedSeconds가 없다 — 대신 getTrackedVideoIdentity로
    // 추적이 끊기지 않았는지, 그리고 다음 이탈에서 실제로 25초가 확정되는지로 검증한다.
    expect(findVideoRecordByEventId(storage.dump(), eventIdA)).toBeDefined();

    locationMock.href = "https://www.youtube.com/";
    await api.handleVideoChange();
    await flushPendingMicrotasks();

    const finalized = findVideoRecordByEventId(storage.dump(), eventIdA);
    expect(finalized.watchedSeconds).toBe(25); // 20+5, 재이벤트로 끊기지 않음
  });
});

describe("content.js 참여 기간 종료 — 새 수집 중단", () => {
  // installDate 1970-01-01T09:00 KST → 수집 종료 1970-01-13 00:00 KST, 전송 종료 3일 뒤
  const INSTALL_DATE = "1970-01-01T00:00:00.000Z";
  const COLLECTION_ENDS_AT = Date.parse("1970-01-13T00:00:00+09:00");
  const TRANSMISSION_ENDS_AT = COLLECTION_ENDS_AT + 3 * 86400000;

  let videoEl, documentMock, locationMock, storage, fetchCalls, api;

  async function setup(initialStorage) {
    videoEl = createFakeVideoElement({ paused: true });
    documentMock = {
      title: "YouTube",
      referrer: "",
      hidden: false,
      addEventListener: () => {},
      querySelector: () => videoEl,
    };
    locationMock = { href: "https://www.youtube.com/" };
    storage = createSharedStorage(initialStorage);
    fetchCalls = [];
    const fetchMock = (url, options = {}) => {
      fetchCalls.push({ url, method: options.method });
      return Promise.resolve({ ok: true });
    };
    ({ api, document: documentMock } = await loadFullVideoLifecycle(
      documentMock,
      locationMock,
      { runtime: { id: "fake-extension-id" }, storage: { local: storage } },
      fetchMock,
    ));
  }

  async function watch(videoId, seconds) {
    locationMock.href = `https://www.youtube.com/watch?v=${videoId}`;
    documentMock.title = `영상 ${videoId} - YouTube`;
    await api.handleVideoChange();
    await flushPendingMicrotasks();
    videoEl.paused = false;
    videoEl.dispatch("play");
    vi.setSystemTime(Date.now() + seconds * 1000);
    videoEl.paused = true;
    videoEl.dispatch("pause");
  }

  function recordedVideoIds() {
    return Object.entries(storage.dump())
      .filter(([k]) => k.startsWith("video__"))
      .map(([, v]) => v.videoId);
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("수집 종료 후 본 영상은 기록하지 않고, 그 시청시간이 종료 전 영상에 붙지 않는다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(COLLECTION_ENDS_AT - 60000);
    await setup({ installDate: INSTALL_DATE });

    await watch("AAAA", 30);
    const eventIdA = api.getTrackedVideoIdentity()?.eventId;

    vi.setSystemTime(COLLECTION_ENDS_AT + 1000);
    await watch("BBBB", 50); // 종료 후 — 기록되지 않아야 한다
    expect(api.getTrackedVideoIdentity()).toBeNull();

    await watch("CCCC", 10);
    locationMock.href = "https://www.youtube.com/";
    await api.handleVideoChange();
    await flushPendingMicrotasks();

    expect(recordedVideoIds()).toEqual(["AAAA"]);
    // A는 종료 전 30초로 확정되고, 종료 후 본 B의 50초로 덮이지 않는다
    expect(
      findVideoRecordByEventId(storage.dump(), eventIdA).watchedSeconds,
    ).toBe(30);
    expect(storage.dump().currentSession.videoCount).toBe(1);
  });

  it("수집 종료 후에는 새 영상 POST를 보내지 않는다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(COLLECTION_ENDS_AT + 1000);
    await setup({
      installDate: INSTALL_DATE,
      anonymousId: "a1",
      serverUrl: "https://srv.example",
    });

    await watch("AAAA", 10);

    expect(recordedVideoIds()).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });

  it.each([
    ["유예 기간", COLLECTION_ENDS_AT + 1000, 1],
    ["전송 종료 후", TRANSMISSION_ENDS_AT + 1000, 0],
  ])(
    "종료 전 영상의 시청시간을 %s에 확정하면 로컬에는 남기고 PATCH는 %i건 보낸다",
    async (_label, finalizeAt, expectedPatches) => {
      vi.useFakeTimers();
      vi.setSystemTime(COLLECTION_ENDS_AT - 60000);
      await setup({
        installDate: INSTALL_DATE,
        anonymousId: "a1",
        serverUrl: "https://srv.example",
      });

      await watch("AAAA", 30);
      const eventIdA = api.getTrackedVideoIdentity()?.eventId;

      vi.setSystemTime(finalizeAt);
      locationMock.href = "https://www.youtube.com/";
      await api.handleVideoChange();
      await flushPendingMicrotasks();

      expect(
        findVideoRecordByEventId(storage.dump(), eventIdA).watchedSeconds,
      ).toBe(30);
      expect(fetchCalls.filter((c) => c.method === "PATCH")).toHaveLength(
        expectedPatches,
      );
    },
  );
});

describe("content.js recordVideo — 기록 실패를 오류 보고로 넘긴다", () => {
  async function makeFailingTab({ invalidateOnFailure = false } = {}) {
    const chromeMock = {
      runtime: {
        id: "fake-extension-id",
        sendMessage: vi.fn(() => Promise.resolve()),
      },
      storage: {
        local: {
          get: () => {
            if (invalidateOnFailure) delete chromeMock.runtime.id;
            return Promise.reject(new Error("QUOTA_BYTES quota exceeded"));
          },
          set: () => Promise.resolve(),
        },
      },
    };
    const consoleMock = { log: () => {}, warn: () => {} };
    const recordVideo = await loadRecordVideo(
      chromeMock,
      () => Promise.resolve({ ok: true }),
      consoleMock,
    );
    return { recordVideo, sendMessage: chromeMock.runtime.sendMessage };
  }

  it("storage 실패면 RECORD_FAILED를 코드·위치만 담아 background에 보낸다", async () => {
    const { recordVideo, sendMessage } = await makeFailingTab();

    await recordVideo("v1", "민감한 영상 제목", "www.google.com", null);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toEqual({
      type: "client-error",
      code: "RECORD_FAILED",
      where: "content.recordVideo",
    });
    const sent = JSON.stringify(sendMessage.mock.calls);
    expect(sent).not.toContain("민감한");
    expect(sent).not.toContain("v1");
    expect(sent).not.toContain("google");
    expect(sent).not.toContain("QUOTA");
  });

  it("컨텍스트가 무효화돼 실패했으면 보고하지 않는다", async () => {
    const { recordVideo, sendMessage } = await makeFailingTab({
      invalidateOnFailure: true,
    });

    await recordVideo("v1", "영상1");

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

// 브라우저는 content.js를 module·exports가 없는 classic script로 실행한다. 테스트용 내보내기
// 블록이 그 환경에서 오류를 내거나 전역을 만들지 않는지 같은 조건(vm, 모듈 아님)으로 확인한다.
describe("content.js classic script 실행 — 테스트용 내보내기가 브라우저에 영향을 주지 않는다", () => {
  function createBrowserLikeContext() {
    return vm.createContext({
      document: {
        referrer: "",
        title: "",
        hidden: false,
        addEventListener: () => {},
        querySelector: () => null,
      },
      window: { addEventListener: () => {} },
      location: { href: "https://www.youtube.com/" },
      chrome: {
        storage: { local: { get: async () => ({}), set: async () => {} } },
      },
      fetch: () => Promise.resolve(),
      ViewLensStudy: globalThis.ViewLensStudy,
      console: { log: () => {}, warn: () => {}, error: () => {} },
      crypto: globalThis.crypto,
      setTimeout,
    });
  }

  it("모듈이 아닌 스크립트로 파싱된다(export 문이 없다)", () => {
    expect(
      () => new vm.Script(readFileSync(CONTENT_PATH, "utf8")),
    ).not.toThrow();
  });

  it("module이 없는 환경에서 오류 없이 실행되고 module·exports를 만들지 않는다", () => {
    const context = createBrowserLikeContext();
    expect(() =>
      vm.runInContext(readFileSync(CONTENT_PATH, "utf8"), context),
    ).not.toThrow();
    expect(context.module).toBeUndefined();
    expect(context.exports).toBeUndefined();
  });
});
