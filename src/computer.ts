// src/computer.ts — 桌面控制原生 Node 移植，对应 nyra/computer.py。
//
// 让 Agent 操作电脑桌面：鼠标、键盘、截屏、窗口。只用 Node 标准库。
// 后端按操作系统自动选：
// - Linux/X11：xdotool（鼠标/键盘/窗口）+ import / scrot / gnome-screenshot（截屏）。
// - Windows：PowerShell + Add-Type user32（mouse_event/keybd_event/SendInput）
//   + .NET System.Drawing（截屏）。Python 版是 ctypes 直调 user32/gdi32，
//   Node 没有 ctypes，所以改走 PowerShell——见文件末尾的缺口说明。
// - macOS：osascript（System Events / CoreGraphics）+ screencapture。
//
// 错误约定（接线时注意）：所有失败都以 ComputerError（中文 message）
// 抛出，绝不把 execFile 的原始错误/堆栈直接漏出去；tools.ts 接线处
// 用 computerErrorMessage(err) 转成 `错误：<中文>` 字符串返回。
// 审批不在这里做（tools.ts 的 checkApproval 已做）。
import { execFile, type ChildProcess } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter as pathDelimiter, join as joinPath } from "node:path";

export const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
export const MAX_COORD = 100000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
export const SCREENSHOT_TIMEOUT_MS = 15_000;

export class ComputerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerError";
  }
}

/** 执行器层面的超时（内部用）；各后端把它翻成带中文口径的 ComputerError。 */
export class CommandTimeoutError extends Error {
  constructor(message = "命令超时") {
    super(message);
    this.name = "CommandTimeoutError";
  }
}

/** 把任意失败转成一句中文（接线处：`错误：${computerErrorMessage(err)}`）。 */
export function computerErrorMessage(err: unknown): string {
  if (err instanceof ComputerError) return err.message;
  if (err instanceof CommandTimeoutError) return err.message;
  if (err instanceof Error) return err.message || "桌面操作失败";
  return String(err);
}

export type ComputerBackendName = "x11" | "windows" | "macos";

export interface ScreenSize {
  width: number;
  height: number;
}

export interface WindowInfo {
  id: string;
  title: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface CommandResult {
  stdout: Buffer;
  stderr: string;
  /** 进程退出码；spawn 失败时为 null（此时 runner 直接 reject）。 */
  code: number | null;
}

export interface CommandRunnerOptions {
  timeoutMs: number;
}

export type CommandRunner = (
  argv: string[],
  opts: CommandRunnerOptions,
) => Promise<CommandResult>;

export type WhichFn = (tool: string) => string | null;

export interface ComputerOptions {
  backend?: ComputerBackendName;
  /** 默认 process.platform；测试可注入 "linux" / "win32" / "darwin"。 */
  platform?: string;
  /** 默认 process.env；测试可注入 { DISPLAY: ":0" } 之类。 */
  env?: NodeJS.ProcessEnv;
  /** 默认走 execFile；测试注入假 runner。 */
  runner?: CommandRunner;
  /** 默认在 PATH 里找可执行文件；测试可注入。 */
  which?: WhichFn;
  /** 仅 macOS 截屏读临时文件用；默认 readFileSync。测试可注入。 */
  readFile?: (path: string) => Buffer;
  /** 桌面命令超时（毫秒），默认 10_000；测试可调小。 */
  commandTimeoutMs?: number;
  /** 截屏超时（毫秒），默认 15_000；测试可调小。 */
  screenshotTimeoutMs?: number;
}

// ---- 小工具：与 Python 同口径的校验/报错 ----

/** Python repr() 的近似：字符串用单引号，数字照原样。 */
export function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "None";
  if (value === undefined) return "None";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function validateCoord(value: unknown, name: string): number {
  if (typeof value === "boolean") {
    throw new ComputerError(`${name} 必须是整数`);
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    // 整数浮点（如 10.0）Python 也接受，已在 isInteger 里覆盖。
  } else if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ComputerError(`${name} 必须是整数，收到 ${pyRepr(value)}`);
  }
  const n = value as number;
  if (n < 0 || n > MAX_COORD) {
    throw new ComputerError(
      `${name} 超出合理范围：${n}（应为 0-${MAX_COORD} 的整数）`,
    );
  }
  return n;
}

export function validateButton(button: string): string {
  if (button !== "left" && button !== "middle" && button !== "right") {
    throw new ComputerError(
      `鼠标键必须是 left/middle/right，收到 ${pyRepr(button)}`,
    );
  }
  return button;
}

/** Python _check_png：非 PNG 直接报错（审查修复 F-L1 的口径）。 */
export function checkPng(data: Buffer, source: string): Buffer {
  if (!Buffer.isBuffer(data) || !data.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new ComputerError(`${source} 没有返回有效的 PNG 数据`);
  }
  return data;
}

