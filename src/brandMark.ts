// src/brandMark.ts — Nyra 品牌标志“方块头”的唯一几何来源与全部导出格式。
//
// 标志 = 已定稿的应用图标 C：圆角方块（团子紫 #8688ff）+ 两只竖向圆角矩形眼（#141414）。
// 视框 0 0 100 100：方块撑满视框，圆角 22（= src/appIcon.ts 的 tile 圆角 22%）；
// 眼睛比例沿用团子头像（r46 圆里 12×21、眼心离中心 ±14、低 3），按半边长 50 换算：
//   眼 13.04×22.83、眼心 (50±15.22, 53.26)，与 appIcon.ts 的 1024 网格逐点一致（测试保证）。
// 深浅底都用同一枚彩色标志；需要单色（印刷、终端 mono）时用 mono：一条 evenodd 路径，眼睛镂空。
// 不带 “Nyra” 字标；字标用 Inter，在用到的地方排字。agent 头像（src/nyraAvatar.ts 的圆团子）不在这里。
//
// 本文件零依赖：SVG 字符串、RGBA 光栅化（超采样抗锯齿）、PNG / ICO / ICNS 编码。
// 网页端、手机 PWA、网关 /nyra-mark.svg 在运行时用它；scripts/make-icons.ts、mobile/scripts/make-assets.ts
// 用它生成提交进仓库的标志文件。改几何只改这里（并同步 appIcon.ts），再跑一次脚本。
import { deflateSync } from "node:zlib";

export const MARK_BODY = "#8688ff"; // 方块（团子紫）
export const MARK_EYE = "#141414"; // 眼睛
export const MARK_INK = "#0B0B0C"; // 单色标志在浅底上的颜色
export const MARK_PAPER = "#F5F5F7"; // 单色标志在深底上的颜色；开机动画字标色
export const MARK_VIEWBOX: [number, number, number, number] = [0, 0, 100, 100];
/** 方块：视框内的位置、边长与圆角（视框单位）。 */
export const MARK_TILE = { x: 0, y: 0, size: 100, r: 22 } as const;
/** 眼睛几何（视框单位，scale = 1）：宽、高、眼心离中线的水平距离、眼心 y。 */
export const MARK_EYE_GEOM = { w: (12 / 46) * 50, h: (21 / 46) * 50, dx: (14 / 46) * 50, cy: 50 + (3 / 46) * 50 } as const;
/** 16–32 px 小尺寸用：≤20 px 眼睛放大 18%，≤28 px 放大 8%（与 appIcon.ts 相同）。 */
export const SMALL_MAX_PX = 32;
export function markEyeScaleFor(px: number): number {
  return px <= 20 ? 1.18 : px <= 28 ? 1.08 : 1;
}

/** 两只眼（视框单位）：左上角 x,y + 宽高，圆角 = w/2。 */
export function markEyes(scale = 1): { x: number; y: number; w: number; h: number }[] {
  const { w, h, dx, cy } = MARK_EYE_GEOM;
  const W = w * scale;
  const H = h * scale;
  const DX = dx * (1 + (scale - 1) * 0.5);
  return [-1, 1].map((s) => ({ x: 50 + s * DX - W / 2, y: cy - H / 2, w: W, h: H }));
}

const f = (n: number) => Number(n.toFixed(2)).toString();

/** 圆角矩形路径（顺时针）；ccw = 逆时针（evenodd 镂空时方向无所谓，留着方便非零规则）。 */
function rrectD(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  return `M${f(x + rr)} ${f(y)}H${f(x + w - rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x + w)} ${f(y + rr)}` +
    `V${f(y + h - rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x + w - rr)} ${f(y + h)}` +
    `H${f(x + rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x)} ${f(y + h - rr)}` +
    `V${f(y + rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x + rr)} ${f(y)}Z`;
}

/** 单色标志的单条路径（evenodd）：方块 + 两只眼的镂空。 */
export function markPathD(eyeScale = 1): string {
  const t = MARK_TILE;
  return [rrectD(t.x, t.y, t.size, t.size, t.r), ...markEyes(eyeScale).map((e) => rrectD(e.x, e.y, e.w, e.h, e.w / 2))].join(" ");
}

// ---------------------------------------------------------------- SVG ---
export interface MarkSvgOpts {
  /** 单色：整枚标志一个颜色、眼睛镂空（露出底色）。不给 = 彩色（紫方块 + 深色眼）。 */
  mono?: string;
  /** 眼睛放大系数（小尺寸用）。 */
  eyeScale?: number;
}

/** 标志内部（不含 <svg> 外壳）：彩色是三块实心图形，单色是一条 evenodd 路径。 */
export function markShapes(o: MarkSvgOpts = {}): string {
  const s = o.eyeScale ?? 1;
  if (o.mono) return `<path fill="${o.mono}" fill-rule="evenodd" d="${markPathD(s)}"/>`;
  const t = MARK_TILE;
  return `<rect x="${t.x}" y="${t.y}" width="${t.size}" height="${t.size}" rx="${t.r}" fill="${MARK_BODY}"/>` +
    markEyes(s).map((e) => `<rect x="${f(e.x)}" y="${f(e.y)}" width="${f(e.w)}" height="${f(e.h)}" rx="${f(e.w / 2)}" fill="${MARK_EYE}"/>`).join("");
}

/** 标志 SVG（独立文件用）。 */
export function markSvg(o: MarkSvgOpts = {}): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_VIEWBOX.join(" ")}">${markShapes(o)}</svg>`;
}

/** 内联进页面的标志（彩色方块头）；aria-hidden。 */
export function inlineMarkSvg(cls = "", o: MarkSvgOpts = {}): string {
  return `<svg${cls ? ` class="${cls}"` : ""} viewBox="${MARK_VIEWBOX.join(" ")}" aria-hidden="true" focusable="false">${markShapes(o)}</svg>`;
}

