// src/termMark.ts — 终端欢迎屏上的 Nyra 标志（方块头：圆角紫方块 + 两只竖眼）。
//
// 所有终端都用半块字符 ▀▄█ 拼（像素风，不画内联图片）。
//
// 半块字符画：几何来自 src/brandMark.ts（圆角方块 + 两只胶囊眼，眼睛镂空），
// 光栅化成 18×18 的覆盖率网格（每格 0–f 共 16 级），一个字符格上下各放一个像素
// （终端字符格高 ≈ 宽 × 2，所以像素是方的、方块是方的），画成 18 列 × 9 行。
// 网格预先算好写成常量（启动时不光栅化、不加载 brandMark）；
// 改了几何，tests/node/test-term-mark.test.ts 会失败并打印新常量，贴回这里即可。
//
// 字符画的三种画法：
// - color（深色终端、256 色或 truecolor）：每个像素按覆盖率在“假定深底”与团子紫 #8688ff 之间
//   混色（先过一条对比度曲线），fg/bg 各管上下半格，边缘抗锯齿；覆盖率很低的像素不上色，露出终端自己的底色——
//   眼睛就是终端底色（深色终端上 ≈ 标志的深色眼）。
// - mono（浅色终端、16 色、NO_COLOR）：覆盖率 ≥ 50% 的像素画实，不带任何颜色，用终端默认前景色，眼睛镂空。
// - 不能画块字符（老 conhost 等）或终端太窄：不调用这里，欢迎屏退回单行 "✻ Nyra"/"* Nyra"。
import { fgCode, bgCode, mix, type ColorLevel } from "./theme.ts";

type Env = Record<string, string | undefined>;

/** 覆盖率网格边长（像素）；字符画是 TERM_MARK_COLS 列 × TERM_MARK_ROWS 行。 */
export const TERM_MARK_PX = 18;
export const TERM_MARK_COLS = TERM_MARK_PX;
export const TERM_MARK_ROWS = TERM_MARK_PX / 2;

/**
 * 预先算好的覆盖率（每行 18 个十六进制数字，0 = 空、f = 全满）：
 * rasterizeMark(18, MARK_PRESETS.cut())（方块撑满、眼睛镂空、18 px 眼睛放大 18%）
 * 的 alpha，量化到 16 级。
 */
export const TERM_MARK_COVERAGE: readonly string[] = [
  "03affffffffffffa30",
  "3effffffffffffffe3",
  "affffffffffffffffa",
  "ffffffffffffffffff",
  "ffffffffffffffffff",
  "ffffffffffffffffff",
  "ffffffffffffffffff",
  "ffffe55effe55effff",
  "ffffb008ff800bffff",
  "ffffb008ff800bffff",
  "ffffb008ff800bffff",
  "ffffd22dffd22dffff",
  "ffffffffffffffffff",
  "ffffffffffffffffff",
  "ffffffffffffffffff",
  "affffffffffffffffa",
  "3effffffffffffffe3",
  "03affffffffffffa30",
];

/** 深色终端上的方块色（= brandMark 的 MARK_BODY 团子紫，测试保证二者一致）。 */
export const TERM_MARK_BODY = "#8688ff";
/** 抗锯齿混色时假定的终端底色（常见深色终端 #000–#1E1E1E 的中间值）。 */
export const TERM_MARK_ASSUMED_BG = "#121212";
/**
 * color 画法的对比度曲线：覆盖率 0.2→0.8 线性拉到 0→1（14 像素的小图，灰边太多会发虚），
 * 拉伸后低于 COLOR_FLOOR 的像素不上色（露出终端底色）。
 */
const RAMP_LO = 0.2;
const RAMP_HI = 0.8;
const COLOR_FLOOR = 0.15;

function colorAt(c: number): string | null {
  const v = Math.min(1, Math.max(0, (c - RAMP_LO) / (RAMP_HI - RAMP_LO)));
  return v < COLOR_FLOOR ? null : mix(TERM_MARK_ASSUMED_BG, TERM_MARK_BODY, v);
}
/** mono 画法里像素画实的门槛。 */
const MONO_THRESHOLD = 8 / 15;

function coverage(x: number, y: number): number {
  return parseInt(TERM_MARK_COVERAGE[y][x], 16) / 15;
}

/**
 * 终端是否是浅色底。NYRA_THEME=light|dark 优先；否则看 COLORFGBG（xterm / rxvt / iTerm /
 * Konsole 等会设，形如 "0;15"，最后一段是底色：7 或 9–15 为浅色）。判断不了时按深色。
 */
export function isLightTerminal(env: Env = process.env): boolean {
  const forced = (env.NYRA_THEME ?? "").toLowerCase();
  if (forced === "light") return true;
  if (forced === "dark") return false;
  const parts = (env.COLORFGBG ?? "").split(";");
  const bg = Number.parseInt(parts[parts.length - 1] ?? "", 10);
  if (!Number.isFinite(bg)) return false;
  return bg === 7 || (bg >= 9 && bg <= 15);
}

export type TermMarkStyle = "color" | "mono";

/** 该用哪种画法：深色终端且 ≥ 256 色才抗锯齿上色，其余（浅色 / 16 色 / 无色）都是 mono。 */
export function termMarkStyle(level: ColorLevel, light = false): TermMarkStyle {
  return level >= 2 && !light ? "color" : "mono";
}

function monoCell(top: number, bottom: number): string {
  const t = top >= MONO_THRESHOLD;
  const b = bottom >= MONO_THRESHOLD;
  return t && b ? "█" : t ? "▀" : b ? "▄" : " ";
}

/**
 * 标志的字符画：TERM_MARK_ROWS 行，每行显示宽度恰好 TERM_MARK_COLS 列（去掉 ANSI 后）。
 * mono 不带任何转义序列。
 */
export function renderTermMark(opts: { level: ColorLevel; light?: boolean }): string[] {
  const style = termMarkStyle(opts.level, opts.light);
  const lines: string[] = [];
  for (let row = 0; row < TERM_MARK_ROWS; row++) {
    let line = "";
    for (let x = 0; x < TERM_MARK_COLS; x++) {
      const top = coverage(x, row * 2);
      const bottom = coverage(x, row * 2 + 1);
      if (style === "mono") { line += monoCell(top, bottom); continue; }
      const tc = colorAt(top);
      const bc = colorAt(bottom);
      if (!tc && !bc) line += " ";
      else if (tc && bc && tc === bc) line += `\x1b[${fgCode(tc, opts.level)}m█\x1b[0m`;
      else if (tc && bc) line += `\x1b[${fgCode(tc, opts.level)};${bgCode(bc, opts.level)}m▀\x1b[0m`;
      else if (tc) line += `\x1b[${fgCode(tc, opts.level)}m▀\x1b[0m`;
      else line += `\x1b[${fgCode(bc!, opts.level)}m▄\x1b[0m`;
    }
    lines.push(line);
  }
  return lines;
}
