// 品牌标志（方块头 = 应用图标 C：紫色圆角方块 + 两只竖眼）：几何来源唯一、与应用图标一致、生成文件同步、各处引用的是真标志。
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import {
  MARK_BODY, MARK_EYE, MARK_INK, MARK_PRESETS, MARK_TILE, SPLASH_BG,
  icnsFromPngs, icoFromPngs, inlineMarkSvg, markEyeScaleFor, markEyes, markPng, markSvg, rasterizeMark,
} from "../../src/brandMark.ts";
import { SVG_OUTPUTS } from "../../scripts/make-icons.ts";
import { ICON_BG, ICON_EYE, ICON_PURPLE, appIconSvg, eyeScaleFor, iconEyes } from "../../src/appIcon.ts";
import { DESKTOP_HTML } from "../../src/webuiDesktop.ts";
import { MOBILE_V2_HTML } from "../../src/webuiMobile.ts";
import { PAGE_HTML } from "../../src/webuiPage.ts";
import { Gateway } from "../../src/gateway.ts";

const ROOT = join(import.meta.dir, "..", "..");
const STAR = "M8 0C9 5 11 7 16 8";

test("方块头几何 = 应用图标 C（同色、眼睛逐点一致、圆角 22%），开机动画用同一几何", () => {
  expect(MARK_BODY).toBe(ICON_PURPLE);
  expect(MARK_EYE).toBe(ICON_EYE);
  expect(MARK_TILE.r / MARK_TILE.size).toBeCloseTo(0.22, 5);
  for (const scale of [1, 1.08, 1.18]) {
    const a = markEyes(scale);
    const b = iconEyes(scale).map((e) => ({ x: e.x / 10.24, y: e.y / 10.24, w: e.w / 10.24, h: e.h / 10.24 }));
    for (let i = 0; i < 2; i++) for (const k of ["x", "y", "w", "h"] as const) expect(a[i][k]).toBeCloseTo(b[i][k], 6);
  }
  for (const px of [16, 20, 24, 28, 32, 64]) expect(markEyeScaleFor(px)).toBe(eyeScaleFor(px));
  // 开机动画（设计源与运行时）用同一套方块头几何与配色。
  const splash = readFileSync(join(ROOT, "src", "assets", "mobile-splash.js.txt"), "utf-8");
  const design = readFileSync(join(ROOT, "docs", "design", "splash", "splash.js"), "utf-8");
  const e = markEyes(1)[0];
  for (const src of [splash, design]) {
    expect(src).toContain(`BG="${SPLASH_BG}",BODY="${MARK_BODY}",EYE="${MARK_EYE}"`);
    expect(src).toContain(`RAD=${MARK_TILE.r}, EW=${e.w.toFixed(2)}, EH=${e.h.toFixed(2)}, EDX=${(50 - e.x - e.w / 2).toFixed(2)}, ECY=${(e.y + e.h / 2).toFixed(2)}`);
  }
  // 运行时的 frame 与设计源逐字一致。
  const body = (src: string) => src.slice(src.indexOf("const W=1280"), src.indexOf("\n}", src.indexOf("function frame(")) + 2);
  expect(body(splash)).toBe(body(design));
  // 结尾不弯成笑眼：终帧（也是减少动态效果时显示的帧）是两只正常竖眼、正视。
  const S = require(join(ROOT, "docs", "design", "splash", "splash.js"));
  for (const t of [3.3, 3.45, S.END, 4.05]) {
    const svg: string = S.frame(t);
    expect(svg).not.toContain("stroke-linecap");
    const eyes = [...svg.matchAll(new RegExp(`<rect x="([\\d.-]+)" y="([\\d.-]+)" width="([\\d.]+)" height="([\\d.]+)"[^>]*fill="${MARK_EYE}"`, "g"))];
    expect(eyes.length).toBe(2);
    if (t >= S.END) for (const m of eyes) { expect(+m[3]).toBeCloseTo(e.w, 1); expect(+m[4]).toBeCloseTo(e.h, 1); }
  }
});

