// src/mascots.ts — Nyra 的 agent 头像“丸子”：8 个成员 + 1 个总指挥（设计稿 nyra-design v14.1 的 mascots14.py 移植）。
//
// 同一画风：实心柔形身体 + 左上一块柔光 + 底沿一道暗边；同一眼睛语言：#141414 竖胶囊眼（与品牌方块头同一对眼）。
// 颜色 + 轮廓两重区分不同 agent（色弱也能靠形状认人）。品牌方块头（紫色圆角方 + 竖眼）只做品牌，
// 丸子都不用“紫色 + 圆角方”这一组合；总指挥是唯一浅色身体、头顶一根带紫灯的天线。
//
// 状态只改眼睛：idle 空闲（竖眼）、think 思考（竖眼往右上看）、work 工作中（眯成横条）、
// wait 等你确认（圆眼，≥32px 带问号）、done 完成（仍是竖眼正视，右下角一枚绿色对勾角标）。
// 不画笑眼：任何状态的眼睛都不是弧线（v14.1 起去掉了“^^ 弯眼”的完成态，测试里有断言）。
//
// 页面里会同时出现很多丸子：clipPath / mask 的 id 用 "__ID__" 占位，服务端 mascotSvg() 直接给唯一 id，
// 手机页拿模板时由前端把占位换成自增 id（见 mobile-app.js.txt 的 mascot()）。
const EYE = "#141414";
const OK = "#3FB950";

export type MascotState = "idle" | "think" | "work" | "wait" | "done";
export const MASCOT_STATES: MascotState[] = ["idle", "think", "work", "wait", "done"];
export type MascotShape = "circle" | "squircle" | "hexagon" | "capsule" | "drop" | "cloud" | "arch" | "pebble" | "chief";

export interface MascotDef {
  key: string;
  /** 角色表上的示例名（界面上显示 agent 自己的名字，不显示这个）。 */
  name: string;
  role: string;
  color: string;
  shape: MascotShape;
}

/** 8 个成员丸子（顺序即分配顺序：nyra 永远是默认助手）。 */
export const MASCOTS: MascotDef[] = [
  { key: "nyra", name: "Nyra", role: "默认助手", color: "#8688ff", shape: "circle" },
  { key: "patrol", name: "巡检", role: "依赖与安全检查", color: "#2fbf71", shape: "squircle" },
  { key: "night", name: "夜班", role: "夜里跑长任务", color: "#f08a24", shape: "hexagon" },
  { key: "tester", name: "测试员", role: "写测试、跑回归", color: "#2bb3e0", shape: "capsule" },
  { key: "docs", name: "文档", role: "写说明和示例", color: "#f2679c", shape: "drop" },
  { key: "weekly", name: "周报", role: "每周汇总进展", color: "#e9b10e", shape: "cloud" },
  { key: "scout", name: "调研", role: "查资料、比方案", color: "#b77cf5", shape: "arch" },
  { key: "lingo", name: "翻译", role: "中英文本互译", color: "#19b8a8", shape: "pebble" },
];
/** 总指挥（代码标识 chief）：唯一浅色身体 + 头顶天线紫灯。 */
export const CHIEF_MASCOT: MascotDef = { key: "chief", name: "总指挥", role: "拆任务、分派、汇总", color: "#E9E8F1", shape: "chief" };
const ALL: Record<string, MascotDef> = Object.fromEntries([...MASCOTS, CHIEF_MASCOT].map((m) => [m.key, m]));
export const MASCOT_KEYS = [...MASCOTS.map((m) => m.key), CHIEF_MASCOT.key];

const fmt = (v: number) => {
  const s = v.toFixed(2);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};

function roundedPoly(pts: [number, number][], r: number): string {
  const n = pts.length;
  let d = "";
  const toward = (a: [number, number], b: [number, number], t: number): [number, number] => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [a[0] + (b[0] - a[0]) * t / L, a[1] + (b[1] - a[1]) * t / L];
  };
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const a = toward(p1, p0, r), b = toward(p1, p2, r);
    // 多边形圆角用二次曲线：身体轮廓（填充），不是眼睛。
    d += `${i === 0 ? "M" : "L"}${fmt(a[0])} ${fmt(a[1])}Q${fmt(p1[0])} ${fmt(p1[1])} ${fmt(b[0])} ${fmt(b[1])}`;
  }
  return d + "Z";
}

function smoothClosed(pts: [number, number][], k = 0.5): string {
  const n = pts.length;
  let d = `M${fmt(pts[0][0])} ${fmt(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) * k / 3, p1[1] + (p2[1] - p0[1]) * k / 3];
    const c2 = [p2[0] - (p3[0] - p1[0]) * k / 3, p2[1] - (p3[1] - p1[1]) * k / 3];
    d += `C${fmt(c1[0])} ${fmt(c1[1])} ${fmt(c2[0])} ${fmt(c2[1])} ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  return d + "Z";
}

