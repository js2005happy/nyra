// src/eval/apiProvider.ts — 评测用的 DeepSeek API 通道（整合者增补，非 Codex 原设计）。
//
// 第一批架子只支持本地 Ollama；用户 2026-11-22 点选用 API 模型跑一轮基线，
// 这里加一条显式、可审计的 API 通道，默认仍是本地。
// 凭据不出连接器：本模块只 spawn 连接器助手脚本 deepseek.py，Key 由运行时
// 仅对 api.deepseek.com 的请求换成真值；本模块不读、不存、不打 Key，
// 不把 Key 写进 env、文件、日志、命令参数。
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cancelErrorFromSignal } from "../cancel.ts";
import {
  normalizeMessages,
  type ChatMessage,
  type ProviderLike,
} from "../providers.ts";

/** DeepSeek 峰时价（每百万 token，2026-11-20 查证）：评测记账只用这张表。 */
export const DEEPSEEK_EVAL_PRICING: Record<
  string,
  { inputPer1M: number; outputPer1M: number }
> = {
  "deepseek-flash": { inputPer1M: 0.3, outputPer1M: 1.2 },
  "deepseek-v4-pro": { inputPer1M: 1.32, outputPer1M: 3.96 },
};

export function resolveDeepSeekEvalPricing(
  model: string,
): { inputPer1M: number; outputPer1M: number } | null {
  return DEEPSEEK_EVAL_PRICING[model] ?? null;
}

/** 助手脚本路径：只在父进程（scripts/eval.ts）解析；worker 里 HOME 是
 *  一次性目录，绝不能在 worker 里再解析一次——路径由父进程经 ctx 传进去。 */
export function resolveDeepSeekHelperPath(): string {
  const fromEnv = process.env.NYRA_EVAL_DEEPSEEK_HELPER;
  if (fromEnv) return fromEnv;
  return join(
    homedir(),
    "workspace/custom-connectors/custom.deepseek/bin/deepseek.py",
  );
}

/** 经连接器助手脚本调 DeepSeek 的 ProviderLike：stdout 的 OpenAI 响应
 *  原样返回（含 usage，Agent 的成本记账靠它）；stderr 只在抛错时截一段，
 *  助手不打印凭据，但即便如此也不把 stderr 写进评测事件。 */
export class DeepSeekConnectorProvider implements ProviderLike {
  name = "deepseek";
  baseUrl = "https://api.deepseek.com/v1";
  model: string;
  helperPath: string;

  constructor(helperPath: string, model: string) {
    this.helperPath = helperPath;
    this.model = model;
  }

  hasCredentials(): boolean {
    return existsSync(this.helperPath);
  }

  redact(text: string): string {
    return text; // 本适配器不持有任何凭据，无可打码之物。
  }

  async listModels(timeout = 30): Promise<string[]> {
    const p = spawnSync("python3", [this.helperPath, "models"], {
      encoding: "utf8",
      timeout: timeout * 1000,
    });
    if (p.error || p.status !== 0)
      throw new Error("DeepSeek 助手 models 调用失败");
    let data: unknown;
    try {
      data = JSON.parse(p.stdout) as unknown;
    } catch {
      throw new Error("DeepSeek 助手 models 返回格式无效");
    }
    const list = (data as { data?: { id: string }[] }).data;
    if (!Array.isArray(list))
      throw new Error("DeepSeek 助手 models 返回格式无效");
    return list.map((m) => m.id);
  }

  async chat(
    messages: ChatMessage[],
    tools?: Record<string, unknown>[] | null,
    timeout?: number,
    opts?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    if (opts?.signal?.aborted)
      throw cancelErrorFromSignal(opts.signal, "stop");
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: normalizeMessages(messages as Record<string, unknown>[]),
    };
    if (tools !== null && tools !== undefined) payload.tools = tools;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(
        "python3",
        [this.helperPath, "chat-tools", "--model", this.model],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const kill = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      };
      // timeout 与 Provider.chat 同款单位：秒。
      const timer =
        typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
          ? setTimeout(() => {
              kill();
              finish(() =>
                reject(new Error("DeepSeek 助手调用超时")),
              );
            }, timeout * 1000)
          : null;
      const onAbort = () => {
        kill();
        finish(() =>
          reject(
            opts?.signal
              ? cancelErrorFromSignal(opts.signal, "stop")
              : new Error("DeepSeek 助手调用已取消"),
          ),
        );
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        if (err.length < 2000) err += d.toString("utf8");
      });
      child.on("error", (e: Error) => {
        if (timer) clearTimeout(timer);
        finish(() => reject(new Error(`DeepSeek 助手启动失败：${e.message}`)));
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", onAbort);
        finish(() => {
          if (code !== 0) {
            reject(
              new Error(
                `DeepSeek 助手调用失败（退出码 ${String(code)}）：${err.trim().slice(0, 500)}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(out) as Record<string, unknown>);
          } catch {
            reject(new Error("DeepSeek 助手返回不是合法 JSON"));
          }
        });
      });
      child.stdin.on("error", () => {
        /* 子进程已死时写 stdin 会报错，close 事件会收尾 */
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }
}