test("仓库里的标志 / 应用图标 SVG 与 src/brandMark.ts、src/appIcon.ts 同步（bun scripts/make-icons.ts 生成）", () => {
  for (const [rel, svg] of Object.entries(SVG_OUTPUTS)) {
    expect(readFileSync(join(ROOT, rel), "utf-8")).toBe(svg);
    expect(svg).not.toContain("<text"); // 不带字标
    expect(svg).not.toContain("mask"); // 单色标志镂空是 evenodd 单路径；应用图标用 clipPath，GitHub / 任意光栅器都一致
  }
  for (const rel of ["docs/assets/nyra-mark.svg", "docs/assets/nyra-mark-dark.svg", "desktop/ui/mark.svg", "desktop/ui/mark-dark.svg"]) {
    expect(readFileSync(join(ROOT, rel), "utf-8").trim()).toBe(markSvg());
  }
  const mono = readFileSync(join(ROOT, "docs/assets/nyra-mark-mono.svg"), "utf-8");
  expect(mono).toContain(`fill="${MARK_INK}" fill-rule="evenodd"`);
  // favicon / App 图标 = 紫色团子方块：只用团子紫与深色眼两种颜色。
  expect(ICON_BG).toBe(ICON_PURPLE);
  for (const rel of ["docs/assets/favicon.svg", "docs/assets/nyra-app-icon.svg", "desktop/icon-src/nyra-app-icon.svg"]) {
    const svg = readFileSync(join(ROOT, rel), "utf-8");
    expect(svg).toContain(`fill="${ICON_PURPLE}"`);
    expect(svg).toContain(`fill="${ICON_EYE}"`);
    expect([...new Set(svg.match(/fill="#[0-9a-fA-F]{6}"/g))].sort()).toEqual([`fill="${ICON_EYE}"`, `fill="${ICON_PURPLE}"`]);
  }
  expect(readFileSync(join(ROOT, "docs/assets/favicon.svg"), "utf-8").trim()).toBe(appIconSvg("tile"));
});

