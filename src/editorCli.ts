// src/editorCli.ts — `nyra editor` 子命令（G-P0-3 编辑器插件）。
//
//   nyra editor serve [--stdio]        启动编辑器桥服务（JSON-lines，stdin/stdout）
//   nyra editor status                 看桥的状态（最近快照、待应用预览）
//   nyra editor snapshot [--json]      打印最近的编辑器快照（给人 / 给脚本看）
//   nyra editor ask <问题>             带上最近快照问一次 Nyra（派生一次完整 CLI 运行）
//   nyra editor preview --file <相对路径> --new <新内容文件>
//                                      只算 diff、不动磁盘，存一条待应用预览
//   nyra editor apply --preview <id> --yes
//                                      应用一条预览（须 --yes；文件自预览后变过就拒绝）
//   nyra editor hosts                  查三个编辑器 host 的安装状态
//
// ask 的实现：不复用 buildAgent（它在 cli.ts 里，editorCli 反向 import 会成环），
// 而是派生一次完整 CLI 运行（`nyra "<快照 + 问题>"`），stdio 继承——provider、
// 成本硬顶、审批链全是正常 CLI 那套，终端里能交互审批。serve 模式下的 ask
// 走同一条路，但子进程 stdin 为 null（非交互），写操作按既有规则 fail-closed。

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  EditorBridge, buildUnifiedDiff, formatEditorSnapshot, loadEditorPreviews,
  loadEditorState, previewId, recordEditorEvent, resolveNyraCliCommand,
  serveEditorBridge, type EditorPreview,
} from "./editorBridge.ts";

const EDITOR_USAGE = `用法：
  nyra editor serve [--stdio]        启动编辑器桥服务（只支持 stdio）
  nyra editor status                 看桥的状态
  nyra editor snapshot [--json]      打印最近的编辑器快照
  nyra editor ask <问题>             带上最近快照问一次 Nyra
  nyra editor preview --file <相对路径> --new <新内容文件>
  nyra editor apply --preview <id> --yes
  nyra editor hosts                  查三个编辑器 host 的安装状态
（详见 docs/editor-plugins.md）`;

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1]!;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function usageError(msg: string): number {
  process.stderr.write(`${msg}\n${EDITOR_USAGE}\n`);
  return 2;
}

/** 派生一次完整 CLI 运行（ask 用），stdio 继承，返回退出码。 */
function runChildCli(prompt: string, workdir: string): Promise<number> {
  const { cmd, args } = resolveNyraCliCommand();
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(cmd, [...args, prompt], { cwd: workdir, stdio: "inherit" });
    } catch {
      process.stderr.write(`启动 Nyra 子进程失败（${cmd}），先确认 nyra 在 PATH 上或设 NYRA_CLI_PATH。\n`);
      resolvePromise(1);
      return;
    }
    child.on("error", () => {
      process.stderr.write(`启动 Nyra 子进程失败（${cmd}），先确认 nyra 在 PATH 上或设 NYRA_CLI_PATH。\n`);
      resolvePromise(1);
    });
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