// ---------------------------------------------------------- 光栅化 ---
export interface RasterOpts {
  /** 方块颜色；默认团子紫。 */
  body?: string;
  /** 眼睛颜色；null = 镂空（透明，或露出 bg）。 */
  eye: string | null;
  /** 方块外的不透明底色（null = 透明）。 */
  bg: string | null;
  /** 底色的圆角比例（相对边长）；不给 = 铺满正方形。 */
  bgRadius?: number;
  /** 方块边长占整幅的比例。 */
  fraction: number;
  /** 眼睛放大系数；不给时按方块实际像素取。 */
  eyeScale?: number;
}

function hexRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** 点到圆角矩形（中心 cx,cy、半宽 hw、半高 hh、圆角 r）的有符号距离。 */
function rrectSd(x: number, y: number, cx: number, cy: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 光栅化标志为 RGBA（边缘 4×4 超采样）。 */
export function rasterizeMark(size: number, o: RasterOpts): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const box = size * o.fraction;
  const k = box / 100; // 1 视框单位 = 多少像素
  const ox = (size - box) / 2;
  const body = hexRgb(o.body ?? MARK_BODY);
  const eyeCol = o.eye ? hexRgb(o.eye) : null;
  const bg = o.bg ? hexRgb(o.bg) : null;
  const bgR = (o.bgRadius ?? 0) * size;
  const t = MARK_TILE;
  const tileSd = (x: number, y: number) => rrectSd(x, y, ox + (t.x + t.size / 2) * k, ox + (t.y + t.size / 2) * k, (t.size / 2) * k, (t.size / 2) * k, t.r * k);
  const eyes = markEyes(o.eyeScale ?? markEyeScaleFor(box)).map((e) => ({ cx: ox + (e.x + e.w / 2) * k, cy: ox + (e.y + e.h / 2) * k, hw: (e.w / 2) * k, hh: (e.h / 2) * k }));
  const eyeSd = (x: number, y: number) => Math.min(...eyes.map((e) => rrectSd(x, y, e.cx, e.cy, e.hw, e.hh, e.hw)));
  const bgSd = (x: number, y: number) => rrectSd(x, y, size / 2, size / 2, size / 2, size / 2, bgR);
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      const near = Math.min(Math.abs(tileSd(cx, cy)), Math.abs(eyeSd(cx, cy)), bg && bgR > 0 ? Math.abs(bgSd(cx, cy)) : Infinity);
      const ss = near > 1.5 ? 1 : SS;
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = px + (sx + 0.5) / ss;
          const y = py + (sy + 0.5) / ss;
          let col: [number, number, number] | null = null;
          if (tileSd(x, y) <= 0) col = eyeSd(x, y) <= 0 ? eyeCol : body;
          if (!col && bg && (bgR <= 0 || bgSd(x, y) <= 0)) col = bg;
          if (col) { r += col[0]; g += col[1]; b += col[2]; a += 1; }
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) { out[i] = Math.round(r / a); out[i + 1] = Math.round(g / a); out[i + 2] = Math.round(b / a); }
      out[i + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return out;
}

/** 预设：各用途的标志光栅参数。 */
export const MARK_PRESETS = {
  /** 透明底、彩色方块头（任何底色）。 */
  color: (): RasterOpts => ({ eye: MARK_EYE, bg: null, fraction: 1 }),
  /** 透明底、眼睛镂空（单色 / 终端：眼睛露出底色）。 */
  cut: (): RasterOpts => ({ eye: null, bg: null, fraction: 1 }),
  /** 手机原生启动图：深色底铺满，方块头居中（与开机动画首尾帧同底色）。 */
  splash: (): RasterOpts => ({ eye: MARK_EYE, bg: SPLASH_BG, fraction: 0.15 }),
};

/** 开机动画与原生启动图的底色。 */
export const SPLASH_BG = "#1a1a1a";

// ------------------------------------------------------------ 编码 ---
const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** RGBA 像素 → PNG（色彩类型 6）。 */
export function rgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function markPng(size: number, o: RasterOpts): Buffer {
  return rgbaPng(size, size, rasterizeMark(size, o));
}

/** 多尺寸 ICO（每帧内嵌 PNG，Vista 起都支持）。 */
export function icoFromPngs(frames: { size: number; png: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach((f, i) => {
    const e = 6 + 16 * i;
    head[e] = f.size >= 256 ? 0 : f.size;
    head[e + 1] = f.size >= 256 ? 0 : f.size;
    head[e + 2] = 0; head[e + 3] = 0;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(f.png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += f.png.length;
  });
  return Buffer.concat([head, ...frames.map((f) => f.png)]);
}

/** ICNS：每项是 PNG 数据（macOS 10.7+）。type 如 icp4 / ic07 / ic14。 */
export function icnsFromPngs(entries: { type: string; png: Buffer }[]): Buffer {
  const parts = entries.map((e) => {
    const h = Buffer.alloc(8);
    h.write(e.type, 0, 4, "ascii");
    h.writeUInt32BE(e.png.length + 8, 4);
    return Buffer.concat([h, e.png]);
  });
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.write("icns", 0, 4, "ascii");
  h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}

/** ICNS 各项的像素尺寸（PNG 项）。 */
export const ICNS_TYPES: [string, number][] = [
  ["icp4", 16], ["icp5", 32], ["ic11", 32], ["ic12", 64],
  ["ic07", 128], ["ic08", 256], ["ic13", 256], ["ic09", 512], ["ic14", 512], ["ic10", 1024],
];
