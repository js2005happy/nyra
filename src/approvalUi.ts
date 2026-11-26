// src/approvalUi.ts — 交互审批选择器，与 Python 版 nyra/approval_ui.py 同语义。
// Claude 式选择器：编号选项、Enter 确认、Esc 取消，默认选“是”。
// 非 TTY 时行输入回退：空行 = 是（默认），EOF/Ctrl-C = 否（fail-closed）。
// 任何无法识别的输入都是“否”，绝不抛错。
import { createInterface } from "node:readline";
import { t } from "./i18n.ts";

export const YES = "yes";
export const NO = "no";
export const ALWAYS = "always";
export type ApprovalChoice = "yes" | "no" | "always";

/** 英文版页脚（兼容旧引用）；菜单实际按界面语言取 approvalFooter()。 */
export const APPROVAL_FOOTER = "Enter to confirm · Esc to cancel";
export function approvalFooter(): string { return t("approval.footer"); }

export function approvalOptions(allowAlways: boolean, alwaysLabel?: string): [string, ApprovalChoice][] {
  const options: [string, ApprovalChoice][] = [[t("approval.yes"), YES], [t("approval.no"), NO]];
  if (allowAlways) {
    options.push([alwaysLabel ?? t("approval.always"), ALWAYS]);
  }
  return options;
}

export function renderApprovalMenu(options: [string, ApprovalChoice][], selected: number): string {
  const lines: string[] = [];
  options.forEach(([label], index) => {
    const marker = index === selected ? "> " : "  ";
    let text = `${marker}${index + 1}. ${label}`;
    if (index === selected) text = `\x1b[7m${text}\x1b[0m`;
    lines.push(text);
  });
  lines.push("");
  lines.push(approvalFooter());
  return lines.join("\n") + "\n";
}

export type KeyToken = "up" | "down" | "enter" | "esc" | "ctrl-c" | "y" | "n" | "a" | string;

export function menuSelect(
  options: [string, ApprovalChoice][],
  readKey: () => KeyToken,
  write: (text: string) => void,
): ApprovalChoice {
  let selected = 0;
  const count = options.length;
  write(renderApprovalMenu(options, selected));
  for (;;) {
    const key = readKey();
    if (key === "up") selected = (selected - 1 + count) % count;
    else if (key === "down") selected = (selected + 1) % count;
    else if (key === "enter") return options[selected][1];
    else if (key === "esc" || key === "ctrl-c") return NO;
    else if (key === "y") return YES;
    else if (key === "n") return NO;
    else if (key === "a") {
      for (const [, value] of options) if (value === ALWAYS) return ALWAYS;
      return NO;
    } else if (/^[0-9]$/.test(key)) {
      const index = parseInt(key, 10) - 1;
      if (index >= 0 && index < count) return options[index][1];
      continue;
    } else {
      continue;
    }
    write(`\x1b[${count + 2}A\x1b[J` + renderApprovalMenu(options, selected));
  }
}

/** 行输入回退：空行 = 是；EOF/Ctrl-C = 否（fail-closed）。 */
export async function lineFallback(prompt: string, allowAlways: boolean): Promise<ApprovalChoice> {
  const question = `${prompt} ${t("approval.lineChoices")} `;
  // 交互会话已经有自己的 readline 时借用它提问：同一个 stdin 上再开一个 readline，
  // 关掉时会把 stdin 暂停，会话随后就以 exit 0 退出（管道输入下复现过）。
  if (approvalHooks.ask) {
    try {
      return parseLineAnswer(await approvalHooks.ask(question), allowAlways);
    } catch {
      return NO;
    }
  }
  const stdinAny = process.stdin as unknown as { isPaused?: () => boolean; resume?: () => unknown };
  const wasPaused = typeof stdinAny.isPaused === "function" ? stdinAny.isPaused() : true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string | null>((resolvePromise) => {
      rl.question(question, (a) => resolvePromise(a));
      rl.on("close", () => resolvePromise(null));
    });
    return parseLineAnswer(answer, allowAlways);
  } catch {
    return NO;
  } finally {
    rl.close();
    if (!wasPaused) { try { stdinAny.resume?.(); } catch { /* ignore */ } }
  }
}

/** 行输入的答案：空行/y/yes/1 = 是；a/always/3 = 始终允许（若可用）；EOF 与其余 = 否。 */
export function parseLineAnswer(answer: string | null, allowAlways: boolean): ApprovalChoice {
  {
    if (answer === null) return NO; // EOF
    const a = answer.trim().toLowerCase();
    if (a === "" || a === "y" || a === "yes" || a === "1") return YES;
    if (allowAlways && (a === "a" || a === "always" || a === "3")) return ALWAYS;
    return NO;
  }
}

