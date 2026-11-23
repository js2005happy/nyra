#!/usr/bin/env bun
// mobile/scripts/make-assets.ts — 生成手机端 Capacitor 要用的图标与启动图：
// 启动器图标 = 应用图标（src/appIcon.ts：紫色团子方块），启动图 = 品牌标志（src/brandMark.ts：方块头）。
// 零依赖（复用 brandMark 自带的光栅化与 PNG 编码），任何平台
// `bun mobile/scripts/make-assets.ts` 即可重新生成。
// 产物提交进仓库（mobile/assets/），CI 不重新生成，只用它们跑
// `npx @capacitor/assets generate --android`。
//
// 产物：
//   assets/icon.png             1024：满版方形应用图标（iOS / 旧版启动图标，系统加遮罩）
//   assets/icon-foreground.png  1024：透明底，只有两只眼（自适应图标前景：画面映射到 108dp 中心 72dp）
//   assets/icon-background.png  1024：纯紫 #8688ff（自适应图标背景；圆形遮罩下就是团子球）
//   assets/splash.png           2732：#1a1a1a 深色启动图，方块头居中（= 开机动画首帧的位置与底色）
//   assets/splash-dark.png      2732：与 splash.png 相同（本身就是深色）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARK_PRESETS, markPng, rgbaPng } from "../../src/brandMark.ts";
import { ICON_BG, appIconPng } from "../../src/appIcon.ts";

const ASSETS = join(import.meta.dir, "..", "assets");

function solidPng(size: number, hex: string): Buffer {
  const [r, g, b] = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return rgbaPng(size, size, rgba);
}

const outputs: Record<string, Buffer> = {
  "icon.png": appIconPng(1024, "square"),
  "icon-foreground.png": appIconPng(1024, "fg"),
  "icon-background.png": solidPng(1024, ICON_BG),
  "splash.png": markPng(2732, MARK_PRESETS.splash()),
  "splash-dark.png": markPng(2732, MARK_PRESETS.splash()),
};

if (import.meta.main) {
  mkdirSync(ASSETS, { recursive: true });
  for (const [name, buf] of Object.entries(outputs)) {
    writeFileSync(join(ASSETS, name), buf);
    console.log(`wrote mobile/assets/${name} (${buf.length} bytes)`);
  }
}