// ---- 按键名归一化（与 Python normalize_key 同语义） ----

const MODIFIERS = new Set(["ctrl", "alt", "shift", "win"]);

const KEY_ALIASES: Record<string, string> = {
  return: "enter",
  escape: "esc",
  del: "delete",
  backspace: "backspace",
  pgup: "page_up",
  pgdn: "page_down",
  pageup: "page_up",
  pagedown: "page_down",
  control: "ctrl",
  option: "alt",
  super: "win",
  cmd: "win",
  command: "win",
  meta: "win",
};

const SINGLE_KEYS = new Set([
  "enter", "tab", "esc", "space", "backspace", "delete", "insert",
  "home", "end", "page_up", "page_down", "up", "down", "left", "right",
  "caps_lock", "num_lock", "print_screen",
  "f1", "f2", "f3", "f4", "f5", "f6",
  "f7", "f8", "f9", "f10", "f11", "f12",
]);

function isSingleKey(name: string): boolean {
  if (SINGLE_KEYS.has(name)) return true;
  return name.length === 1 && /^[a-z0-9]$/i.test(name);
}

export interface NormalizedKey {
  mods: string[];
  base: string;
}

export function normalizeKey(key: string): NormalizedKey {
  if (typeof key !== "string" || !key.trim()) {
    throw new ComputerError("按键名不能为空");
  }
  const parts = key.split("+").map((p) => p.trim().toLowerCase());
  if (parts.some((p) => p === "")) {
    throw new ComputerError(
      `按键名格式不对：${pyRepr(key)}（用 + 连接，如 ctrl+c）`,
    );
  }
  const mods: string[] = [];
  let base: string | null = null;
  for (const part of parts) {
    const name = KEY_ALIASES[part] ?? part;
    if (MODIFIERS.has(name)) {
      if (mods.includes(name)) {
        throw new ComputerError(`重复的修饰键：${pyRepr(key)}`);
      }
      mods.push(name);
    } else if (base !== null) {
      throw new ComputerError(`一次只能按一个主键：${pyRepr(key)}`);
    } else if (isSingleKey(name)) {
      base = name;
    } else {
      throw new ComputerError(
        `不认识的按键：${pyRepr(part)}（支持 enter/tab/esc/space/方向键/f1-f12/字母/数字/ctrl+c 这类组合）`,
      );
    }
  }
  if (base === null) {
    throw new ComputerError(
      `按键名里没有主键：${pyRepr(key)}（如 ctrl+c 中的 c）`,
    );
  }
  return { mods, base };
}

// ---- xdotool 按键/鼠标映射（与 Python _XDOTOOL_KEYS 同表） ----

const XDOTOOL_KEYS: Record<string, string> = {
  enter: "Return",
  esc: "Escape",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  page_up: "Prior",
  page_down: "Next",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  tab: "Tab",
  caps_lock: "Caps_Lock",
  num_lock: "Num_Lock",
  print_screen: "Print",
  ctrl: "ctrl",
  alt: "alt",
  shift: "shift",
  win: "Super_L",
};

const XDOTOOL_BUTTONS: Record<string, string> = {
  left: "1",
  middle: "2",
  right: "3",
};

// ---- macOS 按键码（与 Python _MAC_KEY_CODES / _MAC_MODIFIERS 同表） ----

const MAC_KEY_CODES: Record<string, number> = {
  enter: 36, tab: 48, esc: 53, space: 49, backspace: 51,
  delete: 117, insert: 114, home: 115, end: 119,
  page_up: 116, page_down: 121, up: 126, down: 125,
  left: 123, right: 124, caps_lock: 57,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4,
  i: 34, j: 38, k: 40, l: 37, m: 46, n: 45, o: 31,
  p: 35, q: 12, r: 15, s: 1, t: 17, u: 32, v: 9,
  w: 13, x: 7, y: 16, z: 6,
  "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22,
  "7": 26, "8": 28, "9": 25,
};

const MAC_MODIFIERS: Record<string, string> = {
  ctrl: "control",
  alt: "option",
  shift: "shift",
  win: "command",
};

// ---- Windows 虚拟键码（与 Python _WIN_VK 同表；f1-f12/字母/数字同规则） ----

const WIN_VK: Record<string, number> = {
  enter: 0x0d, tab: 0x09, esc: 0x1b, space: 0x20,
  backspace: 0x08, delete: 0x2e, insert: 0x2d,
  home: 0x24, end: 0x23, page_up: 0x21, page_down: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  caps_lock: 0x14, num_lock: 0x90, print_screen: 0x2c,
  ctrl: 0x11, alt: 0x12, shift: 0x10, win: 0x5b,
};

const WIN_MOUSE_EVENTS: Record<string, [number, number]> = {
  left: [0x0002, 0x0004],
  middle: [0x0020, 0x0040],
  right: [0x0008, 0x0010],
};

