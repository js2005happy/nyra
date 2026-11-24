// src/noKey.ts — 无 Key 模式（与 Python 版行为一致）。
// 无 Key 跑任务：只打印中文设置说明，退出码 1，不发任何请求。
// 注意：Python 版有个小毛病——提示里永远建议 export DEEPSEEK_API_KEY，
// 即使用户选的是 qwen；Node 版按当前 provider 给出对应的环境变量名。
import type { ResolvedProvider } from "./config.ts";

export function noKeyMessage(provider: ResolvedProvider): string {
  const lines: string[] = [];
  lines.push(`Nyra 还没有配置模型。当前 provider 是 ${provider.name}（模型 ${provider.model}），需要先设置 API Key 才能跑任务。`);
  lines.push("");
  if (provider.name === "ollama") {
    lines.push("Ollama 是本地模型，不需要 Key：请先确认本机装好并启动了 Ollama，");
    lines.push("再跑：nyra --provider ollama \"你的任务\"");
  } else if (provider.name === "codex") {
    lines.push("Codex 复用本机 Codex CLI 的登录态，不需要 API Key：");
    lines.push("请先在本机运行 codex 登录，再跑：nyra --provider codex \"你的任务\"");
  } else if (provider.envKey) {
    lines.push(`设置方法（任选其一）：`);
    lines.push(`  1）本次生效：export ${provider.envKey}=你的Key`);
    lines.push(`  2）长期生效：把上面这行加进 ~/.bashrc 或 ~/.zshrc，再重新打开终端`);
    lines.push(`  3）桌面窗口里粘贴：打开 Nyra 窗口 → 首次设置里粘贴 Key，点「测试连接」通过后再保存（只存在本机）`);
    lines.push(`  4）不设 Key：先跑本地示例任务熟悉流程：nyra --example`);
    lines.push("");
    lines.push(`然后再跑：nyra --provider ${provider.name} "你的任务"`);
  } else {
    lines.push("该 provider 需要在 NYRA_BASE_URL / NYRA_MODEL 里先配好 endpoint 与模型，");
    lines.push("再用环境变量 NYRA_API_KEY 提供 Key。");
  }
  lines.push("");
  lines.push("没有 Key 也能先跑：nyra --help / nyra --version / nyra --list-providers / nyra doctor");
  lines.push("本地示例任务（不调模型、不花钱）：nyra --example");
  return lines.join("\n");
}

/** 打印无 Key 说明并返回退出码 1。调用方保证此前未发任何网络请求。 */
export function printNoKeyAndExitCode(provider: ResolvedProvider): number {
  console.log(noKeyMessage(provider));
  return 1;
}
