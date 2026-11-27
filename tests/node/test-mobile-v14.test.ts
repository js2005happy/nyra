// tests/node/test-mobile-v14.test.ts — 手机端 v14 / v14.1 落地：丸子（不画笑眼）、页面结构（四个标签、总指挥、群聊页、
// 无原生对话框、无死按钮）、地面色与开机动画衔接、五档字号、启动器页（品牌、即将推出、无旧光标与金色）、文案只写 Nyra。
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MASCOTS, CHIEF_MASCOT, MASCOT_KEYS, MASCOT_STATES, MASCOT_COMPOSE_JS, mascotSvg, mascotClientData, mascotPiece,
  mascotKeyFor, assignMascots, hasSmileEyes, MASCOT_BADGE,
} from "../../src/mascots.ts";
import { NYRA_AVATAR } from "../../src/nyraAvatar.ts";
import { MOBILE_V2_HTML, MOBILE_V2_MANIFEST, MOBILE_COLORS, MOBILE_TYPE_SCALE, mobileMessages } from "../../src/webuiMobile.ts";
import { DESKTOP_HTML } from "../../src/webuiDesktop.ts";
import { SPLASH_BG } from "../../src/brandMark.ts";
import { buildLauncherHtml } from "../../mobile/scripts/make-assets.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");
// 老的“^^ 弯眼”画法：眼睛色描边的二次曲线（M x y Q cx cy x y，fill none）。
const OLD_SMILE = /<path d=\\?"M[\d. -]+Q[\d. -]+\\?" fill=\\?"none\\?" stroke=\\?"#141414/;

test("丸子：8 个成员 + 1 个总指挥，颜色和形状两两不同；总指挥是唯一浅色带天线的；没有“紫色圆角方”（那是品牌）", () => {
  expect(MASCOTS.length).toBe(8);
  expect(MASCOT_KEYS).toEqual([...MASCOTS.map((m) => m.key), "chief"]);
  const all = [...MASCOTS, CHIEF_MASCOT];
  expect(new Set(all.map((m) => m.color.toLowerCase())).size).toBe(9);
  expect(new Set(all.map((m) => m.shape)).size).toBe(9);
  const light = all.filter((m) => parseInt(m.color.slice(1, 3), 16) > 0xd0 && parseInt(m.color.slice(3, 5), 16) > 0xd0);
  expect(light.map((m) => m.key)).toEqual(["chief"]);
  expect(mascotSvg("chief", "idle", 40)).toContain('<circle cx="50" cy="9" r="7.5" fill="#8688ff"/>');
  for (const m of MASCOTS) if (m.color.toLowerCase() === "#8688ff") expect(m.shape).not.toBe("squircle");
  for (const m of MASCOTS) expect(mascotSvg(m.key, "idle", 40)).not.toContain("antenna");
});

test("丸子不画笑眼：所有丸子 × 所有状态 × 两档尺寸，眼睛只用竖胶囊 / 横条 / 圆点；完成态 = 竖眼 + 绿色对勾角标", () => {
  for (const key of MASCOT_KEYS) {
    for (const st of MASCOT_STATES) {
      for (const size of [18, 40, 96]) {
        const svg = mascotSvg(key, st, size, { id: "t" });
        expect(hasSmileEyes(svg)).toBe(false);
        expect(svg).not.toMatch(OLD_SMILE);
      }
    }
    const idle = mascotPiece(key).eyes.idle, done = mascotPiece(key).eyes.done;
    expect(done).toEqual(idle);
    expect(mascotSvg(key, "done", 40)).toContain('fill="#3FB950"');
    expect(mascotSvg(key, "idle", 40)).not.toContain("mc-done");
  }
  // 角标的对勾是折线（L），不是曲线
  for (const b of Object.values(MASCOT_BADGE)) expect(b).toMatch(/<path d="M[\d. ]+L[\d. ]+L[\d. ]+" fill="none" stroke="#fff"/);
  // 检测器本身认得出老画法、不误伤问号
  expect(hasSmileEyes('<svg><path d="M28 56.5Q36 42.5 44 56.5" fill="none" stroke="#141414" stroke-width="7"/></svg>')).toBe(true);
  expect(hasSmileEyes(mascotSvg("nyra", "wait", 40))).toBe(false);
  expect(mascotSvg("nyra", "wait", 40)).toContain("M-5.5 -4.5A");
});

