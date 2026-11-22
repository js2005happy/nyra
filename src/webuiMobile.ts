// src/webuiMobile.ts — 手机 PWA（/m）：配对、对话列表、对话、Codex 式审批弹层、自动化、技能、设置。
//
// 视觉严格按设计稿 docs/assets/screenshots/android.png / ios.png（nyra-design v2：mobile.py + kit.py）：
// 浅色默认、黑白单色（白底、黑色主按钮、灰色次要文字、Inter / JetBrains Mono），
// prefers-color-scheme: dark 时用设计稿的 DARK 令牌。样式与前端脚本分别放在
// src/assets/mobile-app.css.txt / mobile-app.js.txt；入场动画移植自原 Nyra splash
// （src/assets/mobile-splash.js.txt）。界面文案在 src/i18n.ts 的 m.* 键（中英）。
// 页面本身不含任何秘密：设备 token 只在 localStorage，每次 API 调用带 X-Nyra-Token 头。
// 主屏幕 / 浏览器图标是应用图标（紫色团子方块，几何在 src/appIcon.ts）在本机光栅化的 PNG；
// 页面里内联的标志仍是圆盘 + 光标（src/brandMark.ts）。
import { icoFromPngs, inlineMarkSvg } from "./brandMark.ts";
import { appIconPng, appIconSvg, rasterizeAppIcon, type IconShape } from "./appIcon.ts";
import { MESSAGES, type Lang } from "./i18n.ts";
import { NYRA_AVATAR } from "./nyraAvatar.ts";
import APP_CSS from "./assets/mobile-app.css.txt" with { type: "text" };
import APP_JS from "./assets/mobile-app.js.txt" with { type: "text" };
import SPLASH_JS from "./assets/mobile-splash.js.txt" with { type: "text" };
import INTER_400 from "./assets/mobile-fonts/inter-400.woff.b64.txt" with { type: "text" };
import INTER_600 from "./assets/mobile-fonts/inter-600.woff.b64.txt" with { type: "text" };
import JBM_400 from "./assets/mobile-fonts/jbm-400.woff.b64.txt" with { type: "text" };

// ---------------------------------------------------------------- 颜色 ---
/** 设计稿令牌（nyra-design v2 kit.py LIGHT / DARK）。图标与入场动画用原 splash 的黑底 / 浅色前景。 */
export const MOBILE_COLORS = {
  light: { bg: "#FFFFFF", fg: "#0D0D0D", muted: "#6E6E73", chip: "#F2F2F3", line: "#ECECEE" },
  dark: { bg: "#0B0B0C", fg: "#EDEDED", muted: "#8E8E93", chip: "#1C1C1E", line: "#232325" },
  splashBg: "#0B0B0C",
  splashFg: "#F5F5F7",
  mark: "#0B0B0C",
};

// ---------------------------------------------------------------- 图标 ---
// 正式标志（圆盘 + 光标，入场动画终帧）的几何与光栅化都在 src/brandMark.ts；这里只选用途。
// 旧名字照旧导出，调用方与测试不用改。
export { MARK_CIRCLE, MARK_CURSOR, MARK_STROKE, MARK_ROTATE_DEG, rgbaPng } from "./brandMark.ts";

type IconKind = "any" | "maskable" | "apple" | "favicon";

function shapeFor(kind: IconKind): IconShape {
  // maskable / apple：满版不透明方形，系统自己加遮罩（两只眼都在 maskable 80% 安全圆内）；
  // any / favicon：满格圆角方图块，四角透明。
  return kind === "maskable" || kind === "apple" ? "square" : "tile";
}

/** 光栅化 Nyra 应用图标（RGBA）。≤28 px 自动放大眼睛。 */
export function renderMarkRgba(size: number, kind: IconKind): Uint8Array {
  return rasterizeAppIcon(size, shapeFor(kind));
}

const iconCache = new Map<string, Buffer>();
export function mobileIconPng(size: number, kind: IconKind): Buffer {
  const key = `${kind}:${size}`;
  let png = iconCache.get(key);
  if (!png) {
    png = appIconPng(size, shapeFor(kind));
    iconCache.set(key, png);
  }
  return png;
}

/** 路由 → 图标：manifest 的 any/maskable、apple-touch-icon 180、favicon。 */
export const MOBILE_ICON_ROUTES: Record<string, { size: number; kind: IconKind }> = {
  "/m/icon-192.png": { size: 192, kind: "any" },
  "/m/icon-512.png": { size: 512, kind: "any" },
  "/m/icon-maskable-192.png": { size: 192, kind: "maskable" },
  "/m/icon-maskable-512.png": { size: 512, kind: "maskable" },
  "/m/apple-touch-icon.png": { size: 180, kind: "apple" },
  "/m/icon-180.png": { size: 180, kind: "apple" },
  "/m/favicon-32.png": { size: 32, kind: "favicon" },
};

