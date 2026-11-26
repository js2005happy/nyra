// 桌面网页与手机 /m 的助手回复用安全 Markdown 渲染（src/assets/markdown.js.txt）：
// 表格、行内代码、列表要成形；原始 HTML 一律当文字；javascript:/data: 链接不生成 href；
// 表格外包可横向滚动的容器（手机上能横滑）。只建 DOM，不写 innerHTML。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ASSETS = join(import.meta.dir, "..", "..", "src", "assets");
const SRC = readFileSync(join(ASSETS, "markdown.js.txt"), "utf-8");

// 极简假 DOM：够 render 用，并能序列化成 HTML（文本与属性都转义）以便断言。
class FakeNode {
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  classes = new Set<string>();
  constructor(public tag: string | null, public text = "") {}
  get firstChild() { return this.children[0] ?? null; }
  appendChild(c: FakeNode) { this.children.push(c); return c; }
  removeChild(c: FakeNode) { this.children = this.children.filter((x) => x !== c); return c; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  get classList() { return { add: (c: string) => this.classes.add(c), contains: (c: string) => this.classes.has(c) }; }
  set innerHTML(_v: string) { throw new Error("innerHTML must never be used"); }
  html(): string {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    if (this.tag === null) return esc(this.text);
    const attrs = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
    const inner = this.children.map((c) => c.html()).join("");
    return this.tag === "br" || this.tag === "hr" ? `<${this.tag}${attrs}>` : `<${this.tag}${attrs}>${inner}</${this.tag}>`;
  }
}
const doc = {
  createElement: (t: string) => new FakeNode(t),
  createTextNode: (s: string) => new FakeNode(null, s),
};
const scope: { NyraMd?: { render: (t: string, el: unknown, d: unknown) => FakeNode; parse: (t: string) => unknown[] } } = {};
new Function("window", SRC)(scope);
const md = scope.NyraMd!;
const render = (text: string) => md.render(text, new FakeNode("div"), doc).html();

describe("safe markdown", () => {
  test("tables render as real tables inside a horizontal scroll wrapper", () => {
    const html = render("## 本周小结\n\n| 指标 | 数值 |\n|---|---:|\n| 订单数 | 412 |\n| 销售额 | ¥93,042 |");
    expect(html).toContain('<div class="md-table"><table>');
    expect(html).toContain("<th>指标</th>");
    expect(html).toContain('<td style="text-align:right">412</td>');
    expect(html).toContain("<h4>本周小结</h4>");
    expect(html).not.toContain("|---");
  });

  test("lists, inline code, bold and code fences", () => {
    const html = render("仓库状态：\n\n- 分支 `main`\n- **3** 个文件改动\n\n1. 先跑测试\n2. 再提交\n\n```sh\nnpm test\n```");
    expect(html).toContain("<ul><li><div>分支 <code>main</code></div></li><li><div><strong>3</strong> 个文件改动</div></li></ul>");
    expect(html).toContain("<ol><li><div>先跑测试</div></li><li><div>再提交</div></li></ol>");
    expect(html).toContain("<pre><code>npm test</code></pre>");
  });

  test("raw HTML is shown as text, never as elements", () => {
    const html = render('<img src=x onerror="alert(1)"> <script>alert(2)</script>\n\n| a |\n|---|\n| <b>x</b> |');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  test("only http(s)/mailto links become anchors", () => {
    const html = render("[ok](https://example.com/a) [bad](javascript:alert(1)) [data](data:text/html,hi) [JS](JaVaScRiPt:alert(1)) 见 https://example.com/b。");
    expect(html).toContain('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer nofollow">ok</a>');
    expect(html).toContain('<a href="https://example.com/b"');
    expect(html).not.toMatch(/href="(javascript|data|JaVaScRiPt):/i);
    expect(html).toContain("bad");
    expect(html).not.toContain("<a href=\"javascript");
  });

  test("plain text keeps line breaks", () => {
    expect(render("第一行\n第二行")).toBe('<div><p>第一行<br>第二行</p></div>');
  });

  test("desktop and mobile pages ship the renderer and use it for assistant replies", async () => {
    const desk = readFileSync(join(ASSETS, "desktop-app.js.txt"), "utf-8");
    const mob = readFileSync(join(ASSETS, "mobile-app.js.txt"), "utf-8");
    expect(desk).toContain("window.NyraMd.render");
    expect(mob).toContain("window.NyraMd.render");
    expect(SRC).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML/);
    expect(SRC.toLowerCase()).not.toContain("</script");
    for (const css of ["desktop-app.css.txt", "mobile-app.css.txt"]) {
      const c = readFileSync(join(ASSETS, css), "utf-8");
      expect(c).toMatch(/\.md \.md-table\{[^}]*overflow-x:auto/);
    }
    const { DESKTOP_HTML } = await import("../../src/webuiDesktop.ts");
    const { MOBILE_V2_HTML: MOBILE_HTML } = await import("../../src/webuiMobile.ts");
    for (const page of [DESKTOP_HTML, MOBILE_HTML]) {
      const at = page.indexOf("root.NyraMd =");
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(page.lastIndexOf("<script>"));
    }
  });
});

describe("mobile 待你决定 card summary", () => {
  test("review card summary uses the safe renderer, not raw text", () => {
    const mob = readFileSync(join(ASSETS, "mobile-app.js.txt"), "utf-8");
    // 摘要走 mdBox（内部调用 NyraMd.render，失败退回 textContent），不再把原文塞进 el('div','sum', …)。
    expect(mob).toContain("card.appendChild(mdBox('sum', String(item.summary)");
    expect(mob).not.toMatch(/el\('div', 'sum', String\(item\.summary\)/);
    const fn = mob.slice(mob.indexOf("function mdBox("), mob.indexOf("function bubble("));
    expect(fn).toContain("window.NyraMd.render(txt, b, document)");
    expect(fn).toContain("b.textContent = txt");
    expect(fn).not.toMatch(/innerHTML/);
    const css = readFileSync(join(ASSETS, "mobile-app.css.txt"), "utf-8");
    expect(css).toContain(".rv .sum.md{white-space:normal}");
  });

  test("the m-06 sample summary renders as a list with bold and code", () => {
    const html = render("好的，我把要点整理如下：\n\n1. **先确认目标**：今天要交付的是周报初稿\n2. **数据来源**：`orders.csv`（本周 412 行）\n3. **输出**：Markdown 表格 + 3 条结论\n\n要我现在开始吗？");
    expect(html).toContain("<ol><li><div><strong>先确认目标</strong>");
    expect(html).toContain("<code>orders.csv</code>");
    expect(html).not.toContain("**");
    expect(html).not.toContain("`");
  });
});
