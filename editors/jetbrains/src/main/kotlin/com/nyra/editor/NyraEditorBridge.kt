// editors/jetbrains — Nyra JetBrains 插件骨架（G-P0-3）。
//
// 与 VS Code host 共用同一 core（src/editorBridge.ts 的 JSON-lines 协议）：
// host 只负责采集（光标/选区/打开的文件/诊断）与展示，协议、快照、diff、
// 审批口径全在 Nyra 侧。本文件是 Kotlin 客户端骨架——
//   - NyraBridge：spawn `nyra editor serve --stdio`，JSON 行收发，ask 流式回答案。
//   - 两个 Action：问选区、同步快照；工具窗口只留一个最小问答面板。
//
// 注意：本机没有 IntelliJ / Gradle，Kotlin 代码只按协议手写、没编译过；
// 在 IntelliJ 里建插件工程（Gradle + intellij-platform-plugin 模板）、
// 把本目录当源码拷进去才能编。真机验证待做（见 README.md）。

package com.nyra.editor

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.util.concurrent.ConcurrentHashMap
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.JTextArea
import java.awt.BorderLayout

/** 协议版本：须与 src/editorBridge.ts 的 EDITOR_PROTOCOL_VERSION 一致。 */
const val PROTOCOL_VERSION = 1

private val LOG = Logger.getInstance(NyraBridge::class.java)
private val gson = Gson()

/** 快照里的一条诊断（与 LspDiagnostic 同形；severity 1=Error..4=Hint）。 */
data class EditorDiagnostic(
    val file: String,
    val line: Int,
    val column: Int,
    val severity: Int,
    val message: String,
    val source: String? = null,
)

data class EditorPosition(val line: Int, val column: Int)

data class EditorSelection(
    val start: EditorPosition,
    val end: EditorPosition,
    val text: String? = null,
)

/**
 * 桥客户端：spawn 子进程 + JSON 行。ask 按 id 等 answer_done，中间的
 * answer_chunk 流式交 onChunk；子进程退出时未结算的请求一律失败（fail-closed）。
 */
class NyraBridge(
    private val cliPath: String = "nyra",
    private val workdir: String,
    private val onChunk: (id: String, text: String) -> Unit = { _, _ -> },
) {
    private var process: Process? = null
    private var writer: BufferedWriter? = null
    private val pending = ConcurrentHashMap<String, (JsonObject) -> Unit>()
    private val askChunks = ConcurrentHashMap<String, StringBuilder>()

    fun start() {
        if (process != null) return
        val pb = ProcessBuilder(cliPath, "editor", "serve", "--stdio")
            .directory(java.io.File(workdir))
            .redirectErrorStream(false)
        val p = pb.start()
        process = p
        writer = BufferedWriter(OutputStreamWriter(p.outputStream, Charsets.UTF_8))
        send(mapOf("type" to "hello", "host" to "jetbrains", "version" to PROTOCOL_VERSION))
        Thread({
            val reader = BufferedReader(InputStreamReader(p.inputStream, Charsets.UTF_8))
            try {
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isBlank()) continue
                    try { route(gson.fromJson(line, JsonObject::class.java)) } catch (_: Exception) { /* 坏行跳过 */ }
                }
            } catch (_: Exception) { /* 流断了就停 */ }
            finally { failAll(IllegalStateException("Nyra 桥子进程已退出")) }
        }, "nyra-bridge-reader").apply { isDaemon = true; start() }
    }

    fun stop() {
        try { process?.destroy() } catch (_: Exception) { }
        process = null
        failAll(IllegalStateException("Nyra 桥已停止"))
    }

    private fun failAll(err: Exception) {
        for ((_, cb) in pending) { try { cb(JsonObject().apply { addProperty("type", "error"); addProperty("error", err.message) }) } catch (_: Exception) { } }
        pending.clear()
        askChunks.clear()
    }

    private fun send(msg: Map<String, Any?>) {
        start()
        val w = writer ?: throw IllegalStateException("Nyra 桥未启动")
        w.write(gson.toJson(msg))
        w.write("\n")
        w.flush()
    }

    private fun route(msg: JsonObject) {
        val type = msg.get("type")?.asString ?: return
        val id = msg.get("id")?.asString
        if (type == "answer_chunk" && id != null) {
            askChunks.getOrPut(id) { StringBuilder() }.append(msg.get("text")?.asString ?: "")
            onChunk(id, msg.get("text")?.asString ?: "")
            return
        }
        if ((type == "answer_done" || type == "diff" || type == "applied" || type == "error") && id != null) {
            val cb = pending.remove(id) ?: return
            if (type == "answer_done") {
                val text = askChunks.remove(id)?.toString() ?: ""
                val out = JsonObject()
                out.addProperty("type", "answer_done")
                out.addProperty("text", text)
                out.addProperty("exitCode", msg.get("exitCode")?.asInt ?: 0)
                cb(out)
            } else {
                cb(msg)
            }
        }
        // hello / ack / pong：不等回复，直接忽略。
    }

    fun snapshot(snapshot: Map<String, Any?>) = send(mapOf("type" to "snapshot", "snapshot" to snapshot))

    fun ask(question: String, cb: (text: String, exitCode: Int) -> Unit) {
        val id = "ask_${System.currentTimeMillis()}"
        pending[id] = { msg ->
            if (msg.get("type")?.asString == "error") throw IllegalStateException(msg.get("error")?.asString ?: "Nyra 桥报错")
            cb(msg.get("text")?.asString ?: "", msg.get("exitCode")?.asInt ?: 0)
        }
        send(mapOf("type" to "ask", "id" to id, "question" to question))
    }

    companion object {
        /** 从 IntelliJ 编辑器采集快照（只发元数据与选区文本，不发整文件内容）。 */
        fun collectSnapshot(project: Project, editor: Editor?): Map<String, Any?> {
            val base = project.basePath ?: ""
            val openFiles = mutableListOf<Map<String, Any?>>()
            // 只取当前文件进 openFiles（全量打开文件列表走 FileEditorManager，骨架里先取当前文件）。
            val activeFile = editor?.document?.let { doc ->
                val vf = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getFile(doc)
                vf?.path?.removePrefix("$base/") ?: vf?.path
            }
            val diagnostics = mutableListOf<Map<String, Any?>>()
            // 诊断走 IntelliJ 的 DaemonCodeAnalyzer/ProblemsView；骨架里先留空，由宿主补。
            val selection = editor?.selectionModel?.let { sel ->
                mapOf<String, Any?>(
                    "start" to mapOf("line" to sel.selectionStartPosition?.line, "column" to sel.selectionStartPosition?.column),
                    "end" to mapOf("line" to sel.selectionEndPosition?.line, "column" to sel.selectionEndPosition?.column),
                    "text" to sel.selectedText,
                )
            }
            return mapOf<String, Any?>(
                "workspace" to base,
                "activeFile" to activeFile,
                "cursor" to editor?.caretModel?.primaryCaret?.let { mapOf("line" to it.logicalPosition.line, "column" to it.logicalPosition.column) },
                "selection" to selection,
                "openFiles" to openFiles,
                "diagnostics" to diagnostics,
                "receivedAt" to java.time.Instant.now().toString(),
                "host" to "jetbrains",
            )
        }
    }
}