test("代码里不出现笑眼画法：网页、手机页、启动器页、官网、头像源、bot 头像图都没有", () => {
  for (const svg of Object.values(NYRA_AVATAR)) { expect(hasSmileEyes(svg)).toBe(false); expect(svg).not.toMatch(OLD_SMILE); }
  expect(NYRA_AVATAR["done-m"]).toContain('fill="#3FB950"');
  const sources: [string, string][] = [
    ["MOBILE_V2_HTML", MOBILE_V2_HTML], ["DESKTOP_HTML", DESKTOP_HTML],
    ["mobile/www/index.html", read("mobile/www/index.html")], ["docs/index.html", read("docs/index.html")],
    ["src/nyraAvatar.ts", read("src/nyraAvatar.ts")], ["src/mascots.ts", read("src/mascots.ts")],
  ];
  for (const [name, src] of sources) {
    expect({ name, smile: OLD_SMILE.test(src) }).toEqual({ name, smile: false });
    expect({ name, smile: hasSmileEyes(src) }).toEqual({ name, smile: false });
  }
  // 开机动画结尾也不弯成笑眼（设计源与运行时都没有 smile 函数）
  expect(MOBILE_V2_HTML).not.toContain("function smile(");
});

test("丸子前端拼装与服务端同一段源码：页面内联的 composeMascot + 数据拼出来与 mascotSvg 逐字一致", () => {
  expect(MOBILE_V2_HTML).toContain(MASCOT_COMPOSE_JS);
  const m = /window\.NYRA_MASCOTS=(\{.*?\});<\/script>/.exec(MOBILE_V2_HTML);
  expect(m).not.toBeNull();
  const data = JSON.parse(m![1].replace(/\\u003c/g, "<")) as ReturnType<typeof mascotClientData>;
  expect(Object.keys(data.pieces)).toEqual(MASCOT_KEYS);
  const compose = new Function(`${MASCOT_COMPOSE_JS}; return composeMascot;`)() as (...a: unknown[]) => string;
  for (const key of MASCOT_KEYS) for (const st of MASCOT_STATES) for (const [px, cls] of [[18, "s"], [40, "m"]] as const) {
    const label = data.names[key];
    expect(compose(data.pieces[key], key, st, cls, "9", label, false, data.badge)).toBe(mascotSvg(key, st, px, { id: "9" }));
  }
});

test("不同 agent 用不同丸子：默认助手是 Nyra、chief 是总指挥、同名永远同一只；一个群里不重复", () => {
  expect(mascotKeyFor("default")).toBe("nyra");
  expect(mascotKeyFor(null)).toBe("nyra");
  expect(mascotKeyFor("x", "chief")).toBe("chief");
  expect(mascotKeyFor("tester")).toBe("tester");
  expect(mascotKeyFor("member-a")).toBe(mascotKeyFor("member-a"));
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  const keys = assignMascots(ids);
  expect(new Set(Object.values(keys)).size).toBe(ids.length);
});

