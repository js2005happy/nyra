// src/botScreen.ts — 缺口 50 第一批：浏览器操作与接管——live screen +
// 活动列表（只读）。接管（take the wheel）是第二批，本批不做。
//
// 口径（Bot 方向报告 §6 缺口 50，先做“看”再做“接管”）：
//   - live screen：实时看 Bot 的浏览器在做什么。画面来自缺口 42 的电脑
//     （profile 的上次访问 host + 活动账本的最近动作）；本机没有真实
//     浏览器画面，所以本批是假画面/回环模型——每帧只是一次确定性快照，
//     只记帧指纹（SHA-256 前 12 位，与缺口 39 的扇出同一口径）与收件人，
//     不记帧内容、不截图留存。真实浏览器画面的抓取与传输未接通。
//   - 活动列表：与时间线同源，不另起一套活动账本。正在做什么取活动账本
//     的最新一条（运行事件镜像的源头）；下一步取关联运行的时间线阶段
//     （缺口 21 的 buildTimeline + stageDisplay），没有关联运行时明说
//     “看不到下一步”，不编一个。
//   - 隐私打码：画面文字（活动摘要，或调用方传进来的视觉描述）先过确定
//     性打码——密码框/密码值、验证码、卡号形状——打码后的文本才往外给；
//     打码事件进证据链，只记“打了哪几类”，不记原文。
//   - 可见性：画面只对机主与信任圈成员可见（缺口 34 的 isAdmitted；机主
//     是 owner）。圈外一律拒绝，拒绝本身不记敏感信息。
//   - 看懂屏幕内容复用缺口 16 的视觉能力：真画面上的 OCR/视觉描述走
//     describe_image 同款门禁（模型须支持看图，本地优先、云端默认关）；
//     假帧没有像素，不调模型——本批的“画面描述”是活动摘要的确定性文本，
//     不是模型看图的结果，文档里写清。
//   - 只读：本批没有任何写操作（不点、不输、不接管）；看屏本身记一笔
//     活动账本（browser/screen.watch，谁看的、看了哪台、哪个 host），
//     是审计，不是写操作。
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ComputerError, getComputer, loadComputerProfile, readComputerActivity, recordComputerActivity, type BotComputer, type ComputerActivity } from "./bot/computer.ts";
import { isAdmitted, OWNER_IDENTITY } from "./circles.ts";
import { RunStore } from "./runs.ts";
import { buildTimeline, stageDisplay } from "./timeline.ts";

export class ScreenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenError";
  }
}

/** 帧指纹：SHA-256 前 12 位小写 hex（与缺口 39 的 SESSION_FRAME_HASH_RE 同款）。 */
export const SCREEN_FRAME_HASH_RE = /^[0-9a-f]{12}$/;
/** 打码种类：密码 / 验证码 / 支付信息（只记种类，不记原文）。 */
export type ScreenRedactionKind = "password" | "verification_code" | "payment";
export const SCREEN_REDACTION_KINDS: readonly ScreenRedactionKind[] = ["password", "verification_code", "payment"];

const RUN_ID_RE = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;

