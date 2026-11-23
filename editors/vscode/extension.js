// editors/vscode/extension.js — Nyra VS Code 扩展（G-P0-3）。
//
// 薄胶水层：VS Code API 只在这里出现，协议逻辑全在 bridge.js（可单测）。
//   - 激活时不立刻 spawn（用户没用 Nyra 时零开销）；第一次用命令或开 autoSnapshot
//     时才启动 `nyra editor serve --stdio` 子进程。
//   - 快照只发元数据：当前文件、光标、选区文本、打开的文件、诊断；不发整文件内容。
//   - diff 预览学 Cline 的虚拟文档：左右都是虚拟文档（nyra-preview scheme），
//     不动磁盘；应用要用户在 Nyra 输出里确认后才走 bridge.apply。
//   - 诊断来自 VS Code 自带的语言服务（Problems），直接当上下文发给 Nyra，
//     与 Nyra 自己的 LSP 客户端（src/lsp.ts）互补，不重复。

const vscode = require("vscode");
const { NyraBridge } = require("./bridge");

/** @type {NyraBridge | null} */
let bridge = null;
/** @type {vscode.OutputChannel | null} */
let channel = null;
/** 虚拟 diff 文档的内容（uri -> 文本），不落盘。 */
const previewDocs = new Map();
let debounceTimer = null;

function getCliPath() {
  const cfg = vscode.workspace.getConfiguration("nyra");
  return cfg.get("cliPath") || "nyra";
}

function getAutoSnapshot() {
  return vscode.workspace.getConfiguration("nyra").get("autoSnapshot") !== false;
}

function ensureBridge() {
  if (bridge) return bridge;
  const folders = vscode.workspace.workspaceFolders;
  const cwd = folders && folders[0] ? folders[0].uri.fsPath : process.cwd();
  bridge = new NyraBridge({
    cliPath: getCliPath(),
    cwd,
    onAnswerChunk: (text) => {
      if (channel) channel.append(text);
    },
    onError: (err) => {
      if (channel) channel.appendLine(`[Nyra 桥错误] ${err.message}`);
      vscode.window.showErrorMessage(`Nyra 桥出问题了：${err.message}（先确认 nyra 在 PATH 上）`);
    },
  });
  bridge.hello("vscode");
  return bridge;
}

function relPath(uri) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders[0]) return uri.fsPath;
  const root = folders[0].uri.fsPath;
  const p = uri.fsPath;
  if (p === root) return ".";
  if (p.startsWith(root + "/") || p.startsWith(root + "\\")) return p.slice(root.length + 1);
  return p;
}

function collectSnapshot() {
  const editor = vscode.window.activeTextEditor;
  const folders = vscode.workspace.workspaceFolders;
  const workspace = folders && folders[0] ? folders[0].uri.fsPath : "";
  const openFiles = [];
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme !== "file") continue;
    openFiles.push({ path: relPath(doc.uri), language: doc.languageId, dirty: doc.isDirty });
    if (openFiles.length >= 10) break;
  }
  const diagnostics = [];
  for (const [uri, items] of vscode.languages.getDiagnostics()) {
    for (const d of items) {
      diagnostics.push({
        file: relPath(uri),
        line: d.range.start.line,
        column: d.range.start.character,
        severity: d.severity + 1, // vscode: 0=Error..3=Hint；Nyra 协议：1=Error..4=Hint
        message: d.message,
        source: d.source,
      });
      if (diagnostics.length >= 40) break;
    }
    if (diagnostics.length >= 40) break;
  }
  let selection = null;
  if (editor) {
    const sel = editor.selection;
    selection = {
      start: { line: sel.start.line, column: sel.start.character },
      end: { line: sel.end.line, column: sel.end.character },
      text: editor.document.getText(sel) || undefined,
    };
  }
  return {
    workspace,
    activeFile: editor ? relPath(editor.document.uri) : null,
    cursor: editor ? { line: editor.selection.active.line, column: editor.selection.active.character } : null,
    selection,
    openFiles,
    diagnostics,
    receivedAt: new Date().toISOString(),
    host: "vscode",
  };
}

