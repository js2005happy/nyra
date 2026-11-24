// src/wizard.ts — 首次启动向导（中文，三步到第一个任务）。
// 第 1 步：选模型来源（15 个 provider + 本地 Ollama / Codex，二选一的本地项排在前面）。
// 第 2 步：填 Key 或选本地。Key 绝不写进 config.json（与 Python 版一致）：
//   已在环境变量里的 Key 直接认；rc 里已有的 Key 只显示后 4 位，密码箱可用时
//   问要不要迁入密码箱；新填的 Key 用掩码输入（屏幕上只显示 *），
//   密码箱可用时默认存密码箱（只问一句），否则才问要不要追加进 shell rc；
//   追加进 rc 后 chmod 600（POSIX）。Key 确认行只显示后 4 位。
// 第 3 步：跑一条本地示例任务（不调模型、无 Key 也能跑通）。
// 有 Key 时向导只保存配置，不强制跑模型任务（agent 核心在第 2 阶段移植）。
import { createInterface } from "node:readline";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDERS, lookupPreset, saveConfig, type ProviderPreset, type ResolvedProvider } from "./config.ts";
import { runExampleTask } from "./exampleTask.ts";
import { Vault } from "./vault.ts";

export interface WizardResult {
  provider: string;
  model: string;
  keyConfigured: boolean;
  exampleOk: boolean;
}

const LOCAL_FIRST = ["ollama", "codex"];

/** 向导里的 provider 顺序：本地项在前，内置 15 个，末尾跟用户自定义的。 */
export function providerOrder(config: Record<string, unknown>): string[] {
  const customNames = Object.keys((config.custom_providers as Record<string, unknown>) || {})
    .filter((n) => !PROVIDERS[n]);
  return [...LOCAL_FIRST, ...Object.keys(PROVIDERS).filter((n) => !LOCAL_FIRST.includes(n) && n !== "custom"), "custom", ...customNames];
}

/**
 * 逐行提问：用 'line' 事件 + 队列实现，而不是 rl.question()。
 * 原因：管道输入时所有行会瞬间到齐，rl.question() 只在提问瞬间挂监听，
 * 还没问到的行会被当成无人收听的 'line' 事件丢掉（实测：第 3 个回答丢失）。
 * 队列做法交互终端与管道输入都对：行先到就排队，问题先到就等下一行；
 * 输入关掉（EOF）且队列空时当作空回答继续走，不挂住。
 */
export function createAsker(rl: ReturnType<typeof createInterface>): {
  ask: (question: string) => Promise<string>;
  closed: () => boolean;
} {
  const queue: string[] = [];
  const waiters: ((value: string) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const value = line.trim();
    if (waiters.length > 0) waiters.shift()!(value);
    else queue.push(value);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()!("");
  });
  return {
    ask(question: string): Promise<string> {
      (rl as unknown as { output: NodeJS.WriteStream }).output.write(question);
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      if (closed) return Promise.resolve("");
      return new Promise((resolve) => waiters.push(resolve));
    },
    closed: () => closed,
  };
}

/** 用户 shell rc 文件（bash/zsh），追加 export 行时用；找不到就返回 null。 */
export function detectShellRc(): string | null {
  const shell = process.env.SHELL || "";
  const userHome = process.env.HOME || homedir();
  const candidates = shell.includes("zsh")
    ? [".zshrc", ".bashrc"]
    : [".bashrc", ".zshrc"];
  for (const name of candidates) {
    const p = join(userHome, name);
    if (existsSync(p)) return p;
  }
  return join(userHome, candidates[0]);
}

/** Key 只显示后 4 位（审查报告第 10 项）：确认行、日志里都不出现完整 Key。 */
export function maskKey(key: string): string {
  if (!key) return "****";
  if (key.length <= 4) return "****";
  return `****${key.slice(-4)}`;
}

/** rc 文件里找某个 envKey 的 export 行（有多个以最后一行为准），找不到返回 null。 */
export function findRcKey(rcPath: string | null, envKey: string): string | null {
  if (!rcPath || !existsSync(rcPath)) return null;
  try {
    const lines = readFileSync(rcPath, "utf-8").split("\n");
    let found: string | null = null;
    for (const line of lines) {
      const m = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m || m[1] !== envKey) continue;
      let value = m[2].trim();
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }
      found = value;
    }
    return found;
  } catch {
    return null;
  }
}