export function windowsVirtualKey(name: string): number {
  if (name in WIN_VK) return WIN_VK[name];
  const f = /^f(\d+)$/.exec(name);
  if (f) {
    const num = Number(f[1]);
    if (num >= 1 && num <= 12) return 0x70 + num - 1;
  }
  if (name.length === 1) {
    const ch = name.toUpperCase();
    if (ch >= "A" && ch <= "Z") return 0x41 + ch.charCodeAt(0) - 0x41;
    if (ch >= "0" && ch <= "9") return 0x30 + ch.charCodeAt(0) - 0x30;
  }
  throw new ComputerError(`Windows 不支持这个按键：${pyRepr(name)}`);
}

// ---- 默认 runner / which（只用 node:child_process + fs） ----

function toBuffer(value: Buffer | string): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf-8");
}

/** 默认命令执行器：execFile，不走 shell；仅供测试直接验证。 */
export function defaultCommandRunner(
  argv: string[],
  opts: CommandRunnerOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let child: ChildProcess;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // 进程可能已退出，忽略。
      }
    }, opts.timeoutMs);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    try {
      child = execFile(
        argv[0],
        argv.slice(1),
        {
          timeout: 0,
          maxBuffer: 64 * 1024 * 1024,
          encoding: "buffer",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (timedOut) {
            done(() =>
              reject(
                new CommandTimeoutError(
                  `桌面命令超时：${argv.join(" ")}`,
                ),
              ),
            );
            return;
          }
          if (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (typeof code === "number") {
              // 非零退出：不 reject，让调用方按退出码组织中文报错。
              done(() =>
                resolve({
                  stdout: toBuffer(stdout as Buffer),
                  stderr: toBuffer(stderr as Buffer).toString("utf-8"),
                  code,
                }),
              );
              return;
            }
            // spawn 失败（ENOENT 等）：原始错误往上抛，调用方包中文。
            done(() => reject(error));
            return;
          }
          done(() =>
            resolve({
              stdout: toBuffer(stdout as Buffer),
              stderr: toBuffer(stderr as Buffer).toString("utf-8"),
              code: 0,
            }),
          );
        },
      );
    } catch (err) {
      done(() => reject(err as Error));
    }
  });
}

/** 默认 PATH 查找：仅供测试直接验证。 */
export function defaultWhich(
  tool: string,
  platform: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const pathVar = env.PATH ?? "";
  const isWin = platform === "win32";
  const exts = isWin
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const dir of pathVar.split(pathDelimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = joinPath(dir, tool + ext);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // 不是可执行文件，继续找。
      }
    }
    if (isWin) {
      // PATHEXT 之外的同名文件（如 powershell.exe 本身就在上面覆盖了）。
      try {
        accessSync(joinPath(dir, tool), fsConstants.X_OK);
        return joinPath(dir, tool);
      } catch {
        // 继续找。
      }
    }
  }
  return null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new CommandTimeoutError("桌面命令超时")),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function detectBackend(platform: string): ComputerBackendName {
  if (platform === "linux") return "x11";
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  throw new ComputerError(
    `不支持的操作系统：${platform}（只支持 Linux/X11、Windows、macOS）`,
  );
}

function parseBracedNumbers(text: string): number[] {
  const cleaned = text.trim();
  if (!cleaned.startsWith("{") || !cleaned.endsWith("}")) return [];
  const out: number[] = [];
  for (const part of cleaned.slice(1, -1).split(",")) {
    const n = Number(part.trim());
    if (!Number.isInteger(n)) return [];
    out.push(n);
  }
  return out;
}