/** 问当前选区：快照 + 问题发给桥，回答写进工具窗口（骨架：先弹输入框问问题）。 */
class AskSelectionAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val question = com.intellij.openapi.ui.Messages.showInputDialog(
            project, "问 Nyra（带着当前选区）：", "Nyra", null,
        ) ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val bridge = NyraBridge(workdir = project.basePath ?: ".")
                bridge.snapshot(NyraBridge.collectSnapshot(project, editor))
                bridge.ask(question) { text, exitCode ->
                    LOG.info("Nyra 回答（退出码 $exitCode）：$text")
                }
            } catch (err: Exception) {
                LOG.warn("问 Nyra 失败", err)
            }
        }
    }
}

/** 手动同步一次快照。 */
class SendSnapshotAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR)
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val bridge = NyraBridge(workdir = project.basePath ?: ".")
                bridge.snapshot(NyraBridge.collectSnapshot(project, editor))
            } catch (err: Exception) {
                LOG.warn("同步快照失败", err)
            }
        }
    }
}

/** 工具窗口骨架：一个输入框 + 提问按钮 + 只读回答区（回答流式追加由 NyraBridge 的 onChunk 接）。 */
class NyraToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = JPanel(BorderLayout())
        val input = JBTextArea(3, 40)
        val output = JTextArea()
        output.isEditable = false
        val askButton = JButton("问 Nyra")
        askButton.addActionListener {
            val q = input.text.trim()
            if (q.isEmpty()) return@addActionListener
            output.append("[问] $q\n")
            ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    val bridge = NyraBridge(
                        workdir = project.basePath ?: ".",
                        onChunk = { _, text -> javax.swing.SwingUtilities.invokeLater { output.append(text) } },
                    )
                    bridge.ask(q) { _, exitCode ->
                        javax.swing.SwingUtilities.invokeLater { output.append("\n[退出码 $exitCode]\n") }
                    }
                } catch (err: Exception) {
                    javax.swing.SwingUtilities.invokeLater { output.append("\n[失败] ${err.message}\n") }
                }
            }
        }
        val top = JPanel(BorderLayout())
        top.add(JBScrollPane(input), BorderLayout.CENTER)
        top.add(askButton, BorderLayout.EAST)
        panel.add(top, BorderLayout.NORTH)
        panel.add(JBScrollPane(output), BorderLayout.CENTER)
        toolWindow.component.add(panel)
    }
}
