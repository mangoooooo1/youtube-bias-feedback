// @vitest-environment jsdom
/* global document, FileReader */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { loadPopup } from "./load-popup.js";
import {
  SERVER,
  bootPopup,
  cleanupPopup,
  daysAgo,
  hasHome,
  participant,
  stubReload,
} from "./boot-popup.js";

// 온보딩을 마친 뒤의 등록·복구·초기화, 팝업을 닫을 때의 마지막 기록 전송,
// 열려 있는 동안 1초마다 바뀌는 "수집 중" 표시를 실제 팝업(boot)으로 확인한다.
let BASELINE_DAYS;

beforeAll(async () => {
  const g = await loadPopup();
  ({ BASELINE_DAYS } = g.VL);
  vi.unstubAllGlobals();
});

afterEach(cleanupPopup);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const click = (root, selector) => root.querySelector(selector).click();

async function submitCode(root, code) {
  root.querySelector("#vl-onboard-input").value = code;
  click(root, "#vl-onboard-btn");
}

describe("온보딩 완료 후", () => {
  it("처음 등록하는 코드면 새 익명 ID·설치일을 저장하고 서버에 등록한 뒤 홈 화면을 보여 준다", async () => {
    const { root, data, server } = await bootPopup(
      { serverUrl: SERVER },
      {
        responses: {
          "/api/participants/validate": {
            data: { valid: true, group_code: "EXP" },
          },
        },
      },
    );
    const before = Date.now();
    await submitCode(root, "ab-cdef");
    await vi.waitFor(() => expect(data.participantSynced).toBe(true));

    expect(data).toMatchObject({
      group: "EXP",
      participantCode: "AB-CDEF",
      participantToken: "new-tok",
    });
    expect(data.anonymousId).toMatch(UUID);
    expect(Date.parse(data.installDate)).toBeGreaterThanOrEqual(before);
    const reg = server.calls.find((c) => c.path === "/api/participants");
    expect(reg.body).toEqual({
      anonymousId: data.anonymousId,
      participantCode: "AB-CDEF",
      group_code: "EXP",
      installDate: data.installDate,
    });
    expect(hasHome(root)).toBe(true);
  });

  it("코드를 입력한 직후 첫 화면부터 머리말에 참여 코드가 보인다", async () => {
    const { root } = await bootPopup(
      { serverUrl: SERVER },
      {
        responses: {
          "/api/participants/validate": {
            data: { valid: true, group_code: "CON" },
          },
        },
      },
    );
    await submitCode(root, "ab-cdef");
    await vi.waitFor(() => expect(hasHome(root)).toBe(true));
    expect(root.textContent).toContain("참여 중 · AB-CDEF");
  });

  it("재설치 복구를 고르면 서버가 돌려준 기존 값을 저장하고 새로 등록하지 않고 다시 연다", async () => {
    const oldInstall = daysAgo(3);
    const { root, data, server } = await bootPopup(
      { serverUrl: SERVER },
      {
        responses: {
          "/api/participants/validate": {
            data: {
              valid: true,
              group_code: "CON",
              previouslyRegistered: true,
            },
          },
          "/api/participants/recover": {
            data: {
              anonymousId: "old-anon",
              participantToken: "old-tok",
              installDate: oldInstall,
              group_code: "CON",
            },
          },
        },
      },
    );
    const reload = stubReload();
    await submitCode(root, "AB-CDEF");
    await vi.waitFor(() =>
      expect(root.querySelector("#vl-recover-yes")).not.toBeNull(),
    );
    click(root, "#vl-recover-yes");
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());

    expect(data).toMatchObject({
      anonymousId: "old-anon",
      participantToken: "old-tok",
      participantCode: "AB-CDEF",
      group: "CON",
      installDate: oldInstall,
      participantSynced: true,
    });
    const recover = server.calls.find(
      (c) => c.path === "/api/participants/recover",
    );
    expect(recover.body).toEqual({ participantCode: "AB-CDEF" });
    expect(server.paths()).not.toContain("/api/participants");
  });

  it("연구자 모드에서 온보딩으로 돌아가면 참여 정보만 지우고 시청 기록은 남긴 채 다시 연다", async () => {
    const { root, data } = await bootPopup(
      participant({
        group: "TEST-EXP",
        participantCode: "TEST-EXP",
        installDate: daysAgo(1),
        sessions: [],
      }),
    );
    await vi.waitFor(() =>
      expect(root.querySelector("#vl-researcher-reset")).not.toBeNull(),
    );
    const reload = stubReload();
    click(root, "#vl-researcher-reset");
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());

    for (const key of [
      "group",
      "participantCode",
      "installDate",
      "participantSynced",
    ]) {
      expect(data).not.toHaveProperty(key);
    }
    expect(data).toMatchObject({ anonymousId: "anon-1", sessions: [] });
  });
});