function applescriptQuote(text: string): string {
  return (
    '"' +
    text.replace(/\\/g, "\\\\").replace(/"/g, '\\"') +
    '"'
  );
}

export class ComputerControl {
  readonly backend: ComputerBackendName;
  private readonly platform: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runner: CommandRunner;
  private readonly whichFn: WhichFn;
  private readonly readFileFn: (path: string) => Buffer;
  private readonly commandTimeoutMs: number;
  private readonly screenshotTimeoutMs: number;

  constructor(options: ComputerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.runner = options.runner ?? defaultCommandRunner;
    this.whichFn = options.which ?? ((tool) => defaultWhich(tool, this.platform, this.env));
    this.readFileFn = options.readFile ?? ((p) => readFileSync(p));
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.screenshotTimeoutMs = options.screenshotTimeoutMs ?? SCREENSHOT_TIMEOUT_MS;
    const backend = options.backend ?? detectBackend(this.platform);
    if (backend !== "x11" && backend !== "windows" && backend !== "macos") {
      throw new ComputerError(`不认识的后端：${pyRepr(backend)}`);
    }
    this.backend = backend;
  }

  // ---- 公共 API（与 Python ComputerControl 同名同语义；screenSize
  // 返回 {width, height} 而不是 Python 的 (width, height) 元组） ----

  async screenshot(): Promise<Buffer> {
    if (this.backend === "x11") return this.x11Screenshot();
    if (this.backend === "windows") return this.windowsScreenshot();
    return this.macosScreenshot();
  }

  async screenSize(): Promise<ScreenSize> {
    if (this.backend === "x11") return this.x11ScreenSize();
    if (this.backend === "windows") return this.windowsScreenSize();
    return this.macosScreenSize();
  }

  async move(x: number, y: number): Promise<void> {
    x = validateCoord(x, "x");
    y = validateCoord(y, "y");
    if (this.backend === "x11") {
      await this.x11Run(["xdotool", "mousemove", String(x), String(y)]);
    } else if (this.backend === "windows") {
      await this.windowsMove(x, y);
    } else {
      await this.macosMove(x, y);
    }
  }

  async click(x: number, y: number, button = "left"): Promise<void> {
    x = validateCoord(x, "x");
    y = validateCoord(y, "y");
    button = validateButton(button);
    if (this.backend === "x11") {
      await this.x11Run([
        "xdotool", "mousemove", String(x), String(y),
        "click", XDOTOOL_BUTTONS[button],
      ]);
    } else if (this.backend === "windows") {
      await this.windowsClick(x, y, button);
    } else {
      await this.macosClick(x, y, button);
    }
  }

  async typeText(text: string): Promise<void> {
    if (typeof text !== "string") {
      throw new ComputerError("要输入的文本必须是字符串");
    }
    if (text === "") return; // 空串是 no-op，与 Python 一致。
    if (this.backend === "x11") {
      await this.x11Run(["xdotool", "type", "--clearmodifiers", "--", text]);
    } else if (this.backend === "windows") {
      await this.windowsTypeText(text);
    } else {
      await this.macosTypeText(text);
    }
  }

  async press(key: string): Promise<void> {
    const { mods, base } = normalizeKey(key);
    if (this.backend === "x11") {
      const combo = [
        ...mods.map((m) => XDOTOOL_KEYS[m] ?? m),
        XDOTOOL_KEYS[base] ?? base,
      ].join("+");
      await this.x11Run(["xdotool", "key", combo]);
    } else if (this.backend === "windows") {
      await this.windowsPress(mods, base);
    } else {
      await this.macosPress(mods, base);
    }
  }

  async windows(): Promise<WindowInfo[]> {
    if (this.backend === "x11") return this.x11Windows();
    if (this.backend === "windows") return this.windowsWindows();
    return this.macosWindows();
  }

  /**
   * 当前前台窗口（id + 标题）；拿不到时返回 null（没有前台窗口、
   * 后端报不出来，都算 null，调用方按“前台未知”处理，不抛错）。
   * 守卫层（computerGuard.ts）用它拦禁碰窗口。
   */
  async activeWindow(): Promise<WindowInfo | null> {
    if (this.backend === "x11") return this.x11ActiveWindow();
    if (this.backend === "windows") return this.windowsActiveWindow();
    return this.macosActiveWindow();
  }

  // ---- 内部：带超时的命令执行 ----

  private async run(
    argv: string[],
    timeoutMs: number,
  ): Promise<CommandResult> {
    let result: CommandResult;
    try {
      result = await withTimeout(
        this.runner(argv, { timeoutMs }),
        timeoutMs,
      );
    } catch (err) {
      if (err instanceof CommandTimeoutError) throw err;
      throw new ComputerError(
        `运行桌面命令失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return result;
  }

  // ---- Linux/X11 后端 ----

  private requireDisplay(): void {
    if (!this.env.DISPLAY) {
      throw new ComputerError(
        "没有桌面会话（DISPLAY 未设置）。请先在图形桌面里运行，"
        + "或用 Xvfb 起一个虚拟桌面再设 DISPLAY。",
      );
    }
  }

  private requireXdotool(): void {
    if (this.whichFn("xdotool") === null) {
      throw new ComputerError(
        "找不到 xdotool（Linux 桌面控制靠它）。请先安装："
        + "Debian/Ubuntu 用 sudo apt-get install xdotool，"
        + "Fedora 用 sudo dnf install xdotool。",
      );
    }
  }

  private async x11Run(
    argv: string[],
    timeoutMs = this.commandTimeoutMs,
  ): Promise<Buffer> {
    this.requireDisplay();
    this.requireXdotool();
    let result: CommandResult;
    try {
      result = await this.run(argv, timeoutMs);
    } catch (err) {
      if (err instanceof CommandTimeoutError) {
        throw new ComputerError(`桌面命令超时：${argv.join(" ")}`);
      }
      throw err;
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim();
      let message =
        `桌面命令失败（退出码 ${String(result.code)}）：${argv.join(" ")}`;
      if (detail) message += `：${detail}`;
      throw new ComputerError(message);
    }
    return result.stdout;
  }

  private async x11ScreenSize(): Promise<ScreenSize> {
    const out = await this.x11Run(["xdotool", "getdisplaygeometry"]);
    const parts = out.toString("utf-8").split(/\s+/).filter(Boolean);
    if (parts.length !== 2) {
      throw new ComputerError(
        `读屏幕尺寸失败，xdotool 输出无法解析：${pyRepr(out.subarray(0, 100).toString("utf-8"))}`,
      );
    }
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isInteger(w) || !Number.isInteger(h)) {
      throw new ComputerError(
        `读屏幕尺寸失败，xdotool 输出无法解析：${pyRepr(out.subarray(0, 100).toString("utf-8"))}`,
      );
    }
    return { width: w, height: h };
  }

  private async x11Windows(): Promise<WindowInfo[]> {
    const out = await this.x11Run([
      "xdotool", "search", "--onlyvisible", "--name", ".",
    ]);
    const found: WindowInfo[] = [];
    for (const line of out.toString("utf-8").split("\n")) {
      const wid = line.trim();
      if (!wid) continue;
      try {
        const title = (await this.x11Run(["xdotool", "getwindowname", wid]))
          .toString("utf-8").trim();
        const geom = (await this.x11Run([
          "xdotool", "getwindowgeometry", "--shell", wid,
        ])).toString("utf-8");
        const fields: Record<string, number> = {};
        for (const gline of geom.split("\n")) {
          if (!gline.includes("=")) continue;
          const [name, value] = gline.split("=", 2);
          const n = Number(value.trim());
          if (Number.isInteger(n)) fields[name.trim()] = n;
        }
        const item: WindowInfo = { id: wid, title };
        if ("X" in fields) item.x = fields["X"];
        if ("Y" in fields) item.y = fields["Y"];
        if ("WIDTH" in fields) item.width = fields["WIDTH"];
        if ("HEIGHT" in fields) item.height = fields["HEIGHT"];
        found.push(item);
      } catch {
        // 单个窗口读不到就跳过，与 Python 的 continue 一致。
        continue;
      }
    }
    return found;
  }

  private async x11ActiveWindow(): Promise<WindowInfo | null> {
    let id: string;
    try {
      id = (await this.x11Run(["xdotool", "getactivewindow"])).toString("utf-8").trim();
    } catch {
      return null;
    }
    if (!id) return null;
    let title = "";
    try {
      title = (await this.x11Run(["xdotool", "getwindowname", id])).toString("utf-8").trim();
    } catch {
      // 标题读不到也认这个窗口（标题空着，守卫按未知处理）。
    }
    return { id, title };
  }

  private async x11Screenshot(): Promise<Buffer> {
    this.requireDisplay();
    const tried: string[] = [];
    const attempts: Array<[string, string[]]> = [
      ["import", ["import", "-window", "root", "png:-"]],
      ["scrot", ["scrot", "-o", "-"]],
      ["gnome-screenshot", ["gnome-screenshot", "-f", "-"]],
    ];
    for (const [tool, argv] of attempts) {
      if (this.whichFn(tool) === null) {
        tried.push(`${tool}（未安装）`);
        continue;
      }
      let result: CommandResult;
      try {
        result = await this.run(argv, this.screenshotTimeoutMs);
      } catch {
        tried.push(`${tool}（运行失败）`);
        continue;
      }
      if (result.code === 0 && result.stdout.subarray(0, 8).equals(PNG_MAGIC)) {
        return result.stdout;
      }
      tried.push(`${tool}（未返回有效 PNG）`);
    }
    throw new ComputerError(
      "截屏需要 ImageMagick（import）、scrot 或 gnome-screenshot，"
      + "三个都不可用：" + tried.join("；")
      + "。请先装其中一个再试。",
    );
  }

  // ---- macOS 后端 ----

  private async macosRun(
    lines: string[],
    timeoutMs = this.commandTimeoutMs,
  ): Promise<string> {
    const argv: string[] = ["osascript"];
    for (const line of lines) argv.push("-e", line);
    let result: CommandResult;
    try {
      result = await this.run(argv, timeoutMs);
    } catch (err) {
      if (err instanceof CommandTimeoutError) {
        throw new ComputerError("macOS 桌面命令超时：osascript");
      }
      throw new ComputerError(
        `运行 osascript 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim();
      let message = `osascript 失败（退出码 ${String(result.code)}）`;
      if (detail) message += `：${detail}`;
      throw new ComputerError(message);
    }
    return result.stdout.toString("utf-8");
  }

  private async macosScreenSize(): Promise<ScreenSize> {
    const out = await this.macosRun([
      'tell application "Finder" to get bounds of window of desktop',
    ]);
    const nums = parseBracedNumbers(out);
    if (nums.length !== 4) {
      throw new ComputerError(
        `读屏幕尺寸失败，Finder 返回无法解析：${pyRepr(out.slice(0, 100))}`,
      );
    }
    return { width: nums[2] - nums[0], height: nums[3] - nums[1] };
  }

  private async macosMove(x: number, y: number): Promise<void> {
    const point = `{${x}, ${y}}`;
    await this.macosRun([
      'use framework "CoreGraphics"',
      "set mouseEvent to current application's "
        + `CGEventCreateMouseEvent(missing value, 1, ${point}, 0)`,
      "current application's CGEventPost(0, mouseEvent)",
    ]);
  }

  private async macosClick(x: number, y: number, button: string): Promise<void> {
    const [down, up, btn] = {
      left: [2, 3, 0],
      middle: [6, 7, 2],
      right: [4, 5, 1],
    }[button] as [number, number, number];
    const point = `{${x}, ${y}}`;
    await this.macosRun([
      'use framework "CoreGraphics"',
      "set downEvent to current application's "
        + `CGEventCreateMouseEvent(missing value, ${down}, ${point}, ${btn})`,
      "set upEvent to current application's "
        + `CGEventCreateMouseEvent(missing value, ${up}, ${point}, ${btn})`,
      "current application's CGEventPost(0, downEvent)",
      "current application's CGEventPost(0, upEvent)",
    ]);
  }

  private async macosTypeText(text: string): Promise<void> {
    await this.macosRun([
      `tell application "System Events" to keystroke ${applescriptQuote(text)}`,
    ]);
  }

  private async macosPress(mods: string[], base: string): Promise<void> {
    const code = MAC_KEY_CODES[base];
    if (code === undefined) {
      throw new ComputerError(`macOS 不支持这个按键：${pyRepr(base)}`);
    }
    let using = "";
    if (mods.length > 0) {
      const names = mods.map((m) => MAC_MODIFIERS[m]);
      using = ` using {${names.map((n) => `${n} down`).join(", ")}}`;
    }
    await this.macosRun([
      `tell application "System Events" to key code ${code}${using}`,
    ]);
  }

  private async macosWindows(): Promise<WindowInfo[]> {
    const out = await this.macosRun([
      'tell application "System Events"',
      'set out to ""',
      "repeat with p in (every process whose visible is true)",
      "repeat with w in (every window of p)",
      'set out to out & (name of w) & "|" & (position of w as string)'
        + ' & "|" & (size of w as string) & "|" & (id of w as string) & return',
      "end repeat",
      "end repeat",
      "return out",
      "end tell",
    ]);
    const found: WindowInfo[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      // 从右往左切 3 次：标题里可能含 "|"。
      const parts: string[] = [];
      let rest = line;
      for (let i = 0; i < 3; i++) {
        const idx = rest.lastIndexOf("|");
        if (idx === -1) break;
        parts.unshift(rest.slice(idx + 1));
        rest = rest.slice(0, idx);
      }
      if (parts.length !== 3) continue;
      const [pos, size, wid] = parts;
      const title = rest;
      const xy = parseBracedNumbers(pos);
      const wh = parseBracedNumbers(size);
      const item: WindowInfo = { id: wid.trim(), title };
      if (xy.length === 2) {
        item.x = xy[0];
        item.y = xy[1];
      }
      if (wh.length === 2) {
        item.width = wh[0];
        item.height = wh[1];
      }
      found.push(item);
    }
    return found;
  }

  private async macosActiveWindow(): Promise<WindowInfo | null> {
    let out: string;
    try {
      out = await this.macosRun([
        'tell application "System Events"',
        "set p to first application process whose frontmost is true",
        "try",
        'return (name of p) & "|" & (name of window 1 of p)',
        "on error",
        'return (name of p) & "|"',
        "end try",
        "end tell",
      ]);
    } catch {
      return null;
    }
    const idx = out.indexOf("|");
    if (idx === -1) return null;
    const app = out.slice(0, idx).trim();
    const title = out.slice(idx + 1).trim();
    if (!app) return null;
    return { id: app, title: title || app };
  }

  private async macosScreenshot(): Promise<Buffer> {
    const dir = mkdtempSync(joinPath(tmpdir(), "nyra-screenshot-"));
    const file = joinPath(dir, "screenshot.png");
    try {
      let result: CommandResult;
      try {
        result = await this.run(
          ["screencapture", "-x", "-t", "png", file],
          this.screenshotTimeoutMs,
        );
      } catch (err) {
        if (err instanceof CommandTimeoutError) {
          throw new ComputerError("macOS 截屏超时");
        }
        throw new ComputerError(
          `运行 screencapture 失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (result.code !== 0) {
        const detail = result.stderr.trim();
        let message = `screencapture 失败（退出码 ${String(result.code)}）`;
        if (detail) message += `：${detail}`;
        throw new ComputerError(message);
      }
      let data: Buffer;
      try {
        data = this.readFileFn(file);
      } catch (err) {
        throw new ComputerError(
          `screencapture 没写出截图文件：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return checkPng(data, "screencapture");
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 临时目录删不掉不影响结果。
      }
    }
  }

  // ---- Windows 后端（PowerShell + Add-Type user32 / System.Drawing） ----
  //
  // Python 版是 ctypes 直调 user32.dll / gdi32.dll；Node 没有 ctypes，
  // 所以每个动作都起一次 powershell.exe（-NoProfile -NonInteractive
  // -Command），在脚本里 Add-Type 编译一段 C#（P/Invoke + SendInput
  // 的 INPUT 联合体），再调它。坐标/按键码在 TS 里先校验过再拼进
  // 脚本；文本一律走 base64 参数传，不拼进脚本字符串，防注入。

  private async windowsRun(
    scriptLines: string[],
    args: string[] = [],
    timeoutMs = this.commandTimeoutMs,
  ): Promise<string> {
    const script = scriptLines.join("\n");
    const argv = [
      "powershell", "-NoProfile", "-NonInteractive",
      "-Command", script, ...args,
    ];
    let result: CommandResult;
    try {
      result = await this.run(argv, timeoutMs);
    } catch (err) {
      if (err instanceof CommandTimeoutError) {
        throw new ComputerError("Windows 命令超时：powershell");
      }
      throw err;
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim();
      let message = `Windows 命令失败（退出码 ${String(result.code)}）：powershell`;
      if (detail) message += `：${detail}`;
      throw new ComputerError(message);
    }
    return result.stdout.toString("utf-8");
  }

  /** 所有 Windows 脚本共用的 Add-Type 前导：user32 + SendInput 联合体。 */
  private windowsPreamble(): string[] {
    return [
      "$code = @'",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public struct NyraRECT { public int Left; public int Top; public int Right; public int Bottom; }",
      "[StructLayout(LayoutKind.Sequential)] public struct NyraMOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }",
      "[StructLayout(LayoutKind.Sequential)] public struct NyraKEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }",
      "[StructLayout(LayoutKind.Sequential)] public struct NyraHARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }",
      "[StructLayout(LayoutKind.Explicit)] public struct NyraINPUTUNION { [FieldOffset(0)] public NyraMOUSEINPUT mi; [FieldOffset(0)] public NyraKEYBDINPUT ki; [FieldOffset(0)] public NyraHARDWAREINPUT hi; }",
      "[StructLayout(LayoutKind.Sequential)] public struct NyraINPUT { public uint type; public NyraINPUTUNION u; }",
      "public static class NyraWin32 {",
      '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
      '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);',
      '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
      '  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);',
      '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out NyraRECT lpRect);',
      '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);',
      '  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, NyraINPUT[] pInputs, int cbSize);',
      "  public static void TypeText(string text) {",
      "    NyraINPUT[] inputs = new NyraINPUT[text.Length * 2];",
      "    for (int i = 0; i < text.Length; i++) {",
      "      char c = text[i];",
      "      inputs[i*2].type = 1; inputs[i*2].u.ki.wVk = 0; inputs[i*2].u.ki.wScan = c; inputs[i*2].u.ki.dwFlags = 0x0004; inputs[i*2].u.ki.time = 0;",
      "      inputs[i*2+1].type = 1; inputs[i*2+1].u.ki.wVk = 0; inputs[i*2+1].u.ki.wScan = c; inputs[i*2+1].u.ki.dwFlags = 0x0006; inputs[i*2+1].u.ki.time = 0;",
      "    }",
      "    if (inputs.Length == 0) return;",
      "    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(NyraINPUT)));",
      '    if (sent != inputs.Length) throw new Exception("Windows 输入失败：只发出了 " + sent + "/" + inputs.Length + " 个按键事件");',
      "  }",
      "}",
      "'@",
      "Add-Type -TypeDefinition $code",
    ];
  }

  private async windowsScreenSize(): Promise<ScreenSize> {
    const out = await this.windowsRun([
      ...this.windowsPreamble(),
      '"$([NyraWin32]::GetSystemMetrics(0)) $([NyraWin32]::GetSystemMetrics(1))"',
    ]);
    const parts = out.trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 2) {
      throw new ComputerError(
        `读屏幕尺寸失败，PowerShell 输出无法解析：${pyRepr(out.slice(0, 100))}`,
      );
    }
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isInteger(w) || !Number.isInteger(h)) {
      throw new ComputerError(
        `读屏幕尺寸失败，PowerShell 输出无法解析：${pyRepr(out.slice(0, 100))}`,
      );
    }
    return { width: w, height: h };
  }

  private async windowsMove(x: number, y: number): Promise<void> {
    await this.windowsRun([
      ...this.windowsPreamble(),
      `if (-not [NyraWin32]::SetCursorPos(${x}, ${y})) { throw "Windows 移动鼠标失败" }`,
    ]);
  }

  private async windowsClick(x: number, y: number, button: string): Promise<void> {
    const [down, up] = WIN_MOUSE_EVENTS[button];
    await this.windowsRun([
      ...this.windowsPreamble(),
      `if (-not [NyraWin32]::SetCursorPos(${x}, ${y})) { throw "Windows 移动鼠标失败" }`,
      `[NyraWin32]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)`,
      "Start-Sleep -Milliseconds 50",
      `[NyraWin32]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)`,
    ]);
  }

  private async windowsTypeText(text: string): Promise<void> {
    const b64 = Buffer.from(text, "utf-16le").toString("base64");
    await this.windowsRun([
      ...this.windowsPreamble(),
      "$text = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String($args[0]))",
      "[NyraWin32]::TypeText($text)",
    ], [b64]);
  }

  private async windowsPress(mods: string[], base: string): Promise<void> {
    const vk = windowsVirtualKey(base);
    const modVks = mods.map((m) => windowsVirtualKey(m));
    const lines: string[] = [...this.windowsPreamble()];
    for (const code of modVks) {
      lines.push(`[NyraWin32]::keybd_event(${code}, 0, 0, [UIntPtr]::Zero)`);
    }
    lines.push(`[NyraWin32]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero)`);
    lines.push(`[NyraWin32]::keybd_event(${vk}, 0, 2, [UIntPtr]::Zero)`);
    for (const code of [...modVks].reverse()) {
      lines.push(`[NyraWin32]::keybd_event(${code}, 0, 2, [UIntPtr]::Zero)`);
    }
    await this.windowsRun(lines);
  }

  private async windowsWindows(): Promise<WindowInfo[]> {
    const out = await this.windowsRun([
      ...this.windowsPreamble(),
      "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {",
      "  $rect = New-Object NyraRECT",
      "  if (-not [NyraWin32]::GetWindowRect($_.MainWindowHandle, [ref]$rect)) { return }",
      "  $titleB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.MainWindowTitle))",
      '  "$($_.MainWindowHandle)|$titleB64|$($rect.Left)|$($rect.Top)|$($rect.Right - $rect.Left)|$($rect.Bottom - $rect.Top)"',
      "}",
    ]);
    const found: WindowInfo[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.trim().split("|");
      if (parts.length !== 6) continue;
      const [id, titleB64, x, y, w, h] = parts;
      let title = "";
      try {
        title = Buffer.from(titleB64, "base64").toString("utf-8");
      } catch {
        continue;
      }
      const nums = [x, y, w, h].map(Number);
      if (nums.some((n) => !Number.isInteger(n))) continue;
      found.push({
        id,
        title,
        x: nums[0],
        y: nums[1],
        width: nums[2],
        height: nums[3],
      });
    }
    return found;
  }

  private async windowsActiveWindow(): Promise<WindowInfo | null> {
    const out = await this.windowsRun([
      ...this.windowsPreamble(),
      "$hwnd = [NyraWin32]::GetForegroundWindow()",
      "$sb = New-Object System.Text.StringBuilder(512)",
      "[NyraWin32]::GetWindowText($hwnd, $sb, 512) | Out-Null",
      "\"$hwnd|\" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sb.ToString()))",
    ]);
    const line = out.trim();
    const idx = line.indexOf("|");
    if (idx === -1) return null;
    const id = line.slice(0, idx).trim();
    if (!id || id === "0") return null;
    let title = "";
    try {
      title = Buffer.from(line.slice(idx + 1).trim(), "base64").toString("utf-8");
    } catch {
      return null;
    }
    return { id, title };
  }

  private async windowsScreenshot(): Promise<Buffer> {
    const out = await this.windowsRun([
      ...this.windowsPreamble(),
      "Add-Type -AssemblyName System.Drawing",
      "$w = [NyraWin32]::GetSystemMetrics(0); $h = [NyraWin32]::GetSystemMetrics(1)",
      "$bmp = New-Object System.Drawing.Bitmap($w, $h)",
      "$g = [System.Drawing.Graphics]::FromImage($bmp)",
      "$g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)",
      "$ms = New-Object System.IO.MemoryStream",
      "$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
      "[Convert]::ToBase64String($ms.ToArray())",
    ], [], this.screenshotTimeoutMs);
    const b64 = out.trim();
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
      throw new ComputerError("Windows 截屏没有返回有效的 PNG 数据");
    }
    const data = Buffer.from(b64, "base64");
    return checkPng(data, "Windows 截屏");
  }
}