export async function handleEditor(args: string[], home: string): Promise<number> {
  const [cmd, ...rest] = args;
  const workdir = resolve(process.cwd());
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(`${EDITOR_USAGE}\n`);
    return 0;
  }

  if (cmd === "serve") {
    if (rest.length && !(rest.length === 1 && rest[0] === "--stdio")) {
      return usageError("serve 只支持 --stdio（本批没有 socket 传输）。");
    }
    const bridgeOpts = {
      home,
      workdir,
      onEvent: (type: string, fields: Record<string, unknown>) => {
        void recordEditorEvent(home, type, fields, `editor ${type} ${JSON.stringify(fields)}`);
      },
    };
    return serveEditorBridge(process.stdin, process.stdout, bridgeOpts);
  }

  if (cmd === "status") {
    const snap = loadEditorState(home);
    const previews = loadEditorPreviews(home);
    if (!snap) {
      process.stdout.write("编辑器未连接：没有收到过编辑器快照（先在编辑器里装 Nyra 插件，或跑 nyra editor serve）。\n");
    } else {
      process.stdout.write(`编辑器已连接（${snap.host}，${snap.receivedAt}）\n`);
      process.stdout.write(`工作区：${snap.workspace}\n`);
      process.stdout.write(`当前文件：${snap.activeFile ?? "（无）"}\n`);
      process.stdout.write(`打开的文件：${snap.openFiles.length} 个，诊断：${snap.diagnostics.length} 条\n`);
    }
    process.stdout.write(`待应用预览：${previews.length} 条\n`);
    for (const p of previews) {
      process.stdout.write(`- ${p.id} ${p.file}（+${p.additions} −${p.deletions}，${p.createdAt}）\n`);
    }
    return 0;
  }

  if (cmd === "snapshot") {
    const snap = loadEditorState(home);
    if (hasFlag(rest, "--json")) {
      process.stdout.write(JSON.stringify(snap ?? null, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(formatEditorSnapshot(snap) + "\n");
    return 0;
  }

  if (cmd === "ask") {
    const question = rest.filter((a) => !a.startsWith("--")).join(" ").trim();
    if (!question) return usageError("缺少问题：nyra editor ask <问题>");
    const snap = loadEditorState(home);
    const prompt = [
      "以下是用户当前编辑器里的上下文（只读快照，文件内容以磁盘为准）：",
      formatEditorSnapshot(snap),
      "",
      `用户的问题：${question}`,
    ].join("\n");
    void recordEditorEvent(home, "editor_asked", { workspace: workdir, chars: prompt.length }, `editor ask：${question.slice(0, 120)}`);
    return runChildCli(prompt, workdir);
  }

  if (cmd === "preview") {
    const file = flag(rest, "--file");
    const newPath = flag(rest, "--new");
    if (!file || !newPath) return usageError("缺少参数：nyra editor preview --file <相对路径> --new <新内容文件>");
    const bridge = new EditorBridge({ home, workdir });
    let newText: string;
    try {
      newText = readFileSync(resolve(newPath), "utf-8");
    } catch {
      process.stderr.write(`读不到新内容文件：${newPath}\n`);
      return 1;
    }
    let replies;
    try {
      replies = await bridge.handle({ type: "preview", id: "cli", file, newText });
    } catch (err) {
      process.stderr.write(`预览失败：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    const diff = replies.find((r) => r.type === "diff");
    if (!diff || diff.type !== "diff") {
      process.stderr.write("预览失败：没有生成 diff。\n");
      return 1;
    }
    process.stdout.write(`${diff.diff}预览已存：${diff.previewId}（只算了 diff，没动磁盘；应用跑 nyra editor apply --preview ${diff.previewId} --yes）\n`);
    return 0;
  }

  if (cmd === "apply") {
    const id = flag(rest, "--preview");
    if (!id) return usageError("缺少参数：nyra editor apply --preview <id> --yes");
    if (!hasFlag(rest, "--yes")) {
      process.stderr.write("应用预览会改磁盘文件，须显式确认：nyra editor apply --preview <id> --yes\n");
      return 2;
    }
    const bridge = new EditorBridge({ home, workdir });
    let replies;
    try {
      replies = await bridge.handle({ type: "apply", id: "cli", previewId: id, approved: true });
    } catch (err) {
      process.stderr.write(`应用失败：${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    const applied = replies.find((r) => r.type === "applied");
    if (!applied || applied.type !== "applied") {
      process.stderr.write("应用失败：没有收到 applied 回复。\n");
      return 1;
    }
    process.stdout.write(`已应用 ${applied.file}（+${applied.additions} −${applied.deletions}）\n`);
    return 0;
  }

  if (cmd === "hosts") {
    const userHome = process.env.HOME ?? "";
    const checks: Array<{ host: string; found: boolean; hint: string }> = [];
    // VS Code：扩展目录里找名字叫 nyra 的扩展。
    const vscodeDirs = [join(userHome, ".vscode", "extensions"), join(userHome, ".vscode-oss", "extensions")];
    let vscodeFound = false;
    for (const dir of vscodeDirs) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const pkg = JSON.parse(readFileSync(join(dir, entry.name, "package.json"), "utf-8")) as Record<string, unknown>;
          if (pkg.name === "nyra") vscodeFound = true;
        } catch { /* 不是合法扩展目录就跳过 */ }
      }
    }
    checks.push({ host: "VS Code", found: vscodeFound, hint: "把 editors/vscode 拷到 ~/.vscode/extensions/nyra/（或 vsce package 后安装），见 docs/editor-plugins.md" });
    // JetBrains：各 IDE 的 plugins 目录里找 nyra。
    const jbRoots = [join(userHome, ".local", "share", "JetBrains"), join(userHome, "Library", "Application Support", "JetBrains")];
    let jbFound = false;
    for (const root of jbRoots) {
      if (!existsSync(root)) continue;
      for (const ide of readdirSync(root, { withFileTypes: true })) {
        if (!ide.isDirectory()) continue;
        const plugins = join(root, ide.name, "plugins");
        if (existsSync(join(plugins, "nyra"))) jbFound = true;
      }
    }
    checks.push({ host: "JetBrains", found: jbFound, hint: "editors/jetbrains 是插件骨架，须在 IntelliJ 里构建安装，见 docs/editor-plugins.md" });
    // Zed：扩展目录里找 nyra。
    const zedDirs = [join(userHome, ".config", "zed", "extensions"), join(userHome, ".local", "share", "zed", "extensions")];
    const zedFound = zedDirs.some((d) => existsSync(join(d, "nyra")));
    checks.push({ host: "Zed", found: zedFound, hint: "editors/zed 是扩展核（extension.toml + Rust 协议实现），须在真机 Zed 里安装构建，见 docs/editor-plugins.md" });
    for (const c of checks) {
      process.stdout.write(`${c.host}：${c.found ? "已安装" : "未安装"}${c.found ? "" : `——${c.hint}`}\n`);
    }
    return 0;
  }

  return usageError(`未知编辑器子命令：${cmd}`);
}

// 供测试复用：preview 的 diff 构建（不经过 bridge 的磁盘读）。
export function buildPreviewDiff(file: string, oldText: string, newText: string): { diff: string; additions: number; deletions: number } {
  const d = buildUnifiedDiff(oldText, newText, file);
  return { diff: d.text, additions: d.additions, deletions: d.deletions };
}

export function newPreviewId(): string {
  return previewId();
}

export type { EditorPreview };
