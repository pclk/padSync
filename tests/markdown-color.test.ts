import { describe, expect, it } from "vitest";
import { renderChatMarkdown, renderMarkdown } from "@/lib/markdown";

describe("colour and callouts", () => {
  it("colours text and highlights it, markdown inside included", () => {
    expect(renderMarkdown("The [**slope**]{.blue} is [rise over run]{.hl-yellow}.")).toBe(
      '<p>The <span class="md-c-blue"><strong>slope</strong></span> is <span class="md-hl-yellow">rise over run</span>.</p>\n',
    );
  });
  it("leaves unknown colours and plain brackets alone", () => {
    expect(renderMarkdown("[x]{.chartreuse} and [y]")).toBe("<p>[x]{.chartreuse} and [y]</p>\n");
  });
  it("colours maths with the same classes", () => {
    const html = renderMarkdown("$\\red{a}+b$");
    expect(html).toContain('class="enclosing md-c-red"');
  });
  it("keeps other KaTeX HTML commands untrusted", () => {
    expect(renderMarkdown("$\\htmlClass{evil}{a}$")).not.toContain('class="enclosing evil"');
  });
  it("renders a callout box with its title, or the kind's own", () => {
    const html = renderMarkdown(":::mistake Sign error\nDon't drop the **minus**.\n:::\n\nAfter.");
    expect(html).toContain('<div class="md-callout md-callout-mistake"><p class="md-callout-title">Sign error</p><p>Don&#39;t drop the <strong>minus</strong>.</p>\n</div>');
    expect(html).toContain("<p>After.</p>");
    expect(renderMarkdown(":::tip\nUse units.\n:::")).toContain('<p class="md-callout-title">Tip</p>');
  });
  it("shows a callout still being written", () => {
    expect(renderMarkdown(":::key\nHalf an")).toContain('<div class="md-callout md-callout-key"><p class="md-callout-title">Key idea</p><p>Half an</p>');
  });
});

describe("interactive blocks (chat only)", () => {
  const block = "```interactive Pendulum\n<button id=b>Go</button><script>b.onclick=()=>1</script>\n```";
  it("runs in a frame sandboxed to scripts, with the code behind a toggle", () => {
    const html = renderChatMarkdown(block);
    expect(html).toContain('<iframe sandbox="allow-scripts" title="Pendulum" srcdoc="');
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain('<pre class="hljs chat-widget-source" hidden>');
    // The page's own markup is escaped inside srcdoc, never live in the chat.
    expect(html).not.toContain("<button id=b>");
  });
  it("waits for the block to close before running anything", () => {
    expect(renderChatMarkdown("```interactive\n<script>half")).toContain("chat-widget-pending");
  });
  it("stays plain code outside the chat", () => {
    expect(renderMarkdown(block)).not.toContain("<iframe");
  });
});