/** 删掉 rc 里某个 envKey 的全部 export 行（迁入密码箱后用），其余行不动。 */
export function removeRcKey(rcPath: string, envKey: string): boolean {
  try {
    const lines = readFileSync(rcPath, "utf-8").split("\n");
    const kept = lines.filter((line) => {
      const m = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      return !(m && m[1] === envKey);
    });
    if (kept.length === lines.length) return false;
    writeFileSync(rcPath, kept.join("\n"), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** 密码箱能用时返回已解锁的 Vault，否则 null（没创建、或没设 NYRA_VAULT_PASSWORD、或密码不对）。 */
export function tryUnlockVault(home: string): Vault | null {
  try {
    const password = process.env.NYRA_VAULT_PASSWORD;
    if (!password) return null;
    const vault = new Vault(join(home, "vault.json"));
    if (!vault.exists() || !vault.unlock(password)) return null;
    return vault;
  } catch {
    return null;
  }
}

/**
 * 掩码读密钥（审查报告第 10 项）：终端上逐字回显 `*`，退格与 Ctrl-C 都有处理；
 * 不是终端（管道输入、测试）时回退到普通行读——回显与否对管道没有意义，
 * 测试走的也是这条路。调用方注意：readline 与 raw-mode 不能共用同一条 stdin，
 * 终端上读 Key 前要先关掉 asker 的 rl（runWizard 里就是这么做的）。
 */
export async function readSecret(
  prompt: string,
  fallbackAsk?: (question: string) => Promise<string>,
  input: NodeJS.ReadStream = process.stdin as NodeJS.ReadStream,
  output: NodeJS.WriteStream = process.stdout as NodeJS.WriteStream,
): Promise<string> {
  if (!input.isTTY || typeof (input as NodeJS.ReadStream).setRawMode !== "function") {
    if (!fallbackAsk) throw new Error("非终端输入需要提供 fallbackAsk");
    return (await fallbackAsk(prompt)).trim();
  }
  const stream = input as NodeJS.ReadStream;
  output.write(prompt);
  stream.setRawMode(true);
  return new Promise<string>((resolvePromise, reject) => {
    let value = "";
    const cleanup = (): void => {
      stream.removeListener("data", onData);
      try { stream.setRawMode(false); } catch { /* ignore */ }
    };
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf-8")) {
        if (ch === "\n" || ch === "\r") {
          cleanup();
          output.write("\n");
          resolvePromise(value);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl-C：恢复终端状态后取消。
          cleanup();
          output.write("\n");
          reject(new Error("已取消"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        value += ch;
        output.write("*");
      }
    };
    stream.on("data", onData);
  });
}

export async function runWizard(opts: {
  home: string;
  provider: ResolvedProvider;
  config: Record<string, unknown>;
  exampleFile: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<WizardResult> {
  const rl = createInterface({ input: opts.input ?? process.stdin, output: opts.output ?? process.stdout });
  const { ask } = createAsker(rl);
  try {
    console.log("欢迎使用 Nyra！三步就能跑起第一个任务。");
    console.log("（全程不注册、不登录；模型只用你自己的 Key，本地任务不花钱。）");
    console.log("");

    // 第 1 步：选模型来源
    console.log("第 1 步：选模型来源");
    const order = providerOrder(opts.config);
    order.forEach((name, i) => {
      const p: ProviderPreset | undefined = lookupPreset(opts.config, name);
      const tag = name === "ollama" ? "（本地模型，不用 Key）"
        : name === "codex" ? "（复用本机 Codex 登录，不用 Key）"
        : name === "custom" ? "（自己配 endpoint）"
        : !p ? "（自定义 provider）"
        : `（默认模型 ${p.defaultModel}）`;
      console.log(`  ${i + 1}）${name} ${tag}`);
    });
    const defIdx = order.indexOf(opts.provider.name);
    const choice = await ask(`输入编号（默认 ${defIdx >= 0 ? defIdx + 1 : "（当前 " + opts.provider.name + "）"}，${opts.provider.name}）：`);
    let providerName = opts.provider.name;
    if (choice) {
      const n = Number(choice);
      if (Number.isInteger(n) && n >= 1 && n <= order.length) providerName = order[n - 1];
      else if (lookupPreset(opts.config, choice)) providerName = choice;
      else console.log(`看不懂“${choice}”，用默认的 ${providerName}。`);
    }
    const preset = lookupPreset(opts.config, providerName) ?? { baseUrl: null, defaultModel: null, envKey: "NYRA_API_KEY", connector: null, allowedHosts: [], models: [] };
    let model = preset.defaultModel || "";
    if (preset.models.length > 1) {
      const m = await ask(`模型（${preset.models.join(" / ")}，默认 ${model}）：`);
      if (m) model = m;
    } else if (preset.defaultModel === null) {
      model = await ask("模型名（custom provider 需要手动填）：");
    }
    console.log(`已选：${providerName} / ${model}`);
    console.log("");

    // 第 2 步：填 Key 或选本地
    console.log("第 2 步：配置 Key");
    let keyConfigured = false;
    if (providerName === "ollama" || providerName === "codex") {
      console.log(providerName === "ollama"
        ? "Ollama 是本地模型，不用 Key。请确认本机装好并启动了 Ollama（默认 http://localhost:11434）。"
        : "Codex 复用本机 Codex CLI 的登录态，不用 Key。请确认已在本机运行 codex 登录。");
      keyConfigured = true;
    } else if (preset.envKey && process.env[preset.envKey]) {
      console.log(`检测到环境变量 ${preset.envKey} 已有 Key（${maskKey(process.env[preset.envKey] as string)}），不用再填。`);
      keyConfigured = true;
    } else if (preset.envKey) {
      const rc = detectShellRc();
      const rcKey = findRcKey(rc, preset.envKey);
      if (rcKey) {
        // rc 里已有 Key：只显示后 4 位，密码箱可用时问要不要迁进去。
        console.log(`检测到 ${rc} 里已有 ${preset.envKey} 的 Key（${maskKey(rcKey)}）。`);
        const vault = tryUnlockVault(opts.home);
        if (vault) {
          const migrate = await ask("要把它迁入密码箱吗？（迁完删掉 rc 里那行；输入 y 迁移，默认不迁）：");
          if (/^(y|yes|是)$/i.test(migrate)) {
            vault.add(preset.envKey, rcKey, true);
            if (rc) removeRcKey(rc, preset.envKey);
            console.log("已迁入密码箱，rc 里那行已删掉。");
          } else {
            console.log("保持 rc 不动。");
          }
        } else {
          console.log("密码箱未解锁（未创建或未设 NYRA_VAULT_PASSWORD），先保持 rc 不动；设好密码箱后重跑向导可迁移。");
        }
        keyConfigured = true;
      } else {
        // 还没有 Key：先问存哪（密码箱是默认项），再掩码读 Key。读 Key 是最后一步，
        // 因为终端上掩码输入要先关掉 asker 的 readline（两者不能共用同一条 stdin）。
        const vault = tryUnlockVault(opts.home);
        let storeInVault = false;
        let appendRc = false;
        if (vault) {
          const c = await ask(`新 Key 存到哪里？（1 密码箱，默认；2 追加进 ${rc}）：`);
          if (c.trim() === "2") appendRc = true;
          else storeInVault = true;
        } else {
          const answer = await ask(`要把 export ${preset.envKey}=... 追加进 ${rc} 吗？（以后打开终端自动生效；输入 y 才追加，默认不追加）：`);
          appendRc = /^(y|yes|是)$/i.test(answer);
        }
        console.log("输入 Key 时屏幕上只显示 *，输完请清屏，不要截图分享。");
        const inputStream = (opts.input ?? process.stdin) as NodeJS.ReadStream;
        if (inputStream.isTTY) rl.close();
        const key = await readSecret(
          `输入 ${preset.envKey}（直接回车跳过，稍后再设）：`,
          ask,
          inputStream,
          (opts.output ?? process.stdout) as NodeJS.WriteStream,
        );
        if (key) {
          if (storeInVault && vault) {
            vault.add(preset.envKey, key, true);
            console.log(`已存进密码箱（${maskKey(key)}），下次启动自动生效。`);
            keyConfigured = true;
          } else if (appendRc) {
            if (rc) {
              appendFileSync(rc, `\n# Nyra（nyra setup 写入）\nexport ${preset.envKey}=${key}\n`, "utf-8");
              if (process.platform !== "win32") {
                try { chmodSync(rc, 0o600); } catch { /* ignore */ }
              }
            }
            console.log(`已追加进 ${rc}（${maskKey(key)}）。重新打开终端后生效；本次请先跑：export ${preset.envKey}=你的Key`);
            keyConfigured = false; // 本进程环境变量还没变，实话实说
          } else {
            console.log(`没写进任何文件。请自己跑：export ${preset.envKey}=你的Key（只对当前终端生效）`);
            keyConfigured = false;
          }
        } else {
          console.log("跳过了 Key 设置。没有 Key 也能先跑本地示例任务，模型任务等设好 Key 再跑。");
        }
      }
    }
    // 只保存 provider / model 到 config.json，Key 绝不落盘。
    saveConfig(opts.home, { provider: providerName, model });
    console.log(`配置已保存到 ${join(opts.home, "config.json")}（只含 provider / model，不含 Key）。`);
    console.log("");

    // 第 3 步：跑一条本地示例任务
    console.log("第 3 步：跑一条示例任务（本地任务，不调模型、不花钱）");
    let exampleOk = false;
    try {
      const result = runExampleTask({ home: opts.home, provider: providerName, model, file: opts.exampleFile });
      exampleOk = result.rows === 100;
    } catch (err) {
      console.log(`示例任务没跑起来：${err instanceof Error ? err.message : String(err)}`);
    }
    console.log("");
    if (exampleOk) {
      console.log("向导完成：刚才跑的是本地示例任务（不调模型、不花钱），还不是模型任务。");
      console.log("下一步：跑模型任务前，先确认 Key 已设好（本地模型先确认已启动）；没把握就先跑 nyra doctor 看看缺什么，或跑 nyra --example 再练一次。");
    } else {
      console.log("示例任务没跑通，按上面的报错处理，或跑 nyra doctor 自检。");
    }
    return { provider: providerName, model, keyConfigured, exampleOk };
  } finally {
    rl.close();
  }
}

/** 向导的默认示例文件：优先读本机真实存在的文件，不存在就用 config.json 自己。 */
export function defaultExampleFile(home: string): string {
  const candidates = [join(home, "config.json"), "README.md", "GUIDE.md"];
  for (const c of candidates) {
    try {
      if (existsSync(c) && readFileSync(c, "utf-8").length > 0) return c;
    } catch { /* 继续找下一个 */ }
  }
  return join(home, "config.json");
}
