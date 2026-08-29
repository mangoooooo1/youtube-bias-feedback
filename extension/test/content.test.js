import { describe, it, expect, beforeAll } from "vitest";
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