function pngPixels(png: Buffer): { w: number; px: (x: number, y: number) => number[] } {
  const w = png.readUInt32BE(16);
  const idat: Buffer[] = [];
  for (let off = 8; off < png.length;) {
    const len = png.readUInt32BE(off);
    if (png.subarray(off + 4, off + 8).toString("ascii") === "IDAT") idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { w, px: (x, y) => [...raw.subarray(y * (w * 4 + 1) + 1 + x * 4, y * (w * 4 + 1) + 5 + x * 4)] };
}

const PURPLE = [0x86, 0x88, 0xff];
const EYE = [0x14, 0x14, 0x14];
test("提交的 Tauri / 官网位图：尺寸对、是紫色团子方块（纯紫 + 两只深色竖胶囊眼）", () => {
  const sizes: Record<string, number> = { "icon.png": 512, "32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256 };
  for (const [f, s] of Object.entries(sizes)) {
    const p = pngPixels(readFileSync(join(ROOT, "desktop/src-tauri/icons", f)));
    expect(p.w).toBe(s);
    expect(p.px(0, 0)[3]).toBe(0); // 圆角外透明
    expect(p.px(Math.floor(s * 0.5), Math.floor(s * 0.2)).slice(0, 3)).toEqual(PURPLE); // 团子方块
    expect(p.px(Math.floor(s * 0.5), Math.floor(s * 0.53)).slice(0, 3)).toEqual(PURPLE); // 两眼之间
    expect(p.px(Math.floor(s * 0.36), Math.floor(s * 0.53)).slice(0, 3)).toEqual(EYE); // 左眼
    expect(p.px(Math.floor(s * 0.64), Math.floor(s * 0.53)).slice(0, 3)).toEqual(EYE); // 右眼
  }
  const touch = pngPixels(readFileSync(join(ROOT, "docs/assets/apple-touch-icon.png")));
  expect(touch.px(0, 0)).toEqual([...PURPLE, 255]); // 满版不透明，iOS 自己切圆角
  expect(touch.px(65, 96).slice(0, 3)).toEqual(EYE);
  const ico = readFileSync(join(ROOT, "desktop/src-tauri/icons/icon.ico"));
  expect(ico.readUInt16LE(4)).toBe(6);
  const icns = readFileSync(join(ROOT, "desktop/src-tauri/icons/icon.icns"));
  expect(icns.subarray(0, 4).toString("ascii")).toBe("icns");
  expect(icns.readUInt32BE(4)).toBe(icns.length);
  expect(icns.includes(Buffer.from("ic10"))).toBe(true); // 1024
  const fav = readFileSync(join(ROOT, "docs/assets/favicon.ico"));
  expect([fav.readUInt16LE(4), fav[6], fav[22], fav[38]]).toEqual([3, 16, 32, 48]);
  expect(touch.w).toBe(180);
});

test("手机 Capacitor 图标：前景只有两只眼（在 72dp 可见区内）、背景纯紫、启动图标满版", () => {
  const fg = pngPixels(readFileSync(join(ROOT, "mobile/assets/icon-foreground.png")));
  expect(fg.w).toBe(1024);
  expect(fg.px(512, 200)[3]).toBe(0); // 眼睛以外全透明（露出背景层的紫色）
  expect(fg.px(512, 535)[3]).toBe(0);
  const ex = Math.round(170.67 + 0.66667 * (512 - 142.48));
  const ey = Math.round(170.67 + 0.66667 * 545.39);
  expect(fg.px(ex, ey)).toEqual([...EYE, 255]);
  const bg = pngPixels(readFileSync(join(ROOT, "mobile/assets/icon-background.png")));
  expect(bg.px(10, 10)).toEqual([...PURPLE, 255]);
  const icon = pngPixels(readFileSync(join(ROOT, "mobile/assets/icon.png")));
  expect(icon.px(0, 0)).toEqual([...PURPLE, 255]);
  expect(icon.px(512 - 142, 545)).toEqual([...EYE, 255]);
});

test("16 / 32 px 小尺寸方块头：两只眼仍可辨（眼睛放大、镂空可见）", () => {
  for (const s of [16, 32]) {
    const rgba = rasterizeMark(s, MARK_PRESETS.cut());
    const alpha = (x: number, y: number) => rgba[(y * s + x) * 4 + 3];
    expect(alpha(Math.floor(s / 2), Math.floor(s * 0.2))).toBe(255); // 额头是实心方块
    expect(alpha(Math.floor(s / 2), Math.floor(s * 0.53))).toBe(255); // 两眼之间
    expect(alpha(Math.floor(s * 0.35), Math.floor(s * 0.53))).toBeLessThan(128); // 左眼镂空
    expect(alpha(Math.floor(s * 0.65), Math.floor(s * 0.53))).toBeLessThan(128); // 右眼镂空
  }
  const color = rasterizeMark(64, MARK_PRESETS.color());
  expect([...color.subarray((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 3)]).toEqual([0x86, 0x88, 0xff]);
  expect([...color.subarray((34 * 64 + 22) * 4, (34 * 64 + 22) * 4 + 3)]).toEqual([0x14, 0x14, 0x14]);
});

test("手机原生启动图：#1a1a1a 底、方块头居中（与开机动画同底色）", () => {
  const p = pngPixels(readFileSync(join(ROOT, "mobile/assets/splash.png")));
  expect(p.w).toBe(2732);
  expect(p.px(10, 10)).toEqual([0x1a, 0x1a, 0x1a, 255]);
  expect(p.px(1366, 1366 - 150).slice(0, 3)).toEqual(PURPLE);
  expect(p.px(Math.round(1366 - 0.1522 * 0.15 * 2732), Math.round(1366 + 0.0326 * 0.15 * 2732)).slice(0, 3)).toEqual(EYE);
});

test("ICO / ICNS 编码结构", () => {
  const png = markPng(16, MARK_PRESETS.color());
  const ico = icoFromPngs([{ size: 16, png }, { size: 256, png }]);
  expect(ico.readUInt16LE(2)).toBe(1);
  expect(ico[22]).toBe(0); // 256 记为 0
  expect(ico.readUInt32LE(6 + 12)).toBe(6 + 32);
  const icns = icnsFromPngs([{ type: "icp4", png }]);
  expect(icns.length).toBe(16 + png.length);
});

test("页面里用的是真标志（方块头），不再是 ✦ 占位或旧圆盘光标；README / 启动页引用新文件，官网内联方块头 SVG", () => {
  const inline = inlineMarkSvg("brand-mark");
  const eyes = /<rect x="28\.26"[^>]*\/>/.exec(inline)![0];
  expect(DESKTOP_HTML).not.toContain(STAR);
  expect(DESKTOP_HTML.split(inline).length - 1).toBe(2); // 新对话空状态 + 首次设置
  expect(MOBILE_V2_HTML).toContain(inline); // 配对页 + 空对话列表模板
  expect(MOBILE_V2_HTML).toContain('id="tpl-mark"');
  for (const html of [DESKTOP_HTML, MOBILE_V2_HTML, PAGE_HTML]) {
    expect(html).not.toContain("A40 40 0 1 0"); // 旧圆盘
    expect(html).toContain(eyes);
  }
  const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
  expect(readme).toContain("desktop/icon-src/nyra-app-icon.svg"); // README 顶部用应用图标（方块头）
  const logo = inlineMarkSvg("logo-mark");
  for (const page of ["index", "faq", "privacy", "terms", "acceptable-use"]) {
    const html = readFileSync(join(ROOT, "docs", `${page}.html`), "utf-8");
    expect(html).toContain('href="assets/favicon.svg"');
    expect(html).toContain('href="assets/apple-touch-icon.png"');
    expect(html).toContain('content="https://js2005happy.github.io/nyra/assets/og.png"');
    expect(html).not.toContain(STAR);
    expect(html).not.toContain("A40 40 0 1 0");
    // 导航 / 页脚的品牌位：每个 class="brand" 都是 brandMark.ts 生成的方块头 + Inter 字标 “Nyra”。
    const brands = [...html.matchAll(/<a class="brand"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]);
    expect(brands.length).toBeGreaterThanOrEqual(1);
    for (const b of brands) {
      expect(b.startsWith(logo)).toBe(true);
      expect(b).not.toContain("<img");
    }
  }
  const og = pngPixels(readFileSync(join(ROOT, "docs/assets/og.png")));
  expect(og.w).toBe(1200);
  const launch = readFileSync(join(ROOT, "desktop/ui/index.html"), "utf-8");
  expect(launch).toContain('srcset="mark-dark.svg"');
});

test("网关：/favicon.ico 是真 ICO（16/32/48），/nyra-mark.svg 是内置主文件", async () => {
  const gw = new Gateway({ home: mkdtempSync(join(tmpdir(), "nyra-mark-")), workdir: "/tmp", host: "127.0.0.1", port: 0, config: { mcp_enabled: false } });
  const info = await gw.start();
  try {
    const base = `http://127.0.0.1:${info.port}`;
    const res = await fetch(`${base}/favicon.ico`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/x-icon");
    const ico = Buffer.from(await res.arrayBuffer());
    expect([ico.readUInt16LE(4), ico[6], ico[22], ico[38]]).toEqual([3, 16, 32, 48]);
    const fav = await (await fetch(`${base}/m/favicon.svg`)).text();
    expect(fav).toBe(appIconSvg("tile"));
    const mark = await fetch(`${base}/nyra-mark.svg?token=${info.token}`);
    if (mark.status === 200) expect((await mark.text()).trim()).toBe(markSvg());
  } finally { await gw.stop(); }
});