test("页面：底栏 6 个（对话 / 待你决定 / 探索 / 自动化 / 我的 / 设置），技能收进设置；总指挥入口、方案卡、群聊页都在", () => {
  const tabs = [...MOBILE_V2_HTML.matchAll(/<button data-tab="(\w+)">/g)].map((x) => x[1]);
  expect(tabs).toEqual(["threads", "inbox", "explore", "automations", "profile", "settings"]);
  expect(MOBILE_V2_HTML).toContain('id="open-skills"');
  expect(MOBILE_V2_HTML).toContain('id="skills-view"');
  // Cue B 批：探索页与个人页、Bot Mode 开关都在。
  for (const id of ["explore-view", "explore-list", "profile-view", "profile-body", "invite-box", "botmode-row", "botmode-switch", "botmode-state"]) {
    expect(MOBILE_V2_HTML).toContain(`id="${id}"`);
  }
  for (const fn of ["function loadExplore(", "function loadProfile(", "function loadInvites(", "function loadBotMode(", "function toggleBotMode(", "function runTemplate("]) {
    expect(MOBILE_V2_HTML).toContain(fn);
  }
  for (const id of ["chief-card", "chief-view", "chief-feed", "group-view", "group-prog", "group-feed", "group-at", "group-input", "pair-lost", "offline"]) {
    expect(MOBILE_V2_HTML).toContain(`id="${id}"`);
  }
  for (const api of ["/api/chief/proposals", "/api/chief/groups", "/api/groups/", "/view", "async: true", "/api/chief"]) expect(MOBILE_V2_HTML).toContain(api);
  for (const fn of ["function renderChiefCard(", "function renderChief(", "function adjustMembers(", "function createChief(", "function renderGroup(", "function dispatchCard(", "function summaryCard(", "function skeleton(", "function renderOffline(", "function forgetDevice(", "function editSheet("]) {
    expect(MOBILE_V2_HTML).toContain(fn);
  }
  // 自动化页没有死的“＋”按钮
  expect(MOBILE_V2_HTML).not.toContain('id="auto-add"');
});

