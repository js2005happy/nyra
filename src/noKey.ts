// src/noKey.ts — 没有可用凭据时的说明。
// 按当前 provider 写出变量名和现在还能走的设置路径，跟随 CLI 语言（--lang / 配置 / 系统）。
// 只打印变量名，不打印 Key。调用方在发任何模型请求之前打印这段并退出码 1。
import type { ResolvedProvider } from "./config.ts";
import { t } from "./i18n.ts";

/** 还没发模型请求就停住。message 保持稳定标记，providerName 给调用方写进错误说明。 */
export class NoCredentialsError extends Error {
  readonly providerName: string;
  constructor(providerName: string) {
    super("__NO_CREDENTIALS__");
    this.name = "NoCredentialsError";
    this.providerName = providerName;
  }
}

export function noKeyMessage(provider: ResolvedProvider): string {
  const lines: string[] = [
    t("creds.missing", { provider: provider.name, model: provider.model }),
    "",
  ];
  if (provider.name === "ollama") {
    lines.push(t("creds.ollama"));
  } else if (provider.name === "codex") {
    lines.push(t("creds.codex"));
  } else if (provider.envKey) {
    lines.push(t("creds.how"));
    lines.push(t("creds.envOnce", { env: provider.envKey }));
    lines.push(t("creds.envPersist"));
    lines.push(t("creds.window"));
    lines.push(t("creds.example"));
    lines.push("");
    lines.push(t("creds.then", { provider: provider.name }));
  } else {
    lines.push(t("creds.custom"));
  }
  lines.push("");
  lines.push(t("creds.also"));
  return lines.join("\n");
}

/** 打印无 Key 说明并返回退出码 1。调用方保证此前未发任何网络请求。 */
export function printNoKeyAndExitCode(provider: ResolvedProvider): number {
  console.log(noKeyMessage(provider));
  return 1;
}
