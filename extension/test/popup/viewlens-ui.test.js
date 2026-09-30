import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_PATH = path.join(__dirname, "../../popup/viewlens-ui.js");

// classic script라 필요한 선언만 정규식으로 추출해 실행한다(markSVG는 다른 파일이라 스텁)
function loadVlReview() {
  const raw = readFileSync(UI_PATH, "utf8");
  const blocks = [
    /function vlEscapeHtml\(str\) \{[\s\S]*?\n\}\n/,
    /function vlReview\(\{[\s\S]*?\n\}\n/,
  ].map((re) => {
    const match = raw.match(re);
    if (!match) throw new Error(`${re}에 매칭되는 선언을 찾지 못했습니다.`);
    return match[0];
  });
  return new Function("markSVG", `${blocks.join("\n")}\nreturn vlReview;`)(
    () => "",
  );
}

describe("vlReview — 기간별 사실 문장", () => {
  const vlReview = loadVlReview();

  it("fact가 있으면 제목 다음, 리뷰 본문 앞에 문장을 넣는다", () => {
    const html = vlReview({
      text: "리뷰 본문",
      fact: { main: "2구간에 본 영상 24개 중 음악이 58%였어요.", note: null },
      title: "2구간 돌아보기",
    });

    const title = html.indexOf("2구간 돌아보기");
    const main = html.indexOf("2구간에 본 영상 24개 중 음악이 58%였어요.");
    const body = html.indexOf("리뷰 본문");
    expect(title).toBeGreaterThan(-1);
    expect(main).toBeGreaterThan(title);
    expect(body).toBeGreaterThan(main);
  });

  it("note가 있으면 문장 아래에 함께 넣는다", () => {
    const html = vlReview({
      text: "리뷰 본문",
      fact: { main: "사실 문장", note: "안내 문장" },
    });

    expect(html.indexOf("안내 문장")).toBeGreaterThan(
      html.indexOf("사실 문장"),
    );
    expect(html.indexOf("리뷰 본문")).toBeGreaterThan(
      html.indexOf("안내 문장"),
    );
  });

  it("문장은 이스케이프한다", () => {
    const html = vlReview({
      text: "",
      fact: { main: "<b>x</b>", note: "<i>y</i>" },
    });

    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;y&lt;/i&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  it("fact가 없으면(오늘 탭) 주제어 줄만 있고 사실 문장 블록은 없다", () => {
    const html = vlReview({ text: "오늘 리뷰", topic: "음악" });

    expect(html).toContain("에 관심이 많습니다!");
    expect(html).not.toContain("font-size:var(--vl-fs-4);font-weight:700");
    expect(html).not.toContain("margin:-4px 0 10px");
  });
});
