import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_PATH = path.join(__dirname, "../content.js");

// content.js는 manifest.json에서 type:module이 아닌 일반 콘텐츠 스크립트로 선언돼 있어
// export를 붙이면 실제 브라우저에서 SyntaxError로 깨진다.
// 그래서 함수 정의 텍스트만 추출해 격리 실행한다.
const EXTRACT_VIDEO_ID_DECL = /function extractVideoId\(url\) \{[\s\S]*?\n\}/;
const PARSE_TITLE_DECL = /function parseTitle\(\) \{[\s\S]*?\n\}/;

function loadExtractVideoId() {
  const raw = readFileSync(CONTENT_PATH, "utf8");
  const match = raw.match(EXTRACT_VIDEO_ID_DECL);
  if (!match) {
    throw new Error(
      "extractVideoId 함수를 찾지 못했습니다 — content.js 구조가 바뀌었을 수 있습니다.",
    );
  }
  return new Function(`${match[0]}\nreturn extractVideoId;`)();
}

// parseTitle()은 인자 없이 전역 document.title을 읽으므로, document를 격리 함수의
// 매개변수로 넘겨 매번 다른 title 값으로 호출할 수 있는 래퍼를 만든다.
function loadParseTitle() {
  const raw = readFileSync(CONTENT_PATH, "utf8");
  const match = raw.match(PARSE_TITLE_DECL);
  if (!match) {
    throw new Error(
      "parseTitle 함수를 찾지 못했습니다 — content.js 구조가 바뀌었을 수 있습니다.",
    );
  }
  const factory = new Function("document", `${match[0]}\nreturn parseTitle();`);
  return (title) => factory({ title });
}

// classifyNavigationTrigger()는 모듈 스코프 변수(lastEndedAt/lastInteractionAt)를 직접
// 읽고 쓰므로, 함수 본문만 떼어내면 그 변수들이 없어 참조 에러가 난다. 선언부까지 함께
// 추출하고, 테스트에서 그 변수들을 직접 조작할 수 있게 setter를 얹어 반환한다.
const NAV_TRIGGER_DECL =
  /let lastEndedAt = null;[\s\S]*?\nfunction classifyNavigationTrigger\(now\) \{[\s\S]*?\n\}/;

function loadClassifyNavigationTrigger() {
  const raw = readFileSync(CONTENT_PATH, "utf8");
  const match = raw.match(NAV_TRIGGER_DECL);
  if (!match) {
    throw new Error(
      "classifyNavigationTrigger 관련 코드를 찾지 못했습니다 — content.js 구조가 바뀌었을 수 있습니다.",
    );
  }
  // 추출된 구간에 document.addEventListener("ended"/"click"/"keydown", ...) 등록도
  // 함께 포함돼 있다 — 실제 이벤트 발생은 이 테스트의 관심사가 아니므로 no-op으로 흘려보낸다.
  const factory = new Function(
    "document",
    `
    ${match[0]}
    return {
      classify: classifyNavigationTrigger,
      setEndedAt: (t) => { lastEndedAt = t; },
      setInteractionAt: (t) => { lastInteractionAt = t; },
    };
  `,
  );
  return factory({ addEventListener: () => {} });
}

