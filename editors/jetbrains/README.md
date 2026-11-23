# Nyra JetBrains 插件（骨架）

把 Nyra 接进 IntelliJ / PyCharm / WebStorm 等 JetBrains IDE：与 VS Code host 共用同一 core（`src/editorBridge.ts` 的 JSON-lines 协议），host 只负责采集与展示。

## 状态：骨架，未编译

本机没有 IntelliJ / Gradle，这份 Kotlin 代码只按协议手写、**没有编译过**。它不是一个能直接装的插件，是给真机上搭好 IntelliJ 插件工程的人准备的起点：

1. 在 IntelliJ 里用 Gradle + intellij-platform-plugin 模板建插件工程（Kotlin + Gson 依赖）。
2. 把 `plugin.xml` 放进 `src/main/resources/META-INF/`，把 `src/main/kotlin/com/nyra/editor/NyraEditorBridge.kt` 放进对应源码目录。
3. `gradle buildPlugin`，在真机 IDE 里装 zip 验证：问选区、同步快照、工具窗口问答。

## 已有的东西

- `plugin.xml`：插件清单（工具窗口 + 两个 Action：问选区、同步快照）。
- `NyraEditorBridge.kt`：桥客户端（spawn `nyra editor serve --stdio`，JSON 行收发，ask 流式回答案）+ 快照采集 + 两个 Action + 工具窗口骨架。
- 快照采集目前只取了当前文件与选区；全量打开文件列表（`FileEditorManager`）与诊断（`DaemonCodeAnalyzer` / ProblemsView）留了位置，由宿主工程里补——骨架里先留空，不编假数据。

## 诚实边界

- 没编译、没在真机 IDE 里跑过；Gson 依赖版本、Action 注册细节、工具窗口写法都可能要按目标 IDE 版本调。
- 诊断采集未实现（留空），先靠 VS Code 侧的诊断集成顶着；JetBrains 侧诊断接上之前，文档里会写明。
