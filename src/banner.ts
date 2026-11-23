// src/banner.ts — 交互终端外观 v2（品牌化）：
//   1. 欢迎屏：左边是用半块字符拼的 Nyra 标志（方块头，18 列 × 9 行，见 termMark.ts），
//      右边 "Nyra 版本" + 一句话介绍；下面一张圆角信息卡（模型 / 模式徽章 / 目录 / git 分支），
//      再一行 Tips；窄于 MARK_MIN_COLS 列退回单行 "✻ Nyra"。
//   2. 工作区信任：简短的框式确认。
//   3. 输入区：主色 "›" 提示符，暗主色横线；状态栏是彩色分段，左右对齐。
// 全部是纯函数（文本进、行出），便于快照测试；只做零依赖的环境探测和几次同步小文件读
// （git 分支读 .git/HEAD），不 spawn 子进程，不拖慢启动。
//
// 字形：能画框线的终端用 ╭─╮│╰╯、半块字符标志与 ✻；Windows 上只有确认能渲染的终端
// （Windows Terminal / VS Code / ConEmu / mintty 等）才用，否则（老 conhost
// 点阵字体、未知宿主）退回纯 ASCII，保证不出乱码。NYRA_ASCII=1 强制 ASCII，
// NYRA_UNICODE=1 强制框线。NO_COLOR 只去掉颜色，布局不变。
import { homedir } from "node:os";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { charWidth, textWidth, truncateWidth } from "./consoleUi.ts";
import { BRAND, gradient, paint as paintRaw, type ColorLevel, type PaintOpts } from "./theme.ts";
import { renderTermMark, TERM_MARK_COLS, TERM_MARK_ROWS } from "./termMark.ts";
import { t } from "./i18n.ts";

export { supportsBoxDrawing } from "./theme.ts";

export interface Glyphs {
  tl: string; tr: string; bl: string; br: string; h: string; v: string;
  mark: string; dot: string; ellipsis: string; prompt: string; branch: string;
}

export const UNICODE_GLYPHS: Glyphs = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", mark: "✻", dot: "·", ellipsis: "…", prompt: "›", branch: "⎇",
};
export const ASCII_GLYPHS: Glyphs = {
  tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", mark: "*", dot: "-", ellipsis: "...", prompt: ">", branch: "git:",
};

export function glyphsFor(unicode: boolean): Glyphs {
  return unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
}

/** 渲染选项：color=true 且没给 level 时按 truecolor 画（便于测试稳定）；cli 传探测到的 level。 */
export interface RenderOpts { width: number; color?: boolean; level?: ColorLevel; unicode?: boolean }

function levelOf(o: { color?: boolean; level?: ColorLevel }): ColorLevel {
  if (o.level !== undefined) return o.color === false ? 0 : o.level;
  return o.color ? 3 : 0;
}

/** 去掉 ANSI 颜色序列（测试与宽度计算用）。 */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** 从左侧截断（保留尾部），超宽时以省略号开头：适合路径。 */
export function truncateLeft(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (textWidth(text) <= width) return text;
  const limit = width - textWidth(ellipsis);
  if (limit <= 0) return ellipsis.slice(0, width);
  const chars = [...text];
  const out: string[] = [];
  let used = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = charWidth(chars[i]);
    if (used + w > limit) break;
    out.unshift(chars[i]);
    used += w;
  }
  return ellipsis + out.join("");
}

/** 家目录换成 ~，再按列宽从左截断。 */
export function shortenPath(path: string, width: number, home: string = homedir(), ellipsis = "…"): string {
  let p = path;
  if (home) {
    const sep = p.includes("\\") && !p.includes("/") ? "\\" : "/";
    const norm = (s: string) => (sep === "\\" ? s.toLowerCase() : s);
    if (norm(p) === norm(home)) p = "~";
    else if (norm(p).startsWith(norm(home.endsWith(sep) ? home : home + sep))) {
      p = "~" + sep + p.slice(home.length).replace(/^[\\/]+/, "");
    }
  }
  return truncateLeft(p, width, ellipsis);
}

function padTo(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - textWidth(text)));
}

/**
 * 当前 git 分支：向上找 .git（目录或 worktree 的 gitdir 文件），读 HEAD。
 * 分离 HEAD 时返回短 sha；不是仓库或读失败返回 null。只做同步小文件读，不 spawn git。
 */