/**
 * 审批前后的钩子：交互终端用它在提问前收起 spinner、让小伙伴举手，
 * 回答后再恢复。钩子出错一律忽略，绝不影响审批本身（fail-closed 语义不变）。
 */
export const approvalHooks: {
  before?: (prompt: string) => void;
  after?: (choice: ApprovalChoice) => void;
  /** 交互会话自己的行输入（借用会话的 readline 提问）；null = EOF。 */
  ask?: (question: string) => Promise<string | null>;
} = {};

/** TTY 时方向键菜单，否则行输入回退；菜单搭建失败也回退到行输入。 */
export async function askApproval(prompt: string, allowAlways = false, alwaysLabel?: string): Promise<ApprovalChoice> {
  try { approvalHooks.before?.(prompt); } catch { /* ignore */ }
  let choice: ApprovalChoice = NO;
  try {
    choice = await askApprovalInner(prompt, allowAlways, alwaysLabel);
    return choice;
  } finally {
    try { approvalHooks.after?.(choice); } catch { /* ignore */ }
  }
}

async function askApprovalInner(prompt: string, allowAlways: boolean, alwaysLabel?: string): Promise<ApprovalChoice> {
  const options = approvalOptions(allowAlways, alwaysLabel);
  const stdinTty = Boolean(process.stdin.isTTY);
  const stdoutTty = Boolean(process.stdout.isTTY);
  if (stdinTty && stdoutTty) {
    try {
      process.stdout.write(prompt + "\n");
      return await ttyMenu(options);
    } catch {
      // 回退到行输入。
    }
  }
  return lineFallback(prompt, allowAlways);
}

/** ttyMenu 要用到的 stdin 能力（测试可注入假的 stdin）。 */
export interface MenuStdin {
  isRaw?: boolean;
  isPaused?: () => boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  on: (event: "data", cb: (chunk: Buffer) => void) => unknown;
  off: (event: "data", cb: (chunk: Buffer) => void) => unknown;
}

/**
 * 方向键菜单。结束时把 stdin 恢复成进来时的样子（raw 模式、暂停与否）：
 * 交互会话的 readline 还挂在同一个 stdin 上，审批后若把它暂停或关掉 raw，
 * 事件循环里就没有活着的句柄，进程会以 exit 0 悄悄退出（实机复现过）。
 */
export function ttyMenu(
  options: [string, ApprovalChoice][],
  stdin: MenuStdin = process.stdin as unknown as MenuStdin,
  write: (text: string) => void = (t) => { process.stdout.write(t); },
): Promise<ApprovalChoice> {
  return new Promise((resolvePromise) => {
    const wasRaw = Boolean(stdin.isRaw);
    const wasPaused = typeof stdin.isPaused === "function" ? stdin.isPaused() : true;
    stdin.setRawMode?.(true);
    stdin.resume();
    let selected = 0;
    const count = options.length;
    write(renderApprovalMenu(options, selected));
    const onData = (chunk: Buffer) => {
      const b = chunk[0];
      let key: KeyToken = "";
      if (b === 0x1b) {
        if (chunk.length >= 3 && chunk[1] === 0x5b) {
          key = chunk[2] === 0x41 ? "up" : chunk[2] === 0x42 ? "down" : "";
        } else {
          key = "esc";
        }
      } else if (b === 0x0d || b === 0x0a) key = "enter";
      else if (b === 0x03) key = "ctrl-c";
      else key = String.fromCharCode(b).toLowerCase();
      // 复用 menuSelect 的状态机：这里直接内联一步，避免 readKey 阻塞。
      if (key === "up") selected = (selected - 1 + count) % count;
      else if (key === "down") selected = (selected + 1) % count;
      else if (key === "enter") return done(options[selected][1]);
      else if (key === "esc" || key === "ctrl-c") return done(NO);
      else if (key === "y") return done(YES);
      else if (key === "n") return done(NO);
      else if (key === "a") {
        for (const [, v] of options) if (v === ALWAYS) return done(ALWAYS);
        return done(NO);
      } else if (/^[0-9]$/.test(key)) {
        const idx = parseInt(key, 10) - 1;
        if (idx >= 0 && idx < count) return done(options[idx][1]);
        return;
      } else {
        return;
      }
      write(`\x1b[${count + 2}A\x1b[J` + renderApprovalMenu(options, selected));
    };
    const done = (choice: ApprovalChoice) => {
      stdin.off("data", onData);
      try { stdin.setRawMode?.(wasRaw); } catch { /* ignore */ }
      if (wasPaused) stdin.pause();
      resolvePromise(choice);
    };
    stdin.on("data", onData);
  });
}