function squircle(cx: number, cy: number, rx: number, ry: number, n: number, steps = 72): string {
  const pts: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = 2 * Math.PI * i / steps, c = Math.cos(t), s = Math.sin(t);
    pts.push(`${fmt(cx + rx * Math.sign(c) * Math.abs(c) ** (2 / n))} ${fmt(cy + ry * Math.sign(s) * Math.abs(s) ** (2 / n))}`);
  }
  return "M" + pts.join("L") + "Z";
}

interface BodyGeom {
  parts: string[];
  face: [number, number];
  dx: number;
  q: [number, number];
  hl: [number, number, number, number, number];
}

const bodyCache = new Map<MascotShape, BodyGeom>();
function body(shape: MascotShape): BodyGeom {
  const hit = bodyCache.get(shape);
  if (hit) return hit;
  let g: BodyGeom;
  switch (shape) {
    case "circle": g = { parts: ['<circle cx="50" cy="51" r="46"/>'], face: [50, 54], dx: 14, q: [76, 26], hl: [32, 28, 13, 8, -35] }; break;
    case "squircle": g = { parts: [`<path d="${squircle(50, 51, 45, 44, 3.6)}"/>`], face: [50, 54], dx: 14, q: [78, 24], hl: [27, 24, 12, 7, -30] }; break;
    case "hexagon": {
      const pts: [number, number][] = [];
      for (let a = -90; a < 270; a += 60) pts.push([50 + 50 * Math.cos(a * Math.PI / 180), 51 + 50 * Math.sin(a * Math.PI / 180)]);
      g = { parts: [`<path d="${roundedPoly(pts, 14)}"/>`], face: [50, 55], dx: 14, q: [75, 28], hl: [31, 27, 11, 6.5, -32] };
      break;
    }
    case "capsule": g = { parts: ['<rect x="3" y="22" width="94" height="60" rx="30"/>'], face: [48, 53], dx: 14, q: [80, 44], hl: [24, 36, 11, 6, -20] }; break;
    case "drop": g = { parts: ['<path d="M40.6 18.4L76 13.4C82.67 12.47 85.93 15.37 85.8 22.1L85 57.9A39 39 0 1 1 40.6 18.4Z"/>'], face: [45, 60], dx: 13, q: [71, 34], hl: [30, 39, 11, 6.5, -35] }; break;
    case "cloud": g = { parts: ['<circle cx="29" cy="55" r="22"/>', '<circle cx="54" cy="39" r="28"/>', '<circle cx="76" cy="56" r="20"/>', '<rect x="5" y="51" width="90" height="40" rx="20"/>'], face: [50, 67], dx: 14, q: [60, 30], hl: [44, 24, 11, 6, -20] }; break;
    case "arch": g = { parts: ['<path d="M8 52A42 42 0 0 1 92 52V84C92 92 88 96 80 96H20C12 96 8 92 8 84Z"/>'], face: [50, 61], dx: 14, q: [74, 32], hl: [31, 26, 11, 6.5, -35] }; break;
    case "pebble": g = { parts: [`<path d="${smoothClosed([[38, 10], [72, 9], [94, 33], [92, 69], [66, 93], [30, 93], [6, 71], [8, 33]])}"/>`], face: [50, 54], dx: 14, q: [75, 27], hl: [30, 25, 12, 7, -30] }; break;
    case "chief": g = { parts: [`<path d="${squircle(50, 60, 44, 38, 3.4)}"/>`], face: [50, 62], dx: 14, q: [80, 36], hl: [29, 37, 11, 6, -25] }; break;
    default: throw new Error(`未知丸子形状：${shape as string}`);
  }
  bodyCache.set(shape, g);
  return g;
}

function pill(cx: number, cy: number, w: number, h: number): string {
  return `<rect x="${fmt(cx - w / 2)}" y="${fmt(cy - h / 2)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(Math.min(w, h) / 2)}" fill="${EYE}"/>`;
}