test("页面不用浏览器原生对话框：没有 prompt( / confirm( / alert(", () => {
  const js = read("src/assets/mobile-app.js.txt");
  for (const re of [/\bprompt\(/, /\bconfirm\(/, /\balert\(/]) {
    expect(js).not.toMatch(re);
    expect(MOBILE_V2_HTML).not.toMatch(re);
  }
});

test("总指挥第 1 阶段：成员权限只显示“只读”，不出现写入前先问 / 完全访问的成员权限，上限 6", () => {
  const js = read("src/assets/mobile-app.js.txt");
  const chief = js.slice(js.indexOf("// ---------------------------------------------------------------- 总指挥 ---"), js.indexOf("// ---------------------------------------------------------------- 群聊 ---"));
  expect(chief).toContain("m.perm.readonly");
  expect(chief).not.toMatch(/m\.mode\.(auto|full)|m\.perm\.(ask|full)/);
  const { zh } = mobileMessages();
  expect(zh["m.perm.readonly"]).toBe("只读");
  expect(zh["m.chief.name"]).toBe("总指挥");
  for (const [k, v] of Object.entries(zh)) if (k.startsWith("m.chief.")) expect(v).not.toMatch(/参谋长/);
});

test("地面色 #1a1a1a 与开机动画衔接（不跳白）：页面、manifest、主题色、启动器页、Capacitor 配置都是同一色", () => {
  expect(MOBILE_COLORS.ground).toBe(SPLASH_BG);
  expect(MOBILE_V2_MANIFEST.background_color).toBe("#1a1a1a");
  expect(MOBILE_V2_MANIFEST.theme_color).toBe("#1a1a1a");
  const css = read("src/assets/mobile-app.css.txt");
  expect(css).toContain("--ground:#1a1a1a");
  expect(css).toMatch(/html\{background:var\(--ground\)\}/);
  expect(css).not.toMatch(/background:#fff\b|background:#FFFFFF/i);
  expect(MOBILE_V2_HTML).toContain('<meta name="theme-color" content="#1a1a1a">');
  expect(MOBILE_V2_HTML).not.toContain("prefers-color-scheme: light");
  expect(read("mobile/capacitor.config.ts")).toContain('backgroundColor: "#1a1a1a"');
  expect(read("mobile/www/index.html")).toContain("--ground:#1a1a1a");
});

test("字号只有五档 20 / 17 / 14 / 12.5 / 11.5；可点元素 ≥ 44", () => {
  expect([...MOBILE_TYPE_SCALE]).toEqual([20, 17, 14, 12.5, 11.5]);
  const css = read("src/assets/mobile-app.css.txt") + read("src/assets/mobile-app.js.txt");
  expect(css).toContain("--f-xl:20px;--f-l:17px;--f-m:14px;--f-s:12.5px;--f-xs:11.5px");
  const literal = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
  expect(literal).toEqual([]);
  const shorthand = [...css.matchAll(/font:[^;}]*?(\d+(?:\.\d+)?)px\//g)].map((m) => Number(m[1]));
  expect(shorthand).toEqual([]);
  // 启动器页：同五档，标语 28 是唯一品牌例外
  const launcher = read("mobile/www/index.src.html");
  const sizes = [...launcher.matchAll(/font(?:-size)?:\s*(?:\d{3}\s+)?([\d.]+)px/g)].map((m) => Number(m[1]));
  for (const s of sizes) expect([20, 17, 14, 12.5, 11.5, 28]).toContain(s);
  expect(sizes.filter((s) => s === 28).length).toBe(1);
  // 触控：按钮、胶囊、底栏、开关
  for (const rule of [".ib{width:44px;height:44px", ".tap{min-width:44px;min-height:44px", ".cp{height:44px", ".tg{width:52px;height:44px", ".atrow button{height:44px", "min-height:56px;justify-content:center}"]) expect(css).toContain(rule);
});

test("启动器页：方块头品牌，不再有旧光标 logo 与金色；标语、Google 主按钮 + GitHub / 邮箱次按钮、即将推出、连家里电脑；与生成脚本同步", () => {
  const html = read("mobile/www/index.html");
  expect(html).toBe(buildLauncherHtml());
  expect(html).not.toMatch(/EAC45F/i);
  expect(html).not.toContain("A40 40 0 1 0"); // 旧圆盘光标
  expect(html).toContain('fill="#8688ff"');
  expect(html).toContain("活交给它，<br>决定留给你。");
  expect(html).toContain("用 Google 继续");
  expect(html).toContain('id="githubBtn"');
  expect(html).toContain('id="emailBtn"');
  expect(html).toContain("即将推出");
  expect(html).toContain("连家里电脑");
  // 账号按钮只开“即将推出”抽屉，不跳任何登录地址（云端登录后端没部署，不编造可用）
  expect(html).not.toContain("/login?provider=");
  expect(html).toContain("openSheet('soonSheet')");
  // 丸子 id 不重复
  const ids = [...html.matchAll(/clipPath id="([^"]+)"/g)].map((m) => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
  // 局域网跳转保留原有校验
  expect(html).toContain("'/m' + (code ? '#pair=' + code : '')");
});

test("启动器页 v16：“连家里电脑”是可展开卡——有上次的电脑默认展开、一键直连；没有就收起、只给配对新电脑；不写扫码", () => {
  const html = read("mobile/www/index.html");
  expect(html).not.toContain('class="sepl"');
  expect(html).toContain('id="lanToggle"');
  expect(html).toContain("同一 Wi-Fi 下，不用账号");
  expect(html).toContain("上次连的是");
  expect(html).toContain(">直接连上次的</button>");
  expect(html).toContain('id="lanBtn">配对新电脑</button>');
  // 直连上次 = 现有 goLan，不带配对码
  expect(html).toContain("goLan(last.host, last.port || 8765, '')");
  // 默认展开与否只看有没有上次的电脑；展开/收起记在本机
  expect(html).toContain("var open = hasLast;");
  expect(html).toContain("localStorage.setItem('nyra-lan-open'");
  // APK 里没有扫码，首屏不提
  const first = html.slice(html.indexOf('<section id="first"'), html.indexOf('<section id="lan"'));
  expect(first).not.toContain("扫码");
  expect(first).not.toContain("二维码");
});

test("文字只写 Nyra：手机页、启动器页、文案里没有旧名或其他第三方产品名（Google / GitHub 按钮除外）", () => {
  const { zh, en } = mobileMessages();
  const all = [MOBILE_V2_HTML, read("mobile/www/index.html"), JSON.stringify(zh), JSON.stringify(en)].join("\n");
  for (const bad of [/angel/i, /grok/i, /agentteams/i, /codex/i, /claude/i, /openai/i, /chatgpt/i, /hark/i, /muse/i]) expect(all).not.toMatch(bad);
  const zhKeys = Object.keys(zh).sort();
  expect(Object.keys(en).sort()).toEqual(zhKeys);
});