/** 真正的多尺寸 favicon.ico（16 / 32 / 48，内嵌 PNG）。 */
let icoCache: Buffer | null = null;
export function mobileFaviconIco(): Buffer {
  if (!icoCache) icoCache = icoFromPngs([16, 32, 48].map((size) => ({ size, png: mobileIconPng(size, "favicon") })));
  return icoCache;
}

/** 矢量 favicon：应用图标的圆角图块版（深色、浅色标签栏上都看得清，不随系统换色）。 */
export function mobileFaviconSvg(): string {
  return appIconSvg("tile");
}

/** 内联进页面的标志（圆盘 = currentColor，光标镂空）。 */
export const MARK_INLINE = inlineMarkSvg("brand-mark");

export const MOBILE_V2_MANIFEST = {
  name: "Nyra",
  short_name: "Nyra",
  description: "Nyra — 跑在你电脑上的 AI Agent（手机端）",
  start_url: "/m",
  scope: "/m",
  display: "standalone",
  orientation: "portrait",
  // 系统启动屏与入场动画同为黑底，之后淡入浅色应用。
  background_color: MOBILE_COLORS.splashBg,
  theme_color: MOBILE_COLORS.light.bg,
  icons: [
    { src: "/m/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/m/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/m/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
    { src: "/m/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

// ---------------------------------------------------------------- 字体 ---
// Inter 400/600 与 JetBrains Mono 400 的 WOFF（docs/assets/fonts，SIL OFL 1.1），以 base64 文本随包。
// 页面用同源 fetch + FontFace(ArrayBuffer) 加载，CSP 不加 font-src；字体文件不含秘密，无需 token。
const FONT_SOURCES: Record<string, string> = { "inter-400": INTER_400, "inter-600": INTER_600, "jbm-400": JBM_400 };
const fontCache = new Map<string, Buffer>();
export const MOBILE_FONT_ROUTE = /^\/m\/fonts\/(inter-400|inter-600|jbm-400)\.woff$/;
export function mobileFont(name: string): Buffer | null {
  const src = FONT_SOURCES[name];
  if (!src) return null;
  let buf = fontCache.get(name);
  if (!buf) { buf = Buffer.from(src.trim(), "base64"); fontCache.set(name, buf); }
  return buf;
}

// ---------------------------------------------------------------- 文案 ---
/** 只把手机用的 m.* 文案（中英）嵌进页面；语言在手机上按 navigator.language 选，认不出回落 en。 */
export function mobileMessages(): Record<Lang, Record<string, string>> {
  const pick = (lang: Lang): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(MESSAGES[lang])) if (k.startsWith("m.")) out[k] = v;
    return out;
  };
  return { zh: pick("zh"), en: pick("en") };
}
const I18N_JSON = JSON.stringify(mobileMessages()).replace(/</g, "\\u003c");

// ---------------------------------------------------------------- 图标 ---
// 设计稿的单色线性图标（✦ 对话、◷ 自动化、❖ 技能、⚙ 设置、⌕、✎、←、⋮、＋），内联 SVG，不依赖手机字体。
const SVG = (body: string, cls = "i", vb = "0 0 24 24") => `<svg class="${cls}" viewBox="${vb}" aria-hidden="true">${body}</svg>`;
const IC = {
  threads: SVG('<path d="M8 0C9 5 11 7 16 8C11 9 9 11 8 16C7 11 5 9 0 8C5 7 7 5 8 0Z"/>', "i f", "-1 -1 18 18"),
  review: SVG('<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>'),
  automations: SVG('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  skills: SVG('<path d="M8 .6l2.7 2.7L8 6 5.3 3.3z M3.3 5.3 6 8 3.3 10.7.6 8z M12.7 5.3 15.4 8l-2.7 2.7L10 8z M8 10l2.7 2.7L8 15.4l-2.7-2.7z"/>', "i f", "-1 -1 18 18"),
  settings: SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  search: SVG('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20 20"/>'),
  pencil: SVG('<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>'),
  back: SVG('<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>', "i and-only") + SVG('<path d="M15 5l-7 7 7 7"/>', "i ios-only"),
  more: SVG('<circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/>', "i f"),
  plus: SVG('<path d="M12 5v14M5 12h14"/>'),
  up: SVG('<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>'),
  // 设计稿 v8 m-16：输入框下的模型 / 审批模式胶囊
  chip: SVG('<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5"/>'),
  shield: SVG('<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"/>'),
  mark: MARK_INLINE,
};
// Nyra 团子头像（v6.2 原样）：新对话空状态、等你确认队列。
const AVATARS = (["idle-m", "wait-s"] as const).map((k) => `<template id="av-${k}">${NYRA_AVATAR[k]}</template>`).join("");
const NAV = (["threads", "review", "automations", "skills", "settings"] as const)
  .map((k) => `<button data-tab="${k}"><i>${IC[k]}</i><span data-i="m.tab.${k}"></span></button>`).join("");

export const MOBILE_V2_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="${MOBILE_COLORS.light.bg}">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${MOBILE_COLORS.dark.bg}">
<meta name="color-scheme" content="light dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Nyra">
<title>Nyra</title>
<link rel="manifest" href="/m/manifest.json">
<link rel="icon" type="image/svg+xml" href="/m/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/m/favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/m/apple-touch-icon.png">
<style>${APP_CSS}
.ios .and-only,.android .ios-only{display:none}</style></head><body>
<template id="tpl-mark">${IC.mark}</template>${AVATARS}
<div id="splash" class="hidden" aria-hidden="true"></div>
<p id="fatal" class="err"></p>
<section id="pair-view" class="view hidden"><div class="pair">
<div class="mk">${IC.mark}</div>
<h1 data-i="m.pair.title"></h1>
<p data-i="m.pair.body"></p>
<input id="pair-code" class="codein" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="······" data-ia="m.pair.code">
<button id="pair-btn" class="bt p full" data-i="m.pair.btn"></button>
<p id="pair-error" class="err"></p>
<p data-i="m.pair.foot"></p>
</div></section>
<section id="threads-view" class="view tabview hidden">
<div class="lt"><h1 data-i="m.tab.threads"></h1><button id="search-btn" class="ib" data-ia="m.search">${IC.search}</button></div>
<div id="search-row" class="search hidden"><input id="search" type="search" data-ip="m.searchPlaceholder"></div>
<div id="threads"></div>
</section>
<button id="fab" class="fab hidden">${IC.pencil}<span data-i="m.newThread"></span></button>
<section id="chat-view" class="view hidden">
<div class="hd"><button id="back" class="ib" data-ia="m.back">${IC.back}</button><div class="tt"><b id="chat-title"></b><small id="chat-sub"></small></div><button id="kebab" class="ib" data-ia="m.more">${IC.more}</button></div>
<div id="menu" class="menu hidden"><button id="menu-new">${IC.pencil}<span data-i="m.newThread"></span></button><button id="menu-settings">${IC.settings}<span data-i="m.tab.settings"></span></button></div>
<div id="feed" class="feed"></div>
<div class="composer"><p id="chat-status" class="cstatus"></p><div class="pill"><textarea id="input" rows="1" data-ip="m.followUp"></textarea><button id="send-btn" class="go" data-ia="m.send">${IC.up}</button></div><div class="cpills" id="cpills"></div></div>
<div id="dim" class="dim hidden"></div>
<div id="sheet" class="sheet hidden" role="dialog" aria-modal="true"></div>
</section>
<section id="review-view" class="view tabview hidden">
<div class="lt"><h1 data-i="m.tab.review"></h1></div>
<div id="reviews"></div>
</section>
<section id="automations-view" class="view tabview hidden">
<div class="lt"><h1 data-i="m.tab.automations"></h1><button id="auto-add" class="ib" data-ia="m.auto.addHint">${IC.plus}</button></div>
<div id="autos"></div>
</section>
<section id="skills-view" class="view tabview hidden">
<div class="lt"><h1 data-i="m.tab.skills"></h1></div>
<div id="skill-list"></div>
</section>
<section id="settings-view" class="view tabview hidden">
<div class="lt"><h1 data-i="m.tab.settings"></h1></div>
<div class="lh" data-i="m.set.mode"></div>
<div class="seg modes" id="modes" style="margin:4px 16px 0"></div><div id="mode-confirm"></div>
<p class="help" id="mode-help" data-i="m.set.modeHelp"></p>
<div class="lh" data-i="m.set.rules"></div>
<div class="grp" id="rules"></div>
<p class="help" data-i="m.set.rulesHelp"></p>
<div class="lh" data-i="m.set.model"></div>
<div class="grp"><div class="row"><span class="tx" id="provider-line"></span></div><div class="row"><div class="tx"><span data-i="m.set.key"></span><small data-i="m.set.keyBody"></small></div></div></div>
<div class="lh" data-i="m.set.device"></div>
<div class="grp"><button id="disconnect" class="textbtn" data-i="m.set.disconnect"></button></div>
<p class="help" data-i="m.set.deviceHelp"></p>
<p class="help" id="version-line" style="padding-bottom:16px"></p>
</section>
<nav id="nav" class="nav hidden">${NAV}</nav>
${Object.entries(IC).map(([k, v]) => `<template id="ic-${k}">${v}</template>`).join("")}
<script>window.NYRA_I18N=${I18N_JSON};</script>
<script>${SPLASH_JS}</script>
<script>${APP_JS}</script>
</body></html>`;
