// src/webuiMobile.ts — 手机 PWA（/m）：配对、对话列表 + 总指挥入口、会话、审批抽屉、待你决定、自动化、设置（技能收在设置里）、
// 总指挥方案卡、群聊页。
//
// 视觉按设计稿 nyra-design v14 / v14.1（docs/mobile-pwa.md 有说明）：只有深色——地面 #1a1a1a 与开机动画同色，
// 表面分 #212123 / #28282b / #323236 三级台阶 + 1px 细边 + 顶部微高光；紫色只用在“你要做决定”的地方；
// 不同 agent 用不同颜色、不同形状的丸子（src/mascots.ts），总指挥是唯一浅色带天线的那只。
// 样式与前端脚本分别放在 src/assets/mobile-app.css.txt / mobile-app.js.txt；入场动画是方块头转眼球
// （src/assets/mobile-splash.js.txt，设计源 docs/design/splash/splash.js，v0.5.8 原样不改）。界面文案在 src/i18n.ts 的 m.* 键（中英）。
// 页面本身不含任何秘密：设备 token 只在 localStorage，每次 API 调用带 X-Nyra-Token 头。
// 主屏幕 / 浏览器图标是应用图标（紫色团子方块，几何在 src/appIcon.ts）在本机光栅化的 PNG；
// 页面里内联的品牌标志是同一枚方块头（src/brandMark.ts）。
import { icoFromPngs, inlineMarkSvg } from "./brandMark.ts";
import { appIconPng, appIconSvg, rasterizeAppIcon, type IconShape } from "./appIcon.ts";
import { MESSAGES, type Lang } from "./i18n.ts";
import { MASCOT_COMPOSE_JS, mascotClientData, mascotSvg } from "./mascots.ts";
import APP_CSS from "./assets/mobile-app.css.txt" with { type: "text" };
import APP_JS from "./assets/mobile-app.js.txt" with { type: "text" };
import SPLASH_JS from "./assets/mobile-splash.js.txt" with { type: "text" };
import INTER_400 from "./assets/mobile-fonts/inter-400.woff.b64.txt" with { type: "text" };
import INTER_600 from "./assets/mobile-fonts/inter-600.woff.b64.txt" with { type: "text" };
import JBM_400 from "./assets/mobile-fonts/jbm-400.woff.b64.txt" with { type: "text" };

// ---------------------------------------------------------------- 颜色 ---
/** 设计稿令牌（nyra-design v14）：只有深色。地面 = 开机动画底色 #1a1a1a（系统启动屏、启动器页、应用页同色，不跳白）。 */
export const MOBILE_COLORS = {
  ground: "#1a1a1a", s1: "#212123", s2: "#28282b", s3: "#323236", inset: "#161618",
  fg: "#EEEEF0", muted: "#ABABB2", faint: "#8E8E96",
  brand: "#8688ff", wait: "#E9B10E", ok: "#3FB950", bad: "#F85149",
  splashBg: "#1a1a1a",
  splashFg: "#F5F5F7",
};
/** 字号只有五档（设计稿 v14.1 收敛）：页面标题 / 抽屉与卡片标题 / 正文 / 次要 / 注释与标签。 */
export const MOBILE_TYPE_SCALE = [20, 17, 14, 12.5, 11.5] as const;

// ---------------------------------------------------------------- 图标 ---
// 品牌标志（方块头）的几何与光栅化都在 src/brandMark.ts；这里只选用途。
export { MARK_TILE, MARK_EYE_GEOM, markEyes, rgbaPng } from "./brandMark.ts";

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

/** 内联进页面的品牌标志（彩色方块头）。 */
export const MARK_INLINE = inlineMarkSvg("brand-mark");