describe("팝업을 닫을 때", () => {
  async function bootWithBeacon() {
    const p = await bootPopup(
      participant({ group: "EXP", installDate: daysAgo(BASELINE_DAYS + 1) }),
    );
    await vi.waitFor(() => expect(p.data.livePopupEvent).toBeTruthy());
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon });
    return { ...p, sendBeacon };
  }

  async function beaconPayload(sendBeacon) {
    const [url, blob] = sendBeacon.mock.calls[0];
    // jsdom의 Blob에는 text()가 없다
    const text = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(blob);
    });
    expect(blob.type).toBe("application/json");
    return { url, body: JSON.parse(text) };
  }

  it("pagehide면 마지막 기록을 남기고 sendBeacon으로도 보낸다", async () => {
    const { data, sendBeacon } = await bootWithBeacon();
    const eventId = data.livePopupEvent.eventId;
    globalThis.dispatchEvent(new Event("pagehide"));

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const { url, body } = await beaconPayload(sendBeacon);
    expect(url).toBe(`${SERVER}/api/popup-events`);
    expect(body).toMatchObject({
      eventId,
      anonymousId: "anon-1",
      participantToken: "tok-1",
    });
    expect(data.livePopupEvent.eventId).toBe(eventId);
  });

  it("화면이 숨겨질 때만 보내고 다시 보일 때는 보내지 않는다", async () => {
    const { sendBeacon } = await bootWithBeacon();
    const setHidden = (hidden) => {
      Object.defineProperty(document, "hidden", {
        value: hidden,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    try {
      setHidden(false);
      expect(sendBeacon).not.toHaveBeenCalled();
      setHidden(true);
      expect(sendBeacon).toHaveBeenCalledTimes(1);
    } finally {
      delete document.hidden;
    }
  });
});

describe("수집 중 표시", () => {
  it("시청 중이면 1초마다 영상 수와 남은 시간을 갱신하고, 수집이 끝나면 표시를 내린다", async () => {
    const { root, emitChange } = await bootPopup(
      participant({
        group: "EXP",
        installDate: daysAgo(BASELINE_DAYS + 1),
        currentSession: { videoCount: 2 },
        lastWatchedAt: new Date().toISOString(),
      }),
    );
    await vi.waitFor(() =>
      expect(root.querySelector("#vl-collecting-count")).not.toBeNull(),
    );

    await emitChange({ currentSession: { newValue: { videoCount: 3 } } });
    vi.advanceTimersByTime(1000);
    expect(root.querySelector("#vl-collecting-count").textContent).toBe(
      "영상 3개 수집 중",
    );
    expect(root.querySelector("#vl-collecting-timer").textContent).toMatch(
      /^피드백까지 \d+분 \d{2}초$/,
    );

    await emitChange({
      currentSession: { newValue: null },
      lastWatchedAt: { newValue: null },
    });
    vi.advanceTimersByTime(1000);
    expect(root.querySelector("#vl-collecting-count")).toBeNull();
  });

  // 지난 날짜를 그리면 VL.today가 그날 데이터(수집 중 0개)로 바뀐다. 오늘로 돌아와 다시 그릴 때
  // 그 값을 쓰면 1초 갱신 전까지 "분석 중..."이 잠깐 보였다.
  it("전날로 갔다가 오늘로 돌아오면 1초 갱신을 기다리지 않고 바로 최신 수집 상태를 보인다", async () => {
    const { root, emitChange } = await bootPopup(
      participant({
        group: "EXP",
        installDate: daysAgo(BASELINE_DAYS + 1),
        currentSession: { videoCount: 2 },
        lastWatchedAt: new Date().toISOString(),
      }),
    );
    await vi.waitFor(() =>
      expect(root.querySelector("#vl-collecting-count")).not.toBeNull(),
    );
    // 팝업을 연 뒤에 영상이 하나 더 기록됐다
    await emitChange({ currentSession: { newValue: { videoCount: 3 } } });

    root.querySelector("#vl-date-prev").click();
    await vi.waitFor(() =>
      expect(root.querySelector("#vl-collecting-count")).toBeNull(),
    );
    root.querySelector("#vl-date-next").click();
    await vi.waitFor(() =>
      expect(root.querySelector("#vl-collecting-count")).not.toBeNull(),
    );

    expect(root.querySelector("#vl-collecting-count").textContent).toBe(
      "영상 3개 수집 중",
    );
    expect(root.querySelector("#vl-collecting-timer").textContent).toMatch(
      /^피드백까지 \d+분 \d{2}초$/,
    );
  });
});
