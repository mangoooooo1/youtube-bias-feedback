// @vitest-environment jsdom
/* global document */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { loadPopup } from "./load-popup.js";

// 영상 제목은 업로더가, 리뷰 문장은 그 제목을 본 LLM이, 참여코드는 참여자가 정한다. 이 값들이 팝업
// innerHTML로 들어가므로 HTML로 해석되면 확장 페이지에서 스크립트가 실행될 수 있다(XSS).
// 진짜 DOM(jsdom)에 넣어 요소가 생기지 않고 글자 그대로 보이는지 확인한다.
const PAYLOAD = `<img src=x onerror="window.__xss=1">`;

let g;

beforeAll(async () => {
  g = await loadPopup({ realDom: true });
});

afterAll(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function render(html) {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("팝업 HTML 이스케이프 — 바깥에서 온 문자열이 요소가 되지 않는다", () => {
  it("리뷰 카드의 리뷰 문장·관심 분야·영상 제목·기준 시각", () => {
    const el = render(
      g.vlReview({
        text: PAYLOAD,
        topic: PAYLOAD,
        videos: [{ videoId: "abc123", title: PAYLOAD }],
        asOf: PAYLOAD,
      }),
    );
    expect(el.querySelector("img")).toBeNull();
    // 4곳 모두 글자 그대로 보인다
    expect(el.textContent.split(PAYLOAD).length - 1).toBe(4);
  });

  it("영상 링크의 videoId로 속성을 빠져나가지 못한다", () => {
    const el = render(
      g.vlReview({
        text: "리뷰",
        videos: [{ videoId: `"><img src=x>`, title: "영상" }],
      }),
    );
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("a.vl-vid-link").getAttribute("href")).toBe(
      `https://www.youtube.com/watch?v=${encodeURIComponent(`"><img src=x>`)}`,
    );
  });

  it("재설치 복구 확인 모달의 참여코드", () => {
    const el = render(g.screenRecoverConfirmModal(PAYLOAD));
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain(PAYLOAD);
  });

  it("팝업 상단의 참여코드", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    new g.ViewLensPopup(container).mount({
      onboarded: true,
      group: "EXP",
      timelineKey: "w1_mid",
      installDate: new Date().toISOString(),
      participantCode: PAYLOAD,
      onChange: () => {},
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(PAYLOAD);
  });
});