describe("content.js extractVideoId", () => {
  let extractVideoId;

  beforeAll(() => {
    extractVideoId = loadExtractVideoId();
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

// server/routes/video-events-classify.js와 동일한 YOUTUBE_HOSTS 목록 선언까지 포함해서 추출해야
// parseEntryLocation 내부에서 참조하는 상수가 존재한다.
const PARSE_ENTRY_LOCATION_DECL =
  /const YOUTUBE_HOSTS = new Set\(\[[\s\S]*?\nfunction parseEntryLocation\(href\) \{[\s\S]*?\n\}/;

function loadParseEntryLocation() {
  const raw = readFileSync(CONTENT_PATH, "utf8");
  const match = raw.match(PARSE_ENTRY_LOCATION_DECL);
  if (!match) {
    throw new Error(
      "parseEntryLocation 함수를 찾지 못했습니다 — content.js 구조가 바뀌었을 수 있습니다.",
    );
  }
  return new Function(`${match[0]}\nreturn parseEntryLocation;`)();
}

describe("content.js parseEntryLocation", () => {
  let parseEntryLocation;

  beforeAll(() => {
    parseEntryLocation = loadParseEntryLocation();
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

  beforeAll(() => {
    parseTitle = loadParseTitle();
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

  beforeEach(() => {
    trigger = loadClassifyNavigationTrigger();
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
const RECORD_VIDEO_DECL =
  /let writeQueue = Promise\.resolve\(\);[\s\S]*?\nfunction recordVideo\(videoId, title, entryHost, entryPath, navigationTrigger\) \{[\s\S]*?\n\}/;

// recordVideo는 전역 chrome/fetch/console을 참조한다. 매개변수로 감싸서 넘기면 그 이름들이
// 지역 바인딩으로 가려지므로, 이 팩토리를 두 번 호출하는 것만으로 "서로 다른 탭 = 서로 다른
// writeQueue 클로저"를 실제 코드 그대로 재현할 수 있다(로직을 다시 옮겨 적지 않음).
function loadRecordVideoFactory() {
  const raw = readFileSync(CONTENT_PATH, "utf8");
  const match = raw.match(RECORD_VIDEO_DECL);
  if (!match) {
    throw new Error(
      "recordVideo 함수를 찾지 못했습니다 — content.js 구조가 바뀌었을 수 있습니다.",
    );
  }
  return new Function(
    "chrome",
    "fetch",
    "console",
    `${match[0]}\nreturn recordVideo;`,
  );
}

// 실제 chrome.storage.local과 동일하게 "탭이 몇 개든 저장소 자체는 하나"를 흉내 낸다.
// get()은 실제 API처럼 항상 독립된 사본을 돌려준다(구조적 복제) — 참조를 그대로 넘기면
// 여러 호출자가 같은 객체를 공유하는 비현실적인 상황이 된다.
function createSharedStorage(initial = {}) {
  let store = { ...initial };
  return {
    get(keys) {
      const out = {};
      for (const k of keys) {
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
        const out = {};
        for (const k of keys) {
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

describe("content.js recordVideo — 다중 탭 경합(연구 무결성 점검 항목 3)", () => {
  let recordVideoFactory;

  beforeAll(() => {
    recordVideoFactory = loadRecordVideoFactory();
  });

  function makeTab(sharedStorage) {
    const chromeMock = {
      runtime: { id: "fake-extension-id" },
      storage: { local: sharedStorage },
    };
    const fetchMock = () => Promise.resolve({ ok: true });
    const consoleMock = { log: () => {}, warn: () => {} };
    return recordVideoFactory(chromeMock, fetchMock, consoleMock);
  }

  it("한 탭에서 연달아 두 영상을 기록하면 각자 독립된 키에 둘 다 남는다", async () => {
    const storage = createSharedStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
    });
    const recordVideo = makeTab(storage);

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
    });
  });

  it("같은 영상이 새로고침으로 다시 감지되면(직전과 동일 videoId) 저장을 건너뛴다", async () => {
    const storage = createSharedStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
    });
    const recordVideo = makeTab(storage);

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
    const recordVideoTabA = makeTab(storage);
    const recordVideoTabB = makeTab(storage);

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
describe("content.js recordVideo — /api/video-events 전송 결과를 sent 플래그로 남긴다", () => {
  let recordVideoFactory;

  beforeAll(() => {
    recordVideoFactory = loadRecordVideoFactory();
  });

  function makeTabWithFetch(sharedStorage, fetchMock) {
    const chromeMock = {
      runtime: { id: "fake-extension-id" },
      storage: { local: sharedStorage },
    };
    const consoleMock = { log: () => {}, warn: () => {} };
    return recordVideoFactory(chromeMock, fetchMock, consoleMock);
  }

  it("서버가 200을 반환하면 해당 영상 키를 sent:true로 갱신한다", async () => {
    const storage = createSharedStorage({
      currentSession: { sessionId: "s1", startTime: "t0" },
      anonymousId: "a1",
      serverUrl: "http://localhost:3000",
    });
    const recordVideo = makeTabWithFetch(storage, () =>
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
    const recordVideo = makeTabWithFetch(storage, () =>
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
    const recordVideo = makeTabWithFetch(storage, () =>
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
    const recordVideo = makeTabWithFetch(storage, (_url, options) => {
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