export function gitBranch(cwd: string): string | null {
  try {
    let dir = resolve(cwd);
    for (let i = 0; i < 40; i++) {
      const dotGit = join(dir, ".git");
      if (existsSync(dotGit)) {
        let gitDir = dotGit;
        if (statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf-8"));
          if (!m) return null;
          gitDir = resolve(dir, m[1].trim());
        }
        const head = readFileSync(join(gitDir, "HEAD"), "utf-8").trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        if (ref) return ref[1];
        return /^[0-9a-f]{7,}$/i.test(head) ? head.slice(0, 7) : null;
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch { /* 读不到就不显示分支 */ }
  return null;
}

/** 宽度低于此值时欢迎屏退回单行 "✻ Nyra"（标志 + 右侧文字至少要这么宽）。 */
export const MARK_MIN_COLS = 40;
/** 标志右侧文字所在的行（标题与介绍夹住圆心所在的行）。 */
const MARK_TITLE_ROW = Math.floor(TERM_MARK_ROWS / 2) - 1;
/** 欢迎屏里标志左边留的空格列数。 */
const MARK_LEFT_COL = 1;

/** 模式徽章的底色：readonly 绿 / auto 蓝紫 / full 红 / creator 珊瑚。 */
export function modeColor(mode: string): string {
  switch (mode) {
    case "readonly": return BRAND.badgeReadonly;
    case "full": return BRAND.badgeFull;
    case "creator": return BRAND.badgeCreator;
    default: return BRAND.badgeAuto;
  }
}

/** 模式徽章：" auto "（无色时同样带空格，布局不变）。 */
export function modeBadge(mode: string, level: ColorLevel): string {
  return paintRaw(` ${mode} `, level, { fg: BRAND.badgeFg, bg: modeColor(mode), bold: true });
}

type Row = { text: string; render?: (fitted: string) => string };

/**
 * 把若干行画进圆角框。框宽 = 内容宽 + 4，不超过终端宽度；内容超宽时截断。
 * 终端太窄（< 24 列）就不画框，只出文本。
 */
function boxed(rows: Row[], width: number, level: ColorLevel, g: Glyphs, minInner = 0, border: string = BRAND.border): string[] {
  const cols = Math.max(1, width);
  const fit = (r: Row, w: number) => {
    const t = truncateWidth(r.text, w, g.ellipsis);
    return { t, painted: r.render ? r.render(t) : t };
  };
  if (cols < 24) return rows.map((r) => fit(r, cols).painted);
  const maxInner = cols - 4;
  const inner = Math.min(maxInner, Math.max(minInner, ...rows.map((r) => textWidth(r.text))));
  const b = (s: string) => paintRaw(s, level, { fg: border });
  const out = [b(g.tl + g.h.repeat(inner + 2) + g.tr)];
  for (const r of rows) {
    const { t, painted } = fit(r, inner);
    out.push(`${b(g.v)} ${painted}${" ".repeat(Math.max(0, inner - textWidth(t)))} ${b(g.v)}`);
  }
  out.push(b(g.bl + g.h.repeat(inner + 2) + g.br));
  return out;
}

export interface HeaderInfo {
  version: string;
  model: string;
  mode: string;
  cwd: string;
  /** git 分支；不传 = 不显示。 */
  branch?: string | null;
  tagline?: string;
}

/** 默认一句话介绍（中文，兼容旧调用方）；欢迎屏实际按当前界面语言取 t("banner.tagline")。 */
export const DEFAULT_TAGLINE = "跑在你电脑上的开源 AI Agent";

/** 欢迎屏这次会不会画标志（否则是单行 "✻ Nyra"）。 */
function headerShowsMark(opts: { width: number; unicode?: boolean; compact?: boolean }): boolean {
  return (opts.unicode ?? true) && !opts.compact && Math.max(1, opts.width) >= MARK_MIN_COLS;
}

/**
 * 欢迎屏：宽屏（≥ MARK_MIN_COLS 列且能画框线）是半块字符标志 + "Nyra 版本" + 介绍 + 信息卡；
 * 窄屏、ASCII 回退或 compact（非 TTY）是单行 "✻ Nyra <版本>" + 信息卡。
 */
export function renderHeader(info: HeaderInfo, opts: RenderOpts & { home?: string; compact?: boolean; light?: boolean }): string[] {
  const level = levelOf(opts);
  const unicode = opts.unicode ?? true;
  const g = glyphsFor(unicode);
  const cols = Math.max(1, opts.width);
  const out: string[] = [];
  const tagline = info.tagline ?? t("banner.tagline");
  const version = `v${info.version}`;
  out.push(""); // 与上方（信任确认或命令行）隔开一行
  if (headerShowsMark({ width: cols, unicode, compact: opts.compact })) {
    // 标志在左，"Nyra 版本" 与一句话介绍在右侧、对齐圆心；介绍放不下时截断。
    const mark = renderTermMark({ level, light: opts.light });
    const textCol = MARK_LEFT_COL + TERM_MARK_COLS + 3;
    const room = Math.max(1, cols - textCol - 1);
    const title = truncateWidth(`Nyra ${version}`, room, g.ellipsis);
    // 浅色终端上 BRAND.text（近白）看不见：标题用终端默认前景色加粗。
    const titleStyle: PaintOpts = opts.light ? { bold: true } : { fg: BRAND.text, bold: true };
    const titlePainted = title === `Nyra ${version}`
      ? paintRaw("Nyra", level, titleStyle) + " " + paintRaw(version, level, { fg: BRAND.muted })
      : paintRaw(title, level, titleStyle);
    const side: Record<number, string> = {
      [MARK_TITLE_ROW]: titlePainted,
      [MARK_TITLE_ROW + 1]: paintRaw(truncateWidth(tagline, room, g.ellipsis), level, { fg: BRAND.muted }),
    };
    for (let i = 0; i < TERM_MARK_ROWS; i++) {
      const row = " ".repeat(MARK_LEFT_COL) + mark[i];
      out.push(side[i] ? row + "   " + side[i] : row.replace(/ +$/, ""));
    }
    out.push("");
  } else {
    const plain = `${g.mark} Nyra ${info.version}`;
    const t = truncateWidth(plain, cols, g.ellipsis);
    out.push(t === plain
      ? paintRaw(g.mark, level, { fg: BRAND.coral, bold: true }) + " " + gradient("Nyra", level, BRAND.sage, BRAND.mist, true) + " " + paintRaw(info.version, level, { fg: BRAND.muted })
      : t);
  }
  out.push(...renderInfoCard(info, { ...opts, level }));
  return out;
}

/** 信息卡：模型 / 模式徽章 / 目录 / 分支（是 git 仓库时）。 */
export function renderInfoCard(info: HeaderInfo, opts: RenderOpts & { home?: string }): string[] {
  const level = levelOf(opts);
  const g = glyphsFor(opts.unicode ?? true);
  const cols = Math.max(1, opts.width);
  const cardW = Math.min(cols, 62);
  const inner = Math.max(1, cardW - 4);
  // 标签按显示宽度补齐（中文 2 列/字，英文标签长短不一），值列始终对齐。
  const names = { model: t("card.model"), mode: t("card.mode"), dir: t("card.dir"), branch: t("card.branch") };
  const labelW = Math.max(...Object.values(names).map((n) => textWidth(n)));
  const label = (l: string) => `${padTo(l, labelW)}  `;
  const lw = textWidth(label(names.model));
  const muted = (s: string) => paintRaw(s, level, { fg: BRAND.muted });
  const labeled = (l: string, value: string, valueStyle: PaintOpts): Row => ({
    text: label(l) + value,
    render: (s) => muted(s.slice(0, label(l).length)) + paintRaw(s.slice(label(l).length), level, valueStyle),
  });
  const dir = shortenPath(info.cwd, Math.max(8, inner - lw), opts.home ?? homedir(), g.ellipsis);
  const rows: Row[] = [
    labeled(names.model, info.model, { fg: BRAND.text }),
    {
      text: label(names.mode) + ` ${info.mode} `,
      render: (s) => s.length >= label(names.mode).length + info.mode.length + 2
        ? muted(label(names.mode)) + modeBadge(info.mode, level)
        : muted(s),
    },
    labeled(names.dir, dir, { fg: BRAND.text }),
  ];
  if (info.branch) rows.push(labeled(names.branch, `${g.branch}${opts.unicode === false ? "" : " "}${info.branch}`, { fg: BRAND.mist }));
  return boxed(rows, cardW, level, g, Math.min(inner, 40));
}

/** Tips 一行：只列 Nyra 真有的命令。 */
export function renderTips(opts: RenderOpts & { pet?: boolean; lang?: boolean }): string {
  const level = levelOf(opts);
  const g = glyphsFor(opts.unicode ?? true);
  // /lang 紧跟 /help：窄屏从后往前丢时也尽量留住（切语言的入口）。
  const items: [string, string][] = [["/help", t("tips.help")]];
  if (opts.lang !== false) items.push([t("tips.langCmd"), t("tips.lang")]);
  items.push(["/mode", t("tips.mode")], ["/undo", t("tips.undo")]);
  if (opts.pet) items.push(["/pet", t("tips.pet")]);
  const sep = ` ${g.dot} `;
  const plainItems = items.map(([c, d]) => `${c} ${d}`);
  const head = t("tips.head") + " ";
  // 放不下时从后往前丢。
  let n = items.length;
  while (n > 1 && textWidth(" " + head + plainItems.slice(0, n).join(sep)) > opts.width - 1) n--;
  const plain = " " + head + plainItems.slice(0, n).join(sep);
  if (textWidth(plain) > opts.width - 1) return truncateWidth(plain, Math.max(1, opts.width - 1), g.ellipsis);
  return " " + paintRaw(t("tips.head"), level, { fg: BRAND.coral, bold: true }) + " "
    + items.slice(0, n).map(([c, d]) => paintRaw(c, level, { fg: BRAND.sage, bold: true }) + " " + paintRaw(d, level, { fg: BRAND.muted })).join(paintRaw(sep, level, { fg: BRAND.muted }));
}

/** 工作区信任：简短框式确认；最后一行是提问（调用方在其后读 y/N）。 */
export function renderTrustPrompt(path: string, opts: RenderOpts & { home?: string }): { lines: string[]; question: string } {
  const level = levelOf(opts);
  const g = glyphsFor(opts.unicode ?? true);
  const cols = Math.max(1, Math.min(opts.width, 72));
  const inner = Math.max(1, cols - 4);
  const shown = truncateLeft(path, cols < 24 ? cols : inner, g.ellipsis);
  const lines = boxed(
    [
      { text: t("trust.title"), render: (s) => paintRaw(s, level, { fg: BRAND.coral, bold: true }) },
      { text: shown, render: (s) => paintRaw(s, level, { fg: BRAND.text, bold: true }) },
      { text: t("trust.body"), render: (s) => paintRaw(s, level, { fg: BRAND.muted }) },
    ],
    cols, level, g, Math.min(inner, 36), BRAND.coral,
  );
  return { lines, question: t("trust.question") };
}

/** 输入区的横线（暗主色）。 */
export function renderRule(width: number, opts: { color?: boolean; level?: ColorLevel; unicode?: boolean } = {}): string {
  const g = glyphsFor(opts.unicode ?? true);
  return paintRaw(g.h.repeat(Math.max(1, width)), levelOf(opts), { fg: BRAND.rule });
}

export interface StatusInfo {
  model: string;
  mode: string;
  /** 0..1；null = 模型没有报告，显示 --（不估算）。 */
  contextUsage: number | null;
  /** 只有当前运行时真的支持 shift+tab 切换模式时才传 true。 */
  modeSwitchKey?: boolean;
  branch?: string | null;
  /** P2-3：成本段（`成本 $0.0123/$0.50` 或 `成本未知`）；不传时不显示。 */
  cost?: string | null;
}

/**
 * 状态栏：左边 模型 + 模式徽章，右边 上下文 n% · 成本 · 分支，左右对齐到 width。
 * 放不下时依次丢掉 shift+tab 提示、分支、成本、上下文，最后截断模型名。
 */
export function renderStatusBar(info: StatusInfo, opts: RenderOpts): string {
  const level = levelOf(opts);
  const unicode = opts.unicode ?? true;
  const g = glyphsFor(unicode);
  const width = Math.max(1, opts.width);
  const pctNum = info.contextUsage === null || info.contextUsage === undefined || !Number.isFinite(info.contextUsage)
    ? null : Math.round(info.contextUsage * 100);
  const pct = pctNum === null ? "--" : `${pctNum}%`;
  const pctColor = pctNum === null ? BRAND.muted : pctNum >= 85 ? BRAND.danger : pctNum >= 60 ? BRAND.coral : BRAND.sage;
  const sep = ` ${g.dot} `;
  const muted = (s: string) => paintRaw(s, level, { fg: BRAND.muted });
  type Seg = { plain: string; painted: string };
  const ctxLabel = t("status.context");
  const ctx: Seg = { plain: `${ctxLabel} ${pct}`, painted: muted(ctxLabel + " ") + paintRaw(pct, level, { fg: pctColor, bold: pctNum !== null }) };
  const br: Seg | null = info.branch
    ? { plain: `${g.branch}${unicode ? " " : ""}${info.branch}`, painted: paintRaw(`${g.branch}${unicode ? " " : ""}${info.branch}`, level, { fg: BRAND.mist }) }
    : null;
  const cost: Seg | null = info.cost ? { plain: info.cost, painted: paintRaw(info.cost, level, { fg: info.cost.includes("$") ? BRAND.coral : BRAND.muted }) } : null;
  const hint: Seg | null = info.modeSwitchKey ? { plain: t("status.modeHint"), painted: muted(t("status.modeHint")) } : null;
  const badgePlain = ` ${info.mode} `;
  const lead = "  ";
  const room = width - 1; // 最后一列留空，避免自动换行
  const candidates: Seg[][] = [
    [hint, ctx, cost, br].filter(Boolean) as Seg[],
    [ctx, cost, br].filter(Boolean) as Seg[],
    [ctx, cost].filter(Boolean) as Seg[],
    [ctx],
    [],
  ];
  for (const right of candidates) {
    const rightPlain = right.map((s) => s.plain).join(sep);
    const leftMin = textWidth(lead + badgePlain) + 1 + Math.min(8, textWidth(info.model));
    if (right.length && leftMin + 2 + textWidth(rightPlain) > room) continue;
    const modelRoom = room - textWidth(lead + " " + badgePlain) - (right.length ? 2 + textWidth(rightPlain) : 0);
    if (modelRoom < 1) {
      if (right.length) continue;
      return truncateWidth(lead + info.model, room, g.ellipsis);
    }
    const model = truncateWidth(info.model, modelRoom, g.ellipsis);
    const leftPlain = lead + model + " " + badgePlain;
    const gap = right.length ? room - textWidth(leftPlain) - textWidth(rightPlain) : 0;
    return lead + paintRaw(model, level, { fg: BRAND.muted }) + " " + modeBadge(info.mode, level)
      + (right.length ? " ".repeat(gap) + right.map((s) => s.painted).join(muted(sep)) : "");
  }
  return truncateWidth(lead + info.model, room, g.ellipsis);
}

/**
 * 输入框：上横线 + "› " 行（留空给 readline）+ 下横线 + 状态栏。
 * reserveRight > 0 时横线与状态栏让出右侧几列（给小伙伴坐）。
 */
export function renderInputFrame(
  status: StatusInfo,
  opts: RenderOpts & { reserveRight?: number },
): { above: string[]; prompt: string; below: string[] } {
  const level = levelOf(opts);
  const g = glyphsFor(opts.unicode ?? true);
  const w = Math.max(1, opts.width - (opts.reserveRight ?? 0));
  const rule = renderRule(w, { ...opts, level });
  return {
    above: [rule],
    prompt: paintRaw(g.prompt, level, { fg: BRAND.sage, bold: true }) + " ",
    below: [rule, renderStatusBar(status, { ...opts, level, width: w })],
  };
}

/** 提交后输入占了几行（"› " + 文本，按终端宽度折行）。 */
export function inputRows(answer: string, width: number): number {
  const cols = Math.max(1, width);
  return Math.max(1, Math.ceil((2 + textWidth(answer)) / cols) || 1);
}

/** 提交后的回显：暗色 "› 文本"。 */
export function renderEcho(line: string, opts: { color?: boolean; level?: ColorLevel; unicode?: boolean }): string {
  const level = levelOf(opts);
  const g = glyphsFor(opts.unicode ?? true);
  return paintRaw(g.prompt, level, { fg: BRAND.sage }) + " " + paintRaw(line, level, { fg: BRAND.muted });
}

/** 助手回复：主色 ● 开头，后续行缩进 2 列对齐。 */
export function renderReply(text: string, opts: { color?: boolean; level?: ColorLevel; unicode?: boolean }): string {
  const level = levelOf(opts);
  const mark = (opts.unicode ?? true) ? "●" : "*";
  const lines = text.replace(/\n+$/, "").split("\n");
  return lines.map((l, i) => (i === 0 ? paintRaw(mark, level, { fg: BRAND.sage, bold: true }) + " " : "  ") + l).join("\n");
}

/** 成功提示：绿色 ✓。 */
export function renderOk(text: string, opts: { color?: boolean; level?: ColorLevel; unicode?: boolean }): string {
  const level = levelOf(opts);
  return paintRaw((opts.unicode ?? true) ? "✓" : "+", level, { fg: BRAND.success, bold: true }) + " " + text;
}

/** 错误提示：红色 ✗ + 红字。 */
export function renderError(text: string, opts: { color?: boolean; level?: ColorLevel; unicode?: boolean }): string {
  const level = levelOf(opts);
  return paintRaw(((opts.unicode ?? true) ? "✗" : "x") + " " + text, level, { fg: BRAND.danger });
}