/** 眼睛（只用竖胶囊、横条、圆点三种几何；没有弧线眼）。 */
function eyes(state: MascotState, face: [number, number], dx: number, q: [number, number], size: number): string {
  const k = size <= 20 ? 1.18 : size <= 30 ? 1.08 : 1;
  const [fx, fy] = face;
  const L: [number, number] = [fx - dx * k, fy], R: [number, number] = [fx + dx * k, fy];
  switch (state) {
    case "idle":
    case "done":
      return pill(L[0], L[1], 12 * k, 21 * k) + pill(R[0], R[1], 12 * k, 21 * k);
    case "think": {
      const ox = 6 * k, oy = -7 * k;
      return pill(L[0] + ox, L[1] + oy, 11 * k, 18 * k) + pill(R[0] + ox, R[1] + oy, 11 * k, 18 * k);
    }
    case "work":
      return pill(L[0], L[1] + 2, 17 * k, 7.5 * k) + pill(R[0], R[1] + 2, 17 * k, 7.5 * k);
    case "wait": {
      const r = 9.5 * k;
      let s = `<circle cx="${fmt(L[0])}" cy="${fmt(L[1])}" r="${fmt(r)}" fill="${EYE}"/><circle cx="${fmt(R[0])}" cy="${fmt(R[1])}" r="${fmt(r)}" fill="${EYE}"/>`;
      if (size >= 32) {
        s += `<g transform="translate(${q[0]} ${q[1]})"><path d="M-5.5 -4.5A5.6 5.6 0 1 1 1.6 1C0.2 1.8 0 3 0 4.6" fill="none" stroke="${EYE}" stroke-width="4.2" stroke-linecap="round"/><circle cx="0" cy="10.6" r="2.5" fill="${EYE}"/></g>`;
      }
      return s;
    }
    default:
      throw new Error(`未知丸子状态：${state as string}`);
  }
}

/** 完成角标：右下角一枚绿色圆 + 白色对勾（折线，不是弧线），外圈描一道地面色把它和身体分开。 */
function doneBadge(size: number): string {
  const r = size <= 20 ? 17 : 13;
  const cx = 100 - r - 1.5, cy = 100 - r - 1.5;
  const s = r / 13;
  return `<g class="mc-done"><circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r + 3.2)}" fill="#1a1a1a"/><circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="${OK}"/>` +
    `<path d="M${fmt(cx - 5.6 * s)} ${fmt(cy + 0.4 * s)}L${fmt(cx - 1.6 * s)} ${fmt(cy + 4.4 * s)}L${fmt(cx + 5.8 * s)} ${fmt(cy - 3.8 * s)}" fill="none" stroke="#fff" stroke-width="${fmt(3.6 * s)}" stroke-linecap="round" stroke-linejoin="round"/></g>`;
}

export interface MascotOpts {
  /** 变暗（已停止 / 离线旧数据）。 */
  dim?: boolean;
  /** 独立 SVG 文件（带 xmlns）。 */
  standalone?: boolean;
  /** clipPath / mask 的 id 后缀；不给则用 "__ID__" 占位（由调用方替换）。 */
  id?: string;
  /** aria 名字（默认用角色表示例名）。 */
  label?: string;
}

/** 两档尺寸：s = ≤20px（列表叠放、角标，眼睛放大 18%、无柔光），m = 常规。 */
export type MascotSize = "s" | "m";
export const sizeClass = (px: number): MascotSize => (px <= 20 ? "s" : "m");

/** 一只丸子的拼装件（手机页前端按同一顺序拼，见 MASCOT_COMPOSE_JS）。 */
export interface MascotPiece {
  color: string;
  /** 身体形状（clipPath、身体、mask 三处共用）。 */
  shape: string;
  antenna: string;
  /** 柔光（m 档才有）。 */
  hi: string;
  /** 眼睛：状态 → 档 → SVG 片段。 */
  eyes: Record<MascotState, Record<MascotSize, string>>;
}

export function mascotPiece(key: string): MascotPiece {
  const def = ALL[key] ?? ALL.nyra;
  const g = body(def.shape);
  const [hx, hy, rx, ry, rot] = g.hl;
  const eyesBy = {} as Record<MascotState, Record<MascotSize, string>>;
  for (const st of MASCOT_STATES) eyesBy[st] = { s: eyes(st, g.face, g.dx, g.q, 18), m: eyes(st, g.face, g.dx, g.q, 40) };
  return {
    color: def.color,
    shape: g.parts.join(""),
    antenna: def.shape === "chief"
      ? `<path d="M50 23V11" stroke="${def.color}" stroke-width="5" stroke-linecap="round"/><circle cx="50" cy="9" r="7.5" fill="#8688ff"/><circle cx="48" cy="7" r="2.3" fill="#fff" opacity=".55"/>`
      : "",
    hi: `<ellipse cx="${hx}" cy="${hy}" rx="${rx}" ry="${ry}" transform="rotate(${rot} ${hx} ${hy})" fill="#fff" opacity=".17"/>`,
    eyes: eyesBy,
  };
}

/** 完成角标两档。 */
export const MASCOT_BADGE: Record<MascotSize, string> = { s: doneBadge(18), m: doneBadge(40) };

/**
 * 拼装函数（纯字符串，服务端与手机页前端共用同一段源码：前端把它原样内联进页面，
 * 测试会逐只逐态比对两边输出一致）。
 */