export const MOBILE_V2_MANIFEST = {
  name: "Nyra",
  short_name: "Nyra",
  description: "Nyra — 跑在你电脑上的 AI Agent（手机端）",
  start_url: "/m",
  scope: "/m",
  display: "standalone",
  orientation: "portrait",
  // 系统启动屏与入场动画同为 #1a1a1a 深底，之后淡入应用。
  background_color: MOBILE_COLORS.splashBg,
  theme_color: MOBILE_COLORS.ground,
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
// 单色线性图标（设计稿 v14 同一套），内联 SVG，不依赖手机字体。
const SVG = (body: string, cls = "i") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const P: Record<string, string> = {
  chat: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"/>',
  inbox: '<path d="M4 13.5l2.2-7.2A1.5 1.5 0 0 1 7.6 5.3h8.8a1.5 1.5 0 0 1 1.4 1l2.2 7.2V18a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18z"/><path d="M4 13.5h4.5l1 2h5l1-2H20"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  gear: '<path d="M10.4 3.5h3.2l.5 2.4 1.6.9 2.3-.8 1.6 2.8-1.8 1.6v1.8l1.8 1.6-1.6 2.8-2.3-.8-1.6.9-.5 2.4h-3.2l-.5-2.4-1.6-.9-2.3.8-1.6-2.8 1.8-1.6v-1.8L4.4 8.8 6 6l2.3.8 1.6-.9z"/><circle cx="12" cy="12" r="2.8"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20 20"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  back: '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
  more: '<circle cx="12" cy="5.5" r="1.4" class="f"/><circle cx="12" cy="12" r="1.4" class="f"/><circle cx="12" cy="18.5" r="1.4" class="f"/>',
  moreh: '<circle cx="5.5" cy="12" r="1.4" class="f"/><circle cx="12" cy="12" r="1.4" class="f"/><circle cx="18.5" cy="12" r="1.4" class="f"/>',
  up: '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  chevd: '<path d="M6 9l6 6 6-6"/>',
  chip: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  cloud: '<path d="M7 18.5h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 9.5a4.5 4.5 0 0 0 0 9z"/>',
  laptop: '<rect x="4.5" y="5" width="15" height="10.5" rx="1.5"/><path d="M2.5 19h19"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
  wifioff: '<path d="M3 3l18 18"/><path d="M8.6 15.5a5 5 0 0 1 6.8 0"/><path d="M5.5 12.3a9.5 9.5 0 0 1 4-2.2"/><path d="M2.5 9a14 14 0 0 1 5-3"/><path d="M14.5 10.2a9.5 9.5 0 0 1 4 2.1M12.5 5a14 14 0 0 1 9 4"/><circle cx="12" cy="18.6" r="1" class="f"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
  file: '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4"/>',
  term: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15H17"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8.5-8.5M16 6l2.5 2.5M14 8l2 2"/>',
  logout: '<path d="M14 4.5H6.5a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5H14"/><path d="M10 12h10M16.5 8.5 20 12l-3.5 3.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.3" r=".9" class="f"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  fork: '<circle cx="7" cy="5.5" r="2"/><circle cx="17" cy="5.5" r="2"/><circle cx="12" cy="18.5" r="2"/><path d="M7 7.5v2a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3v-2M12 12.5v4"/>',
  edit2: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
  skills: '<path d="M12 3.5l3 3-3 3-3-3zM6.5 9l3 3-3 3-3-3zM17.5 9l3 3-3 3-3-3zM12 14.5l3 3-3 3-3-3z"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="16.5" cy="9.5" r="2.6"/><path d="M15.5 14.2a4.6 4.6 0 0 1 5 4.8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  at: '<circle cx="12" cy="12" r="3.6"/><path d="M15.6 12v1.3a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.4 6.9"/>',
};
const IC: Record<string, string> = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, SVG(v)]));
IC.mark = MARK_INLINE;
const NAV = ([["threads", "chat"], ["inbox", "inbox"], ["automations", "clock"], ["settings", "gear"]] as const)
  .map(([k, icon]) => `<button data-tab="${k}"><span class="pill">${IC[icon]}<span class="badge hidden" data-badge="${k}"></span></span><span data-i="m.tab.${k}"></span></button>`).join("");
// 丸子：嵌入每只的拼装件（前端用与服务端同一段 composeMascot 拼）；老的头像模板 id 保留，内容换成丸子。
const MASCOT_JSON = JSON.stringify(mascotClientData()).replace(/</g, "\\u003c");
const AVATARS = `<template id="av-idle-m">${mascotSvg("nyra", "idle", 40, { id: "tplidle" })}</template><template id="av-wait-s">${mascotSvg("nyra", "wait", 18, { id: "tplwait" })}</template>`;
const conn = (id: string) => `<span class="tap conn-slot" id="${id}"></span>`;
const head = (titleKey: string, extra = "", connId = "") => `<div class="head"><h1 data-i="${titleKey}"></h1>${connId ? conn(connId) : ""}${extra}</div>`;