/** 帧指纹（纯函数）：电脑 + 快照时间 + host + 最近动作拼起来哈希，可复现、可比对。 */
export function frameHashFor(computerId: string, at: string, host: string, action: string): string {
  return createHash("sha256").update(`${computerId}\n${at}\n${host}\n${action}`).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// 隐私打码（确定性规则，不调模型、不记原文）
// ---------------------------------------------------------------------------

/**
 * 打码画面文字：卡号形状、密码值/密码框、验证码（关键词附近的 4–8 位数字）。
 * 返回打码后的文本与打了哪几类（种类去重、按固定顺序）；没命中时 kinds 为空、
 * 文本原样返回。调用方永远只对外给返回的文本，原文不留存。
 */
export function redactScreenText(text: string): { text: string; redacted: ScreenRedactionKind[] } {
  const kinds = new Set<ScreenRedactionKind>();
  let out = text;
  // 支付信息：卡号形状（4 组 4 位，可带空格/连字符）先打，避免后边的数字规则误伤。
  if (/\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/.test(out)) {
    kinds.add("payment");
    out = out.replace(/\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, "[卡号已打码]");
  }
  // 支付信息：卡号/银行卡字样后跟的一长串数字。
  if (/(卡号|银行卡|card\s*(?:number|no\.?)?)\s*[:：]?\s*[\d -]{12,}/i.test(out)) {
    kinds.add("payment");
    out = out.replace(/(卡号|银行卡|card\s*(?:number|no\.?)?)\s*[:：]?\s*[\d -]{12,}/gi, "$1：[卡号已打码]");
  }
  // 密码：<input type=password> 框整个打掉；密码字样后跟的值打掉（值本身不留）。
  // 值只取到空白或中文标点为止——\S+ 会把后面紧跟的“验证码”三个字一起吞掉。
  if (/<input[^>]*type=["']password["'][^>]*>/i.test(out)) {
    kinds.add("password");
    out = out.replace(/<input[^>]*type=["']password["'][^>]*>/gi, "[密码框已打码]");
  }
  if (/(password|passwd|密码)\s*[:：=]\s*[^\s，。；：、]+/i.test(out)) {
    kinds.add("password");
    out = out.replace(/(password|passwd|密码)\s*[:：=]\s*[^\s，。；：、]+/gi, "$1：[已打码]");
  }
  // 验证码：验证码/verification code/OTP 字样附近的 4–8 位数字。
  if (/(验证码|verification\s*code|otp)\s*[:：]?\s*\d{4,8}/i.test(out)) {
    kinds.add("verification_code");
    out = out.replace(/(验证码|verification\s*code|otp)\s*[:：]?\s*\d{4,8}/gi, "$1：[验证码已打码]");
  }
  const ordered = SCREEN_REDACTION_KINDS.filter((k) => kinds.has(k));
  return { text: out, redacted: ordered };
}

// ---------------------------------------------------------------------------
// 可见性：画面只对机主与信任圈成员可见（缺口 34 的 isAdmitted）
// ---------------------------------------------------------------------------

/** 谁能看这台电脑的屏幕：机主永远能看；别人须已批准好友且在任一信任圈里。 */
export function checkScreenViewer(home: string, viewer: string): { allowed: boolean; reason: string } {
  if (!viewer.trim()) return { allowed: false, reason: "看屏要指明是谁在看（--as <身份>，默认机主）" };
  if (viewer === OWNER_IDENTITY) return { allowed: true, reason: "机主本人" };
  if (isAdmitted(home, viewer)) return { allowed: true, reason: "信任圈成员" };
  return { allowed: false, reason: `${viewer} 不在信任圈里，看不到这台电脑的屏幕（先 nyra circle invite <圈名> ${viewer}）` };
}

function requireViewer(home: string, viewer: string): void {
  const check = checkScreenViewer(home, viewer);
  if (!check.allowed) throw new ScreenError(`看屏被拒：${check.reason}`);
}

/** 运行事件镜像：只在运行真实存在时写（账本是源头，镜像丢了不影响审计）。 */
function mirrorToRun(home: string, runId: string | null | undefined, type: string, fields: Record<string, unknown>): void {
  if (!runId || !RUN_ID_RE.test(runId)) return;
  if (!existsSync(join(home, "runs", runId, "state.json"))) return;
  try {
    new RunStore(join(home, "runs")).appendEvent(runId, type, fields);
  } catch { /* 镜像失败不影响看屏 */ }
}

// ---------------------------------------------------------------------------
// live screen：单帧快照（只读）
// ---------------------------------------------------------------------------

export interface ScreenFrame {
  computerId: string;
  agent: string;
  /** live：醒着且有画面；休眠时没有实时画面，frameHash 为 null。 */
  live: boolean;
  state: string;
  /** 正在看哪个 host（profile 的上次访问，只记 host）。 */
  host: string | null;
  currentAction: string | null;
  currentTarget: string | null;
  /** 画面描述（活动摘要的确定性文本，已打码；不是模型看图的结果）。 */
  description: string;
  redacted: ScreenRedactionKind[];
  /** 帧指纹（SHA-256 前 12 位），休眠时为 null；只记指纹，不记帧内容。 */
  frameHash: string | null;
  at: string;
  /** 收件人：只有看屏的人自己（画面不扩散）。 */
  recipients: string[];
}

/** 画面描述（确定性文本）：正在看哪个 host、最近在做什么；休眠时明说没画面。 */
export function describeScreen(computer: BotComputer, host: string | null, latest: ComputerActivity | null): string {
  if (computer.state === "sleeping") return "电脑在休眠，没有实时画面。";
  if (!host && !latest) return "电脑醒着，但还没打开过页面，也没有活动。";
  const where = host ? `正在看 ${host}` : "还没打开过页面";
  const doing = latest ? `，最近在做 ${latest.action}（${latest.target}）` : "";
  return `${where}${doing}。`;
}

export interface WatchScreenOptions {
  runId?: string | null;
  /**
   * 调用方传进来的画面文字（例如缺口 16 describe_image 的视觉描述）：
   * 先打码再往外给；不传时用活动摘要的确定性文本。原文不留存。
   */
  screenText?: string;
  /** 快照时间（测试注入；不传用当前时间）。 */
  at?: string;
}

/**
 * 看屏（只读）：返回一帧快照——帧指纹 + 收件人 + 打码后的描述，不记帧内容。
 * 休眠的电脑没有实时画面（live 为 false、frameHash 为 null），不报错。
 * 看屏本身记一笔活动账本（browser/screen.watch）与一条运行事件
 * （bot_screen_watched，有 runId 且运行存在时才镜像）；打码命中时另记
 * 一条 bot_screen_redacted（只记种类，不记原文）。
 */
export function watchScreen(home: string, computerId: string, viewer: string, opts?: WatchScreenOptions): ScreenFrame {
  const computer = getComputer(home, computerId);
  requireViewer(home, viewer);
  const profile = loadComputerProfile(home, computer);
  const activities = readComputerActivity(home, computerId, 1);
  const latest = activities.length ? activities[activities.length - 1] : null;
  const host = profile.lastVisitedHost;
  const at = opts?.at ?? new Date().toISOString();
  const rawText = opts?.screenText ?? describeScreen(computer, host, latest);
  const { text, redacted } = redactScreenText(rawText);
  const live = computer.state === "active";
  const frameHash = live ? frameHashFor(computerId, at, host ?? "", latest?.action ?? "") : null;
  recordComputerActivity(home, {
    computerId,
    kind: "browser",
    action: "screen.watch",
    target: host ?? computer.name,
    ok: true,
    detail: live ? `只读看屏（${viewer}）` : `只读看屏（${viewer}，电脑休眠、无画面）`,
  });
  if (live && frameHash) {
    mirrorToRun(home, opts?.runId, "bot_screen_watched", {
      computer_id: computerId,
      viewer,
      frame_hash: frameHash,
      host: host ?? "",
    });
  }
  if (redacted.length > 0 && frameHash) {
    mirrorToRun(home, opts?.runId, "bot_screen_redacted", {
      computer_id: computerId,
      kinds: redacted.join(","),
      frame_hash: frameHash,
    });
  }
  return {
    computerId,
    agent: computer.agent,
    live,
    state: computer.state,
    host,
    currentAction: latest?.action ?? null,
    currentTarget: latest?.target ?? null,
    description: text,
    redacted,
    frameHash,
    at,
    recipients: [viewer],
  };
}

// ---------------------------------------------------------------------------
// 活动列表：与时间线同源（正在做 + 下一步）
// ---------------------------------------------------------------------------

export interface ScreenActivity {
  computerId: string;
  agent: string;
  state: string;
  /** 正在做什么：活动账本最新一条（没有活动时为 null）。 */
  current: ComputerActivity | null;
  /** 最近活动（最新 N 条在后，与 readComputerActivity 同序）。 */
  recent: ComputerActivity[];
  /** 下一步：有关联运行时取时间线阶段；没有关联运行时为 null（不编）。 */
  next: string | null;
  /** 下一步的来源：timeline（时间线阶段）/ none（没有关联运行）。 */
  nextSource: "timeline" | "none";
  /** 时间线阶段的一行（有关联运行时才有）。 */
  stage: string | null;
  runId: string | null;
}

export interface ScreenActivityOptions {
  runId?: string | null;
  limit?: number;
}

/**
 * 活动列表（只读）：正在做什么取活动账本最新一条；下一步取关联运行的
 * 时间线阶段（缺口 21）：等审批/卡住/等审阅/进行中/空闲。关联运行优先
 * 用 --run 指定的，其次向后找最近一条带 runId 的活动（看屏本身不带
 * runId，不能只看最新一条）；两者都没有时 next 为 null——没有运行
 * 上下文就看不到下一步，明说，不编一个。
 */
export function listScreenActivity(home: string, computerId: string, viewer: string, opts?: ScreenActivityOptions): ScreenActivity {
  const computer = getComputer(home, computerId);
  requireViewer(home, viewer);
  const limit = Math.max(1, Math.min(50, Math.floor(opts?.limit ?? 10)));
  const recent = readComputerActivity(home, computerId, limit);
  const current = recent.length ? recent[recent.length - 1] : null;
  const runId = opts?.runId ?? [...recent].reverse().find((a) => a.runId)?.runId ?? null;
  let next: string | null = null;
  let stage: string | null = null;
  let nextSource: "timeline" | "none" = "none";
  if (runId && RUN_ID_RE.test(runId) && existsSync(join(home, "runs", runId, "state.json"))) {
    try {
      const tl = buildTimeline(new RunStore(join(home, "runs")), runId);
      stage = stageDisplay(tl.stage);
      next = tl.stage.stage === "idle"
        ? "无待办"
        : tl.stage.waitingFor ?? tl.stage.label;
      nextSource = "timeline";
    } catch { /* 时间线拼不出来时 next 保持 null，不编 */ }
  }
  return { computerId, agent: computer.agent, state: computer.state, current, recent, next, nextSource, stage, runId };
}

// ---------------------------------------------------------------------------
// 状态：这台电脑的看屏可用性（只读；接管是第二批，这里只明说未做）
// ---------------------------------------------------------------------------

export interface ScreenStatus {
  computerId: string;
  agent: string;
  state: string;
  host: string | null;
  lastActivity: ComputerActivity | null;
  viewers: string;
  /** 接管：本批不做，第二批做。 */
  takeover: "second-batch";
}

export function screenStatus(home: string, computerId: string, viewer: string): ScreenStatus {
  const computer = getComputer(home, computerId);
  requireViewer(home, viewer);
  const profile = loadComputerProfile(home, computer);
  const activities = readComputerActivity(home, computerId, 1);
  return {
    computerId,
    agent: computer.agent,
    state: computer.state,
    host: profile.lastVisitedHost,
    lastActivity: activities.length ? activities[activities.length - 1] : null,
    viewers: "机主与信任圈成员",
    takeover: "second-batch",
  };
}

// ---------------------------------------------------------------------------
// CLI：`nyra screen <watch|activity|status>`（只读；接管不在本批）
// ---------------------------------------------------------------------------

export const SCREEN_USAGE =
  "用法：nyra screen <watch|activity|status> <电脑 id> [--as <身份>] [--run <运行 id>] [--limit N] [--text <画面文字>]\n" +
  "  watch <电脑 id> [--as <身份>] [--run <运行 id>] [--text <画面文字>]   看屏（只读）：一帧快照——帧指纹 + 正在看的页面 + 最近动作，不记帧内容；画面文字先打码（密码/验证码/卡号）\n" +
  "  activity <电脑 id> [--as <身份>] [--run <运行 id>] [--limit N]   活动列表（只读）：正在做什么 + 下一步（下一步取关联运行的时间线阶段，没有关联运行就不编）\n" +
  "  status <电脑 id> [--as <身份>]   看屏可用性：电脑状态、上次访问、最近活动；接管（take the wheel）是第二批，本批没有";

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1] : undefined;
}

export async function handleScreen(argv: string[], home: string): Promise<number> {
  const cmd = argv[0];
  try {
    if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
      process.stdout.write(SCREEN_USAGE + "\n");
      return 0;
    }
    if (cmd !== "watch" && cmd !== "activity" && cmd !== "status") {
      process.stdout.write(SCREEN_USAGE + "\n");
      return 2;
    }
    const id = argv[1];
    if (!id) {
      process.stderr.write(`用法：nyra screen ${cmd} <电脑 id>\n`);
      return 2;
    }
    const viewer = flagValue(argv, "--as") ?? OWNER_IDENTITY;
    const runId = flagValue(argv, "--run") ?? null;
    if (cmd === "watch") {
      const frame = watchScreen(home, id, viewer, { runId, screenText: flagValue(argv, "--text") });
      process.stdout.write(`电脑 ${frame.computerId}（agent ${frame.agent}）— ${frame.live ? "实时画面" : "休眠，没有实时画面"}\n`);
      process.stdout.write(`正在看：${frame.host ?? "还没打开过页面"}\n`);
      if (frame.currentAction) process.stdout.write(`最近动作：${frame.currentAction}（${frame.currentTarget ?? ""}）\n`);
      process.stdout.write(`画面：${frame.description}\n`);
      if (frame.frameHash) process.stdout.write(`帧指纹：${frame.frameHash}（只记指纹，不记帧内容；收件人：${frame.recipients.join("、")}）\n`);
      if (frame.redacted.length) process.stdout.write(`已打码：${frame.redacted.join("、")}（原文不留存）\n`);
      return 0;
    }
    if (cmd === "activity") {
      const limitRaw = flagValue(argv, "--limit");
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      const activity = listScreenActivity(home, id, viewer, { runId, limit: Number.isFinite(limit) ? limit : undefined });
      process.stdout.write(`电脑 ${activity.computerId}（agent ${activity.agent}）— ${activity.state === "active" ? "醒着" : "休眠"}\n`);
      if (activity.current) {
        process.stdout.write(`正在做：${activity.current.action}（${activity.current.target}）— ${activity.current.at}${activity.current.ok ? "" : "（失败）"}\n`);
      } else {
        process.stdout.write("正在做：还没有活动。\n");
      }
      if (activity.next !== null) {
        process.stdout.write(`下一步：${activity.next}（来源：${activity.nextSource === "timeline" ? `运行 ${activity.runId} 的时间线，阶段：${activity.stage}` : "无"}）\n`);
      } else {
        process.stdout.write("下一步：看不到（没有关联运行；给 --run <运行 id> 接时间线）。\n");
      }
      if (activity.recent.length) {
        process.stdout.write("最近活动：\n");
        for (const a of activity.recent) process.stdout.write(`- ${a.at} ${a.action} ${a.target}${a.ok ? "" : "（失败）"}\n`);
      }
      return 0;
    }
    const status = screenStatus(home, id, viewer);
    process.stdout.write(`电脑 ${status.computerId}（agent ${status.agent}）\n`);
    process.stdout.write(`状态：${status.state === "active" ? "醒着" : "休眠"}${status.state === "active" ? "（有实时画面）" : "（没有实时画面）"}\n`);
    process.stdout.write(`上次访问：${status.host ?? "无"}\n`);
    if (status.lastActivity) process.stdout.write(`最近活动：${status.lastActivity.at} ${status.lastActivity.action} ${status.lastActivity.target}\n`);
    process.stdout.write(`谁能看：${status.viewers}\n`);
    process.stdout.write("接管（take the wheel）：第二批才做，本批只有只读看屏。\n");
    return 0;
  } catch (err) {
    if (err instanceof ScreenError || err instanceof ComputerError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