function sendSnapshot() {
  try {
    ensureBridge().snapshot(collectSnapshot());
  } catch (err) {
    if (channel) channel.appendLine(`[快照发送失败] ${err.message}`);
  }
}

function scheduleSnapshot() {
  if (!getAutoSnapshot()) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(sendSnapshot, 500);
}

function ensureChannel() {
  if (!channel) channel = vscode.window.createOutputChannel("Nyra");
  return channel;
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const previewProvider = {
    provideTextDocumentContent(uri) {
      return previewDocs.get(uri.toString()) || "";
    },
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("nyra-preview", previewProvider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nyra.askSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("没有打开的编辑器，先打开一个文件。");
        return;
      }
      const ch = ensureChannel();
      ch.show(true);
      const sel = editor.selection;
      const hasSelection = !sel.isEmpty;
      const question = await vscode.window.showInputBox({
        prompt: hasSelection ? "问 Nyra（带着当前选区）：" : "问 Nyra（带着当前文件）：",
        placeHolder: "比如：这段代码有什么问题？",
      });
      if (!question) return;
      try {
        const b = ensureBridge();
        b.snapshot(collectSnapshot());
        ch.appendLine(`[问] ${question}`);
        const { text, exitCode } = await b.ask(question);
        if (exitCode !== 0) ch.appendLine(`[Nyra 子进程退出码 ${exitCode}，回答可能不完整]`);
        if (!text.trim()) ch.appendLine("[Nyra 没有返回文字回答]");
      } catch (err) {
        ch.appendLine(`[问 Nyra 失败] ${err.message}`);
        vscode.window.showErrorMessage(`问 Nyra 失败：${err.message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nyra.sendSnapshot", () => {
      sendSnapshot();
      vscode.window.showInformationMessage("已把当前编辑器状态同步给 Nyra。");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nyra.showDiff", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("没有打开的编辑器，先打开一个文件。");
        return;
      }
      const doc = editor.document;
      if (doc.isUntitled) {
        vscode.window.showWarningMessage("未保存的新文件没有磁盘版本可对比。");
        return;
      }
      try {
        const b = ensureBridge();
        const diskText = await vscode.workspace.fs.readFile(doc.uri).then((u) => Buffer.from(u).toString("utf-8"));
        const currentText = doc.getText();
        if (diskText === currentText) {
          vscode.window.showInformationMessage("当前文件与磁盘一致，没有改动。");
          return;
        }
        const { previewId, diff } = await b.preview(relPath(doc.uri), currentText);
        const left = vscode.Uri.parse(`nyra-preview:disk/${relPath(doc.uri)}`);
        const right = vscode.Uri.parse(`nyra-preview:current/${relPath(doc.uri)}`);
        previewDocs.set(left.toString(), diskText);
        previewDocs.set(right.toString(), currentText);
        await vscode.commands.executeCommand("vscode.diff", left, right, `${relPath(doc.uri)}（磁盘 ↔ 当前，未落盘）`);
        const ch = ensureChannel();
        ch.appendLine(`[diff 预览] ${relPath(doc.uri)}（预览 ${previewId}，只算了 diff，没动磁盘）`);
        ch.appendLine(diff);
      } catch (err) {
        vscode.window.showErrorMessage(`对比失败：${err.message}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nyra.showStatus", async () => {
      const ch = ensureChannel();
      ch.show(true);
      const snap = collectSnapshot();
      ch.appendLine(`工作区：${snap.workspace}`);
      ch.appendLine(`当前文件：${snap.activeFile || "（无）"}`);
      ch.appendLine(`打开的文件：${snap.openFiles.length} 个，诊断：${snap.diagnostics.length} 条`);
      ch.appendLine(`桥状态：${bridge && bridge.running ? "已连接" : "未连接（下次用命令时启动）"}`);
    }),
  );

  if (getAutoSnapshot()) {
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(scheduleSnapshot),
      vscode.window.onDidChangeTextEditorSelection(scheduleSnapshot),
      vscode.languages.onDidChangeDiagnostics(scheduleSnapshot),
    );
  }
}

function deactivate() {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (bridge) bridge.stop();
  bridge = null;
}

module.exports = { activate, deactivate };
