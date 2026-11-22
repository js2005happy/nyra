// src/appIcon.ts — Nyra 应用图标（v9 方向 C：紫色团子方块）的唯一几何来源与光栅化。
//
// 画面（1024 网格）：团子本身就是图块——整块纯紫 #8688ff 撑满，只有两只 #141414 竖胶囊眼。
// 眼睛比例沿用界面里的团子头像（r46 圆里 12×21、眼心离中心 ±14、低 3），按半径 512 放大：
// 眼 133.57×233.74、眼心 (512±142.48, 545.39)。Android 自适应图标的圆形遮罩下正好还原成团子球。
// 小尺寸规则：≤20 px 眼睛放大 18%，≤28 px 放大 8%。
//
// 只管“应用图标”：桌面安装包图标、手机启动器图标、PWA manifest、apple-touch-icon、favicon。
// 界面里的团子头像（src/nyraAvatar.ts）和圆盘 + 光标标志（src/brandMark.ts）不在这里。
// 编码（PNG / ICO / ICNS）复用 src/brandMark.ts；scripts/make-icons.ts 与 mobile/scripts/make-assets.ts
// 用这里生成提交进仓库的图标文件，网关在运行时用它出 PWA 图标。零依赖。
import { rgbaPng } from "./brandMark.ts";

export const ICON_PURPLE = "#8688ff";
export const ICON_EYE = "#141414";
/** 底色 = 团子紫（Android 自适应背景层也是它）。 */
export const ICON_BG = ICON_PURPLE;

const G = 1024;
const EYE_R = 0.5 * G;
const EYE_W = 12 / 46;
const EYE_H = 21 / 46;
const EYE_DX = 14 / 46;
const EYE_DY = 3 / 46;
const EYE_CENTER = { x: 0.5 * G, y: 0.5 * G + EYE_DY * EYE_R };

/** 按图标实际像素选眼睛放大系数（小尺寸更醒目）。 */
export function eyeScaleFor(px: number): number {
  return px <= 20 ? 1.18 : px <= 28 ? 1.08 : 1;
}

/** 两只眼（1024 网格）：每只是竖胶囊 {x, y, w, h}，左上角 + 宽高，圆角 = w/2。 */
export function iconEyes(scale = 1): { x: number; y: number; w: number; h: number }[] {
  const w = EYE_W * EYE_R * scale;
  const h = EYE_H * EYE_R * scale;
  const dx = EYE_DX * EYE_R * (1 + (scale - 1) * 0.5);
  return [-1, 1].map((s) => ({ x: EYE_CENTER.x + s * dx - w / 2, y: EYE_CENTER.y - h / 2, w, h }));
}

/**
 * 图标形状：
 *   square   满版方形不透明（iOS / apple-touch-icon / PWA maskable / 商店，由系统加遮罩）
 *   tile     满格圆角方（圆角 22%），四角透明（favicon、PWA any）
 *   win      Windows / Linux：四周 6% 透明边距，圆角 19%
 *   mac      macOS Big Sur 网格：1024 里 824 的连续圆角主体 + 标准投影
 *   fg       Android 自适应前景：透明底，只有两只眼，画面映射到 108dp 画布中心 72dp
 *   bg       Android 自适应背景：纯紫底（圆形遮罩下就是团子球）
 */
export type IconShape = "square" | "tile" | "win" | "mac" | "fg" | "bg";

const SUPER_N = 4.2;
const MAC_MARGIN = 100 / G;
const WIN_MARGIN = 0.06;
const WIN_RADIUS = 0.19;
const TILE_RADIUS = 0.22;
const FG_SCALE = 72 / 108;

function hexRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** 点到圆角矩形的有符号距离（矩形中心 cx,cy，半宽 hw，半高 hh，圆角 r）。 */
function rrectSd(x: number, y: number, cx: number, cy: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

interface Layout {
  /** 画面（1024 网格）在输出里占的方框：左上 ox,oy（像素）、边长 box（像素）。 */
  ox: number; oy: number; box: number;
  /** 采样点（像素）是否在形状内。 */
  inside: (x: number, y: number) => boolean;
  /** 是否画底色。 */
  bg: boolean;
  /** macOS 投影。 */
  shadow?: (x: number, y: number) => number;
  /** 像素中心到形状边缘的大致距离（像素），用来跳过远离边缘的超采样。 */
  edge: (x: number, y: number) => number;
}

function layoutFor(size: number, shape: IconShape): Layout {
  const S = size;
  switch (shape) {
    case "square":
    case "bg":
      return { ox: 0, oy: 0, box: S, inside: () => true, bg: true, edge: () => Infinity };
    case "tile": {
      const r = TILE_RADIUS * S;
      const sd = (x: number, y: number) => rrectSd(x, y, S / 2, S / 2, S / 2, S / 2, r);
      return { ox: 0, oy: 0, box: S, inside: (x, y) => sd(x, y) <= 0, bg: true, edge: (x, y) => Math.abs(sd(x, y)) };
    }
    case "win": {
      const m = WIN_MARGIN * S;
      const r = WIN_RADIUS * S;
      const sd = (x: number, y: number) => rrectSd(x, y, S / 2, S / 2, S / 2 - m, S / 2 - m, r);
      return { ox: m, oy: m, box: S - 2 * m, inside: (x, y) => sd(x, y) <= 0, bg: true, edge: (x, y) => Math.abs(sd(x, y)) };
    }
    case "mac": {
      const m = MAC_MARGIN * S;
      const a = S / 2 - m;
      const inside = (x: number, y: number) =>
        Math.abs((x - S / 2) / a) ** SUPER_N + Math.abs((y - S / 2) / a) ** SUPER_N <= 1;
      const dy = (12 / G) * S;
      const sigma = Math.max((14 / G) * S, 0.5);
      const shadow = (x: number, y: number) => {
        const sd = rrectSd(x, y - dy, S / 2, S / 2, a, a, 0.3 * a);
        return 0.32 * 0.5 * (1 - erf(sd / (sigma * Math.SQRT2)));
      };
      // 超椭圆边缘夹在 “圆角 0.18a / 0.45a 的两个圆角矩形” 之间，取两者距离的较小值做保守估计。
      const edge = (x: number, y: number) => {
        const d1 = rrectSd(x, y, S / 2, S / 2, a, a, 0.18 * a);
        const d2 = rrectSd(x, y, S / 2, S / 2, a, a, 0.45 * a);
        return d1 < 0 !== d2 < 0 ? 0 : Math.min(Math.abs(d1), Math.abs(d2));
      };
      return { ox: m, oy: m, box: S - 2 * m, inside, bg: true, shadow, edge };
    }
    case "fg": {
      const box = S * FG_SCALE;
      return { ox: (S - box) / 2, oy: (S - box) / 2, box, inside: () => true, bg: false, edge: () => Infinity };
    }
  }
}

/** 光栅化应用图标为 RGBA（4×4 超采样抗锯齿）。eyeScale 不给时按画面实际像素取。 */
export function rasterizeAppIcon(size: number, shape: IconShape, eyeScale?: number): Uint8Array {
  const L = layoutFor(size, shape);
  const out = new Uint8Array(size * size * 4);
  const purple = hexRgb(ICON_PURPLE);
  const eye = hexRgb(ICON_EYE);
  const k = L.box / G; // 1 网格单位 = 多少像素
  const scale = eyeScale ?? eyeScaleFor(L.box);
  const eyes = iconEyes(scale).map((e) => ({ cx: e.x + e.w / 2, r: e.w / 2, y0: e.y + e.w / 2, y1: e.y + e.h - e.w / 2 }));
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // 远离所有边缘（遮罩、眼睛）的像素只采一次。
      const cu = (px + 0.5 - L.ox) / k;
      const cv = (py + 0.5 - L.oy) / k;
      let near = L.edge(px + 0.5, py + 0.5);
      for (const e of eyes) {
        const cy = Math.max(e.y0, Math.min(e.y1, cv));
        near = Math.min(near, Math.abs(Math.hypot(cu - e.cx, cv - cy) - e.r) * k);
      }
      const ss = near > 1.5 ? 1 : SS;
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = px + (sx + 0.5) / ss;
          const fy = py + (sy + 0.5) / ss;
          if (!L.inside(fx, fy)) continue;
          const u = (fx - L.ox) / k;
          const v = (fy - L.oy) / k;
          let col: [number, number, number] | null = null;
          let inEye = false;
          for (const e of eyes) {
            const cy = Math.max(e.y0, Math.min(e.y1, v));
            if (Math.hypot(u - e.cx, v - cy) <= e.r) { inEye = true; break; }
          }
          if (shape === "bg") col = purple;
          else if (inEye) col = eye;
          else if (L.bg) col = purple;
          if (col) { r += col[0]; g += col[1]; b += col[2]; a += 1; }
        }
      }
      const i = (py * size + px) * 4;
      const n = ss * ss;
      let alpha = a / n;
      if (a > 0) { out[i] = Math.round(r / a); out[i + 1] = Math.round(g / a); out[i + 2] = Math.round(b / a); }
      if (L.shadow && alpha < 1) {
        // 投影在主体下面：黑色，按 “主体 over 投影” 合成。
        const sa = L.shadow(px + 0.5, py + 0.5) * (1 - alpha);
        const tot = alpha + sa;
        if (tot > 0) {
          out[i] = Math.round((out[i] * alpha) / tot);
          out[i + 1] = Math.round((out[i + 1] * alpha) / tot);
          out[i + 2] = Math.round((out[i + 2] * alpha) / tot);
        }
        alpha = tot;
      }
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

