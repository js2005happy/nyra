#!/usr/bin/env bun
// scripts/make-icons.ts — 生成仓库里的全部图标文件：
//   标志（src/brandMark.ts：圆盘 + 光标，= 入场动画终帧）→ nyra-mark*.svg、桌面外壳启动页标志；
//   应用图标（src/appIcon.ts：紫色团子方块）→ favicon、apple-touch-icon、桌面安装包图标。
// 零依赖（自带光栅化与 PNG / ICO / ICNS 编码），任何平台 `bun scripts/make-icons.ts` 即可重新生成。
//   --check  只核对 SVG 是否与几何一致（不写文件，不一致时退出码 1）。
//
// 产物：
//   docs/assets/nyra-mark.svg        主文件：深色圆盘 + 镂空光标（浅色背景用；README、官网、网页 /nyra-mark.svg）
//   docs/assets/nyra-mark-dark.svg   浅色圆盘 + 镂空光标（深色背景用）
//   docs/assets/nyra-app-icon.svg    应用图标满版母版（方形，系统加遮罩）
//   docs/assets/favicon.svg          应用图标圆角图块版矢量 favicon
//   docs/assets/favicon.ico          16 / 32 / 48（≤28 px 眼睛放大）
//   docs/assets/apple-touch-icon.png 180（满版不透明）
//   desktop/icon-src/*.svg           桌面图标的矢量源（Windows / Linux 图块、16–32 px 满格版）
//   desktop/src-tauri/icons/*        Tauri：icon.png(512) / 32x32 / 128x128 / 128x128@2x / icon.ico / icon.icns
//                                    （≥48 px 四周 6% 边距；icns 按 macOS 网格 824/1024 + 投影；≤32 px 满格圆角）
//   desktop/ui/mark.svg、mark-dark.svg  桌面外壳启动页的标志（浅 / 深）
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ICNS_TYPES, MARK_INK, MARK_PAPER, icnsFromPngs, icoFromPngs, markSvg } from "../src/brandMark.ts";
import { appIconPng, appIconSvg } from "../src/appIcon.ts";

const ROOT = join(import.meta.dir, "..");

export const SVG_OUTPUTS: Record<string, string> = {
  "docs/assets/nyra-mark.svg": markSvg({ disc: MARK_INK }) + "\n",
  "docs/assets/nyra-mark-dark.svg": markSvg({ disc: MARK_PAPER }) + "\n",
  "docs/assets/nyra-app-icon.svg": appIconSvg("square") + "\n",
  "docs/assets/favicon.svg": appIconSvg("tile") + "\n",
  "desktop/icon-src/nyra-mark-small.svg": appIconSvg("tile", 1.08) + "\n",
  "desktop/icon-src/nyra-app-icon.svg": appIconSvg("win") + "\n",
  "desktop/ui/mark.svg": markSvg({ disc: MARK_INK }) + "\n",
  "desktop/ui/mark-dark.svg": markSvg({ disc: MARK_PAPER }) + "\n",
};

function binaryOutputs(): Record<string, Buffer> {
  const app = (s: number) => appIconPng(s, s <= 32 ? "tile" : "win");
  const mac = (s: number) => appIconPng(s, s <= 32 ? "tile" : "mac");
  const fav = (s: number) => appIconPng(s, "tile");
  return {
    "docs/assets/favicon.ico": icoFromPngs([16, 32, 48].map((size) => ({ size, png: fav(size) }))),
    "docs/assets/apple-touch-icon.png": appIconPng(180, "square"),
    "desktop/src-tauri/icons/icon.png": app(512),
    "desktop/src-tauri/icons/32x32.png": app(32),
    "desktop/src-tauri/icons/128x128.png": app(128),
    "desktop/src-tauri/icons/128x128@2x.png": app(256),
    "desktop/src-tauri/icons/icon.ico": icoFromPngs([16, 24, 32, 48, 64, 256].map((size) => ({ size, png: app(size) }))),
    "desktop/src-tauri/icons/icon.icns": icnsFromPngs(ICNS_TYPES.map(([type, size]) => ({ type, png: mac(size) }))),
  };
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  let bad = 0;
  for (const [rel, svg] of Object.entries(SVG_OUTPUTS)) {
    const path = join(ROOT, rel);
    if (check) {
      let cur = "";
      try { cur = readFileSync(path, "utf-8"); } catch {}
      if (cur !== svg) { console.error(`过期：${rel}`); bad++; }
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, svg);
    console.log(`写入 ${rel}`);
  }
  if (!check) {
    for (const [rel, buf] of Object.entries(binaryOutputs())) {
      const path = join(ROOT, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, buf);
      console.log(`写入 ${rel}（${buf.length} 字节）`);
    }
  }
  if (bad) { console.error("图标 SVG 与 src/brandMark.ts / src/appIcon.ts 不一致：运行 bun scripts/make-icons.ts 重新生成。"); process.exit(1); }
}
