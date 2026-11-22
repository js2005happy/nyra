// 正式标志（圆盘 + 光标，= 入场动画终帧）：几何来源唯一、生成文件同步、各处引用的是真标志。
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import {
  MARK_CIRCLE, MARK_CURSOR, MARK_INK, MARK_PAPER, MARK_PRESETS, MARK_ROTATE_DEG,
  icnsFromPngs, icoFromPngs, markPng, markSvg, rasterizeMark,
} from "../../src/brandMark.ts";
import { SVG_OUTPUTS } from "../../scripts/make-icons.ts";
import { ICON_BG, ICON_EYE, ICON_PURPLE, appIconSvg } from "../../src/appIcon.ts";
import { DESKTOP_HTML } from "../../src/webuiDesktop.ts";
import { MOBILE_V2_HTML } from "../../src/webuiMobile.ts";
import { Gateway } from "../../src/gateway.ts";

const ROOT = join(import.meta.dir, "..", "..");
const STAR = "M8 0C9 5 11 7 16 8";

test("几何与入场动画一致：光标 = splash arrowD(40,31,0.86)，圆盘 r40，旋转 -6°", () => {
  const splash = readFileSync(join(ROOT, "src", "assets", "mobile-splash.js.txt"), "utf-8");
  const ar = JSON.parse(/const AR=(\[\[.*?\]\]);/.exec(splash)![1]) as [number, number][];
  const expected = ar.map(([a, b]) => [Number((40 + a * 0.86).toFixed(2)), Number((31 + b * 0.86).toFixed(2))]);
  expect(MARK_CURSOR).toEqual(expected as [number, number][]);
  expect(splash).toContain('r="40" fill="${FG}"');
  expect(MARK_CIRCLE.r).toBe(40);
  expect(MARK_ROTATE_DEG).toBe(-6);
  expect(splash).toContain(`const W=1280,H=800,BG="${MARK_INK}",FG="${MARK_PAPER}"`);
});

test("仓库里的标志 / 应用图标 SVG 与 src/brandMark.ts、src/appIcon.ts 同步（bun scripts/make-icons.ts 生成）", () => {
  for (const [rel, svg] of Object.entries(SVG_OUTPUTS)) {
    expect(readFileSync(join(ROOT, rel), "utf-8")).toBe(svg);
    expect(svg).not.toContain("<text"); // 不带字标
    expect(svg).not.toContain("mask"); // 标志镂空是 evenodd 单路径；应用图标用 clipPath，GitHub / 任意光栅器都一致
  }
  expect(readFileSync(join(ROOT, "docs/assets/nyra-mark.svg"), "utf-8")).toContain(`fill="${MARK_INK}"`);
  expect(readFileSync(join(ROOT, "docs/assets/nyra-mark-dark.svg"), "utf-8")).toContain(`fill="${MARK_PAPER}"`);
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

test("16 / 32 px 小尺寸光标仍可辨（圆盘里有一块镂空）", () => {
  for (const s of [16, 32]) {
    const rgba = rasterizeMark(s, MARK_PRESETS.light());
    let holes = 0;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const inDisc = Math.hypot(x + 0.5 - s / 2, y + 0.5 - s / 2) < s * 0.4;
      if (inDisc && rgba[(y * s + x) * 4 + 3] < 128) holes++;
    }
    expect(holes).toBeGreaterThanOrEqual(s === 16 ? 12 : 50);
  }
});

test("ICO / ICNS 编码结构", () => {
  const png = markPng(16, MARK_PRESETS.light());
  const ico = icoFromPngs([{ size: 16, png }, { size: 256, png }]);
  expect(ico.readUInt16LE(2)).toBe(1);
  expect(ico[22]).toBe(0); // 256 记为 0
  expect(ico.readUInt32LE(6 + 12)).toBe(6 + 32);
  const icns = icnsFromPngs([{ type: "icp4", png }]);
  expect(icns.length).toBe(16 + png.length);
});

test("页面里用的是真标志，不再是 ✦ 占位；README / 启动页引用新文件，官网内联真标志 SVG", () => {
  const svg = markSvg({ disc: "currentColor" });
  const d = /d="([^"]+)"/.exec(svg)![1];
  expect(DESKTOP_HTML).not.toContain(STAR);
  expect(DESKTOP_HTML.split(d).length - 1).toBe(2); // 新对话空状态 + 首次设置
  expect(MOBILE_V2_HTML).toContain(d); // 配对页 + 空对话列表模板
  expect(MOBILE_V2_HTML).toContain('id="tpl-mark"');
  const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
  expect(readme).toContain("desktop/icon-src/nyra-app-icon.svg"); // README 顶部用应用图标（紫色团子方块）
  for (const page of ["index", "faq", "privacy", "terms", "acceptable-use"]) {
    const html = readFileSync(join(ROOT, "docs", `${page}.html`), "utf-8");
    expect(html).toContain('href="assets/favicon.svg"');
    expect(html).toContain('href="assets/apple-touch-icon.png"');
    // 官网 v4 把导航 / 页脚标志改成内联 SVG：每个 class="brand" 的标志都必须是 brandMark.ts 生成的真几何，
    // 不能换成 ✦ 占位、别的图形或外链假图。
    expect(html).not.toContain(STAR);
    const brands = [...html.matchAll(/<a class="brand"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]);
    expect(brands.length).toBeGreaterThanOrEqual(1);
    for (const b of brands) {
      const inline = /<svg viewBox="([^"]+)"[^>]*>\s*<path fill="currentColor" fill-rule="evenodd" d="([^"]+)"\s*\/><\/svg>/.exec(b);
      expect(inline).not.toBeNull();
      expect(inline![1]).toBe("6 6 88 88");
      expect(inline![2]).toBe(d);
      expect(b).not.toContain("<img");
    }
  }
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