export const MASCOT_COMPOSE_JS = `function composeMascot(p, key, state, cls, id, label, dim, badge){
  var cid = 'mc' + key + id;
  return '<svg class="mc" viewBox="0 0 100 100" role="img" aria-label="' + label + '" data-mc="' + key + '" data-state="' + state + '"' + (dim ? ' opacity=".45"' : '') + '>'
    + '<defs><clipPath id="' + cid + '">' + p.shape + '</clipPath><mask id="' + cid + 'm"><rect width="100" height="100" fill="#fff"/><g transform="translate(0 -6)" fill="#000">' + p.shape + '</g></mask></defs>'
    + p.antenna + '<g fill="' + p.color + '">' + p.shape + '</g>'
    + '<g clip-path="url(#' + cid + ')"><g fill="#000" opacity=".13"><rect x="0" y="0" width="100" height="100" mask="url(#' + cid + 'm)"/></g></g>'
    + (cls === 'm' ? p.hi : '') + p.eyes[state][cls] + (state === 'done' ? badge[cls] : '') + '</svg>';
}`;
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const composeMascot = new Function(`${MASCOT_COMPOSE_JS}; return composeMascot;`)() as (
  p: MascotPiece, key: string, state: MascotState, cls: MascotSize, id: string, label: string, dim: boolean, badge: Record<MascotSize, string>,
) => string;

/** 一个丸子的 SVG（视框 100，宽高由 CSS 定）。size ≤20 用 s 档。 */
export function mascotSvg(key: string, state: MascotState = "idle", size = 64, opts: MascotOpts = {}): string {
  const def = ALL[key] ?? ALL.nyra;
  const label = (opts.label ?? def.name).replace(/[<>&"]/g, "");
  const svg = composeMascot(mascotPiece(def.key), def.key, state, sizeClass(size), opts.id ?? "__ID__", label, !!opts.dim, MASCOT_BADGE);
  return opts.standalone ? svg.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ') : svg;
}

/** 手机页嵌入的数据：每只丸子的拼装件 + 角标。 */
export function mascotClientData(): { pieces: Record<string, MascotPiece>; badge: Record<MascotSize, string>; names: Record<string, string> } {
  const pieces: Record<string, MascotPiece> = {};
  for (const key of MASCOT_KEYS) pieces[key] = mascotPiece(key);
  return { pieces, badge: MASCOT_BADGE, names: Object.fromEntries(MASCOT_KEYS.map((k) => [k, ALL[k].name])) };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const MEMBER_KEYS = MASCOTS.map((m) => m.key).filter((k) => k !== "nyra");
/**
 * agent → 丸子。默认助手（nyra / default / 空）用 Nyra 丸子；chief 用总指挥；
 * 名字正好是丸子 key 的用它自己；其他按名字散列到 7 个成员丸子之一（同名永远同一只）。
 */
export function mascotKeyFor(agentId: string | null | undefined, role?: string | null): string {
  const id = String(agentId ?? "").trim().toLowerCase();
  if (role === "chief" || id === "chief") return "chief";
  if (!id || id === "nyra" || id === "default") return "nyra";
  if (ALL[id]) return id;
  return MEMBER_KEYS[hashStr(id) % MEMBER_KEYS.length];
}

/** 一组 agent 各分一只不重复的丸子（群聊成员用：先按 mascotKeyFor，撞了就顺延到下一只没用过的）。 */
export function assignMascots(agentIds: string[]): Record<string, string> {
  const used = new Set<string>();
  const out: Record<string, string> = {};
  for (const id of agentIds) {
    let key = mascotKeyFor(id);
    if (used.has(key) && key !== "chief") {
      const pool = MEMBER_KEYS.concat("nyra");
      const start = pool.indexOf(key);
      for (let i = 1; i <= pool.length; i++) {
        const k = pool[(start + i) % pool.length];
        if (!used.has(k)) { key = k; break; }
      }
    }
    used.add(key);
    out[id] = key;
  }
  return out;
}

export function mascotDef(key: string): MascotDef {
  return ALL[key] ?? ALL.nyra;
}

/**
 * 笑眼检测（测试与自检用）：SVG 里有没有“用描边画的弧线眼”——stroke 为眼睛色的 path 里出现二次 / 三次曲线。
 * 问号（wait 态）用的是圆弧 A 命令，不算笑眼。
 */
export function hasSmileEyes(svg: string): boolean {
  const re = /<path\b[^>]*>/g;
  for (const m of svg.matchAll(re)) {
    const tag = m[0];
    const stroke = /stroke=\\?"#141414\\?"/i.test(tag);
    const d = /d=\\?"([^"\\]*)/.exec(tag)?.[1] ?? "";
    // 问号（wait 态）固定以 "M-5.5 -4.5A" 起笔：圆弧 + 竖钩，不是眼睛。
    if (stroke && /[QqCcSsTt]/.test(d) && !d.startsWith("M-5.5 -4.5A")) return true;
  }
  return false;
}