export const MOBILE_V2_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${MOBILE_COLORS.ground}">
<meta name="color-scheme" content="dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Nyra">
<title>Nyra</title>
<link rel="manifest" href="/m/manifest.json">
<link rel="icon" type="image/svg+xml" href="/m/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/m/favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/m/apple-touch-icon.png">
<style>${APP_CSS}</style></head><body>
<template id="tpl-mark">${IC.mark}</template>${AVATARS}
<div id="splash" class="hidden" aria-hidden="true"></div>
<p id="fatal" class="err"></p>
<section id="pair-view" class="view hidden"><div class="pair">
<div class="mark-wrap">${IC.mark}</div>
<h1 id="pair-title" data-i="m.pair.title"></h1>
<div id="pair-lost" class="banner bad hidden" style="margin:16px 0 0">${IC.alert}<div><b data-i="m.pair.lostTitle"></b><small data-i="m.pair.lostBody"></small></div></div>
<p class="lead" data-ir="m.pair.body"></p>
<label class="code6" id="pair-boxes" style="margin-top:18px"><i></i><i></i><i></i><i></i><i></i><i></i><input id="pair-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" data-ia="m.pair.code"></label>
<p class="note" style="padding:12px 2px 0" data-i="m.pair.codeNote"></p>
<p id="pair-error" class="err" style="margin-top:8px"></p>
<span class="sp"></span>
<button id="pair-btn" class="btn pri full" style="height:52px;margin-bottom:8px" data-i="m.pair.btn"></button>
<button id="pair-cloud" class="btn ghost full" style="height:48px">${IC.cloud}<span data-i="m.pair.useAccount"></span><span class="tag soon" data-i="m.soon"></span></button>
<p data-i="m.pair.foot" class="note" style="padding:10px 2px 0"></p>
</div></section>
<section id="threads-view" class="view tabview hidden">
${head("m.tab.threads", `<button id="search-btn" class="ib" data-ia="m.search">${IC.search}</button>`, "conn-threads")}
<div id="search-row" class="search hidden"><input id="search" type="search" data-ip="m.searchPlaceholder"></div>
<div id="offline" class="hidden"></div>
<div id="chief-card" class="chief"></div>
<div id="threads"></div>
</section>
<button id="fab" class="fab hidden">${IC.pencil}<span data-i="m.newThread"></span></button>
<section id="chat-view" class="view hidden">
<div class="cbar" id="chat-bar"><button id="back" class="ib" data-ia="m.back">${IC.back}</button><span id="chat-av" class="mcw" style="width:30px;height:30px"></span><div class="ttl"><b id="chat-title"></b><small id="chat-sub"></small></div><button id="kebab" class="ib" data-ia="m.more">${IC.more}</button></div>
<div id="feed" class="feed"></div>
<div class="composer"><div id="chat-status" class="cstat"></div><div class="field"><textarea id="input" rows="1" data-ip="m.followUp"></textarea><button id="send-btn" class="go" data-ia="m.send"><i>${IC.up}</i></button></div><div class="cpills" id="cpills"></div></div>
</section>
<section id="inbox-view" class="view tabview hidden">
${head("m.tab.inbox", "", "conn-inbox")}
<div id="reviews"></div>
</section>
<section id="automations-view" class="view tabview hidden">
${head("m.tab.automations", "", "conn-autos")}
<div id="autos"></div>
</section>
<section id="settings-view" class="view tabview hidden">
${head("m.tab.settings", "", "conn-settings")}
<div class="sec" style="padding-top:6px" data-i="m.set.mode"></div>
<div class="seg modes" id="modes"></div><div id="mode-confirm"></div>
<p class="note" id="mode-help"></p>
<div class="sec" data-i="m.set.rules"></div>
<div class="grp" id="rules"></div>
<p class="note" data-i="m.set.rulesHelp"></p>
<div class="sec" data-i="m.set.modelSkills"></div>
<div class="grp">
<div class="r2"><span class="tile">${IC.chip}</span><div class="k"><span data-i="m.set.model"></span><small id="provider-line"></small></div></div>
<div class="r2"><span class="tile">${IC.key}</span><div class="k"><span data-i="m.set.key"></span><small data-i="m.set.keyBody"></small></div></div>
<button class="r2" id="open-skills"><span class="tile">${IC.skills}</span><div class="k"><span data-i="m.set.skills"></span><small id="skills-line" data-i="m.set.skillsBody"></small></div><span style="color:var(--t3)">${IC.chev}</span></button>
</div>
<div class="sec" data-i="m.set.conn"></div>
<div class="grp">
<div class="r2"><span class="tile">${IC.laptop}</span><div class="k"><span data-i="m.conn.home"></span><small class="mono" id="conn-host"></small></div><span id="conn-tag" class="tag ok" data-i="m.conn.connected"></span></div>
<button class="r2" id="cloud-row"><span class="tile">${IC.cloud}</span><div class="k"><span data-i="m.set.cloud"></span><small data-i="m.set.cloudBody"></small></div><span class="tag soon" data-i="m.soon"></span></button>
</div>
<p class="note" data-i="m.set.cloudNote"></p>
<div class="sec" data-i="m.set.device"></div>
<div class="grp">
<div class="r2"><span class="tile">${IC.phone}</span><div class="k"><span data-i="m.set.paired"></span><small data-i="m.set.pairedBody"></small></div></div>
<button class="r2" id="disconnect" style="color:var(--bad-t)"><span class="tile badb">${IC.logout}</span><span class="k" style="color:var(--bad-t);font-weight:600" data-i="m.set.disconnect"></span></button>
</div>
<p class="note" data-i="m.set.deviceHelp"></p>
<div class="sec" data-i="m.set.about"></div>
<div class="grp"><div class="r2 nolead"><div class="k" data-i="m.set.versionLabel"></div><span class="v" id="version-line"></span></div></div>
<div style="height:24px"></div>
</section>
<section id="skills-view" class="view hidden">
<div class="cbar"><button class="ib back-settings" data-ia="m.back">${IC.back}</button><div class="ttl"><b data-i="m.set.skills"></b><small id="skills-sub"></small></div></div>
<div id="skill-list" style="padding-bottom:32px"></div>
</section>
<section id="chief-view" class="view hidden">
<div class="cbar"><button class="ib back-home" data-ia="m.back">${IC.back}</button><span class="mcw" id="chief-av" style="width:30px;height:30px"></span><div class="ttl"><b data-i="m.chief.name"></b><small data-i="m.chief.sub"></small></div></div>
<div id="chief-feed" class="feed"></div>
<div class="composer"><div class="field"><textarea id="chief-input" rows="1" data-ip="m.chief.reply"></textarea><button id="chief-send" class="go" data-ia="m.send"><i>${IC.up}</i></button></div></div>
</section>
<section id="group-view" class="view hidden">
<div class="cbar" id="group-bar"><button class="ib back-home" data-ia="m.back">${IC.back}</button><span class="stack" id="group-stack"></span><div class="ttl"><b id="group-title"></b><small id="group-sub"></small></div></div>
<div id="group-prog" class="prog hidden"></div>
<div id="group-feed" class="feed" style="padding-top:12px"></div>
<div class="composer"><div id="group-status" class="cstat"></div><div class="atrow" id="group-at"></div><div class="field"><textarea id="group-input" rows="1" data-ip="m.group.placeholder"></textarea><button id="group-send" class="go" data-ia="m.send"><i>${IC.up}</i></button></div></div>
</section>
<div id="dim" class="dim hidden"></div>
<div id="sheet" class="sheet hidden" role="dialog" aria-modal="true"></div>
<nav id="nav" class="nav hidden">${NAV}</nav>
${Object.entries(IC).map(([k, v]) => `<template id="ic-${k}">${v}</template>`).join("")}
<script>window.NYRA_I18N=${I18N_JSON};window.NYRA_MASCOTS=${MASCOT_JSON};</script>
<script>${MASCOT_COMPOSE_JS}</script>
<script>${SPLASH_JS}</script>
<script>${APP_JS}</script>
</body></html>`;