export function appIconPng(size: number, shape: IconShape, eyeScale?: number): Buffer {
  return rgbaPng(size, size, rasterizeAppIcon(size, shape, eyeScale));
}

// ---------------------------------------------------------------- SVG ---
const f = (n: number) => Number(n.toFixed(2)).toString();

function artSvg(withBg: boolean, scale = 1): string {
  const eyes = iconEyes(scale)
    .map((e) => `<rect x="${f(e.x)}" y="${f(e.y)}" width="${f(e.w)}" height="${f(e.h)}" rx="${f(e.w / 2)}" fill="${ICON_EYE}"/>`)
    .join("");
  return (withBg ? `<rect width="${G}" height="${G}" fill="${ICON_PURPLE}"/>` : "") + eyes;
}

function rrectPath(x0: number, y0: number, w: number, h: number, r: number): string {
  return `M${f(x0 + r)} ${f(y0)}H${f(x0 + w - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x0 + w)} ${f(y0 + r)}V${f(y0 + h - r)}` +
    `A${f(r)} ${f(r)} 0 0 1 ${f(x0 + w - r)} ${f(y0 + h)}H${f(x0 + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x0)} ${f(y0 + h - r)}` +
    `V${f(y0 + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x0 + r)} ${f(y0)}Z`;
}

/**
 * 应用图标 SVG（1024 视框）。square = 满版母版；tile = 圆角 22% 的 favicon / 通用图块；
 * win = Windows / Linux 图块；fg = Android 自适应前景（只有眼睛）。遮罩用 clipPath（各浏览器 / 光栅器一致）。
 */
export function appIconSvg(shape: "square" | "tile" | "win" | "fg" = "square", eyeScale = 1): string {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${G} ${G}" role="img" aria-label="Nyra">`;
  if (shape === "square") return open + artSvg(true, eyeScale) + "</svg>";
  if (shape === "fg") {
    const off = (G * (1 - FG_SCALE)) / 2;
    return open + `<g transform="translate(${f(off)} ${f(off)}) scale(${FG_SCALE.toFixed(5)})">${artSvg(false, eyeScale)}</g></svg>`;
  }
  if (shape === "tile") {
    const clip = rrectPath(0, 0, G, G, TILE_RADIUS * G);
    return open + `<defs><clipPath id="nyra-icon-clip"><path d="${clip}"/></clipPath></defs>` +
      `<g clip-path="url(#nyra-icon-clip)">${artSvg(true, eyeScale)}</g></svg>`;
  }
  const m = WIN_MARGIN * G;
  const clip = rrectPath(m, m, G - 2 * m, G - 2 * m, WIN_RADIUS * G);
  return open + `<defs><clipPath id="nyra-icon-clip"><path d="${clip}"/></clipPath></defs>` +
    `<g clip-path="url(#nyra-icon-clip)"><g transform="translate(${f(m)} ${f(m)}) scale(${f((G - 2 * m) / G)})">${artSvg(true, eyeScale)}</g></g></svg>`;
}
