# 公开发布验收与证据清单

本文件是公开发布的验收门。安装、签名、沙箱、预算、取消、续跑和评测的行为说明仍在各自文档里；这里只规定哪一条门必须有哪一种证据，以及 2026-11-24 对照当时的 `main` 时，这些门停在哪里。

检查时的 `main`：[ab5f432913604b4404cb244236d2a408a5eb20ff](https://github.com/js2005happy/nyra/commit/ab5f432913604b4404cb244236d2a408a5eb20ff)（2026-11-24 16:04 +0800）。源码版本号见下文「版本身份」。已发布的最新 Release 是 [v0.5.11](https://github.com/js2005happy/nyra/releases/tag/v0.5.11)（`published_at` 2026-11-23T18:09:30Z）。`v0.5.12` 的 Release API 返回 404。

本清单没有跑付费模型任务，没有在干净机器上安装，没有下载产物跑 `cosign`，没有打 tag，也没有合并。空白证据槽保持空白。

## 状态词

| 状态 | 含义 |
| --- | --- |
| PASS | 本文件引用的当前证据表明这一门已经成立。模拟测试、旧提交上的报告、工作流文件存在，都不能写成 PASS。 |
| NOT MET | 已经看到与这一门相反的事实。 |
| NOT VERIFIED | 有设计、有命令或有旧记录，但没有对当前候选版本的实测证据。 |
| UNKNOWN | 这一项没有查到足够的事实，不能写成通过或失败。 |

通过条件写在每一门里。证据槽留空，由做实测的人填：日期、机器、操作者、命令、退出码、原样输出、产物哈希、花费、以及不知道的项。缺用量记 UNKNOWN，不补成 0。

## 两套运行时

当前仓库是 TypeScript，由 Bun 执行和打包。

- [package.json](../package.json) 要求 `bun >= 1.4.0`，`version` 是 `0.5.12-dev`。
- [src/config.ts](../src/config.ts) 的 `VERSION` 同样是 `0.5.12-dev`。
- 发布用的单文件二进制由 Bun `--compile` 产生，安装脚本写明使用者不需要另装 Python、Node 或 Bun。见 [scripts/install-node.sh](../scripts/install-node.sh)。
- 现行测试工作流是 [.github/workflows/node-ci.yml](../.github/workflows/node-ci.yml)。文件头写明：0.4.0 起它是唯一测试工作流，Python CI 与旧的 Windows exe 工作流已随 Python 删除。矩阵是 Ubuntu / Windows / macOS，Bun 1.4.4，步骤是 `bun install --frozen-lockfile`、`bun x tsc -p tsconfig.json --noEmit`、`bun test tests/node`、`bash scripts/run-probes.sh`。

[VERIFICATION.md](../VERIFICATION.md) 开头的过期声明写明：该文件记录的是 2026-11-16 的 Python 0.3.0，Python 树已在 0.4.0 删除。文件里的 unittest 次数、GitHub Actions Python 矩阵，以及「真实 DeepSeek + 真实 E2B 沙盒端到端」都是那棵 Python 树的历史记录。那些记录说明当时的 Python 版本做过哪些事；它们不给当前 TypeScript 二进制任何一门 PASS。

[docs/node-migration-phase1.md](node-migration-phase1.md) 是 2026-11-18、基线 `d2eb6d9` 的第 1 阶段实测笔记：当时 Python 全量与早期 Node 测试同时存在，向导示例任务不调模型。那份笔记里的耗时和通过数属于那个工作树，不转移到 `ab5f432`。

[src/eval/apiProvider.ts](../src/eval/apiProvider.ts) 的 DeepSeek 评测通道会启动仓库外的连接器助手 `deepseek.py`。这是评测记账用的外部助手，不是已删除的 Nyra Python 包，也不能用来把 [VERIFICATION.md](../VERIFICATION.md) 里的 E2B 端到端算进当前发布。

## 评测记录：范围和新鲜度

仓库里同时有几份 20 题记录。它们测的不是同一个提交，也不能合成一个「当前成功率」。[src/eval/runner.ts](../src/eval/runner.ts) 的 `summarizeEval` 里，`passed` / `failed` / `blocked` / `successRateAll` 只数每次任务的第一次尝试；`recoveredOnRetry` 另计，不回填进首次通过率。`spentUsd` 在任一尝试的花费为 null 时整份报告为 null；`knownSpentUsd` 只加总已知数。连接器题用的是内存测试传输层，[docs/eval.md](eval.md) 写明那不是真实 Gmail。live 执行只声明了 Linux。

| 记录 | 提交是否在当前 main 上 | 范围 | 新鲜度 |
| --- | --- | --- | --- |
| [baseline-840a522.json](eval-results/baseline-840a522.json)，叙述在 [docs/eval.md](eval.md)「本轮基线」 | 是。[840a522](https://github.com/js2005happy/nyra/commit/840a522e207a838eb6720283d5eeaaf4bfb571f7) 是当前 main 的祖先 | 2026-11-22T03:59:14Z。Ollama `qwen2.5:7b`，Linux x64，Bun 1.4.5。20 题全部 `blocked`，原因 `local-model-unavailable`。模型调用 0，花费 $0，`unknownCostAttempts` 0。这是前置条件记录，文件自己写明没有可用的模型能力分数 | 比当前 HEAD 早。叙述没有收录下面三份 DeepSeek JSON |
| [baseline-deepseek-flash-840a522.json](eval-results/baseline-deepseek-flash-840a522.json) | 文件在 main 上。`sourceRevision` 是 [bb42f7f](https://github.com/js2005happy/nyra/commit/bb42f7f7d32658db746ae6cf74f55605b65b4419)，该提交在 `origin/codex/reliability-eval-batch1`，不是当前 main 的祖先。文件名里的 `840a522` 与 `sourceRevision` 不一致。按分支名搜索 pull request，lexical 搜索结果为 0；本清单不把这份记录称作已合并的 PR | 2026-11-22T04:41:43Z。`deepseek-flash`，Linux x64，Bun 1.4.4。首次尝试 0 通过、10 失败、10 阻塞。失败原因 `agent-execution-failed`，这 20 次失败尝试的 `spentUsd` 为 null，`modelCalls` 为 0，`unknownCostAttempts` 20，因此摘要 `spentUsd` 为 null。代码题阻塞于 `isolated-test-runtime-unavailable`，浏览器题阻塞于 `isolated-browser-unavailable` | 早于 main 上的后续修复记录。[docs/eval.md](eval.md) 把这次暴露的代理变量与 `reasoning_content` 问题记成了通道修补，不是能力分数 |
| [baseline-deepseek-flash-ba0153c.json](eval-results/baseline-deepseek-flash-ba0153c.json) | 是。[ba0153c](https://github.com/js2005happy/nyra/commit/ba0153ca51f043a3adba720897d0e9b6d508c9b8) 是当前 main 的祖先 | 2026-11-22T07:03:31Z。`deepseek-flash`，Linux x64，Bun 1.4.4，环境里没有 Chromium。首次尝试 8 通过、2 失败、10 阻塞。代码题与浏览器题仍被上面两个环境原因挡住。研究/连接器题有模型调用。`knownSpentUsd` 0.0264654，`unknownCostAttempts` 0，人工介入 0。`research-03` 两次都 `acceptance-failed`；`connector-04` 第一次失败、重试通过 | 只覆盖当时能执行的 10 题。不能外推成 20 题全通过 |
| [baseline-deepseek-flash-c964252.json](eval-results/baseline-deepseek-flash-c964252.json) | 是。[c964252](https://github.com/js2005happy/nyra/commit/c96425211be7e132f085b6f1c2bef3ee23289cc9) 是当前 main 的祖先，比 `ab5f432` 早 254 个提交 | 2026-11-22T07:53:38Z 至 07:57:52Z。`deepseek-flash`，Linux x64，Bun 1.4.4，Node v24.22.1，Google Chrome 158.0.8127.36，`modelDigest` null。20 题都执行了。首次尝试 18 通过、2 失败（`research-01`、`research-03`，都是 `acceptance-failed`）。`research-01` 重试通过，`research-03` 两次都失败。`recoveredOnRetry` 1。模型调用 96，`knownSpentUsd` 0.05848980000000001，`unknownCostAttempts` 0，人工介入 0 | [ROADMAP.md](../ROADMAP.md) 可靠性第 3 行写的「DeepSeek flash，20 题 $0.0585」与这份已知花费的四舍五入相符。那一行说的是金额在这份基线上被记下来过。它没有写 20 题首次全通过，也没有写这份报告属于 `ab5f432` |

[docs/eval-results/verification-840a522.json](eval-results/verification-840a522.json) 把当天全量记成 3241 通过、13 失败，并写 `readyForUnqualifiedRelease: false`。失败项集中在视频通话、网关和 Gmail 网关测试，文件把阻断原因记成网卡枚举权限。[VERIFICATION.md](../VERIFICATION.md) 的过期声明另写「全量 4000+ 项」，没有附带那次计数的日志。本清单没有重跑 `bun test`，所以 `ab5f432` 的通过数是 UNKNOWN。

2026-11-24 查到的最近一次 Node CI 成功是 [run 45349800768](https://github.com/js2005happy/nyra/actions/runs/45349800768)，结论 `success`，提交 [7f0b847](https://github.com/js2005happy/nyra/commit/7f0b847a3d3f16349fd564f9c9747904bf554d5d)（当前 HEAD 的祖先，其后还有 3 个提交）。`node-ci.yml` 的路径过滤不含 `docs/**`，所以文档提交不会启动这次工作流。本清单没有打开该 run 的作业日志，没有把测试条数抄出来。这次成功是托管 runner 上的源码测试，不是干净机器安装，也不是真实模型任务。

## 已挂上的发布产物

签名工作流 [.github/workflows/release-sign.yml](../.github/workflows/release-sign.yml) 和本地校验脚本 [scripts/verify-release.sh](../scripts/verify-release.sh) 是接线。[tests/node/test-release-verify.test.ts](../tests/node/test-release-verify.test.ts) 用本地夹具检查解析和失败关闭。接线和工作流文件不代替 Release 页面上的文件；夹具测试不给任何签名门 PASS。

2026-11-24 用 Release API 直接按 tag 看过附件名。下面「无校验文件」指附件名里没有 `SHA256SUMS`、`SHA256SUMS.sig`、`SHA256SUMS.pem`、`SHA256SUMS.bundle`。没有下载这些字节，也没有跑 `cosign verify-blob`。GitHub 资产对象上的 `digest` 字段不是 Nyra 的 `SHA256SUMS`，不能当成已验证的清单。

| Tag | 发布记录 | 附件 | 校验文件 |
| --- | --- | --- | --- |
| v0.5.12 | API 404，没有这个 Release | 无 | 无 |
| [v0.5.11](https://github.com/js2005happy/nyra/releases/tag/v0.5.11) | 2026-11-23T18:09:30Z，当前最新 | 11 个：5 个 Node 二进制、Windows `.msi` 与 `-setup.exe`、macOS `.dmg`、Linux `.deb` 与 AppImage、Android debug APK | 无 |
| v0.5.7、v0.5.8、v0.5.9、v0.5.10 | 2026-11-23，列表接口与 v0.5.11 同一页 | 各 11 个，文件名模式与 v0.5.11 相同 | 无 |
| [v0.5.6](https://github.com/js2005happy/nyra/releases/tag/v0.5.6) | 2026-11-23T06:09:47Z | 11 个，含 APK、桌面包、`.deb`、AppImage 和 5 个二进制 | 无 |
| v0.5.5 | 2026-11-22T16:07:36Z | 11 个，同上 | 无 |
| v0.5.4 | 2026-11-22T10:45:58Z | 11 个，同上 | 无 |
| v0.5.3 | 2026-11-20T09:46:15Z | 10 个：没有 APK，其余与上一行同类 | 无 |
| [v0.5.2](https://github.com/js2005happy/nyra/releases/tag/v0.5.2) | 2026-11-20T07:36:09Z | 5 个 Node 二进制 | 无 |
| [v0.5.1](https://github.com/js2005happy/nyra/releases/tag/v0.5.1) | 2026-11-19T12:30:15Z | 5 个 Node 二进制、Windows `.msi` 与 `-setup.exe`，外加四个校验文件 | `SHA256SUMS`、`.sig`、`.pem`、`.bundle` 都在。字节是否对得上、签名是否验得过：NOT VERIFIED |
| v0.5.0 | 2026-11-19T10:00:28Z | 7 个 | 无 |
| v0.4.0 | 2026-11-19T05:16:47Z | 5 个 | 无 |

[docs/installers.md](installers.md) 写最终 Release 应有 13 个附件，其中含四个校验文件，并写 `.deb` 不在那 13 个的计数方式里；[README.md](../README.md) 的 Linux 安装表写 `.deb` / tarball 不在 Release 里。v0.5.3 起的已发布页面上有 `.deb` 和 AppImage，且 v0.5.2 至 v0.5.11 没有校验文件。文档与页面不一致，发布前要先改文档或改附件集合，再谈 PASS。

三份安装脚本的默认版本都钉在 `v0.5.12`，下载后要求同一 Release 的 `SHA256SUMS`，缺清单就拒绝安装。脚本注释写明这个 tag 还没发，默认下载失败是有意的失败关闭。见 [scripts/install-node.sh](../scripts/install-node.sh)、[scripts/install-node-macos.sh](../scripts/install-node-macos.sh)、[scripts/install-node.ps1](../scripts/install-node.ps1)。`--from-file` 不联网、不校验。

[docs/SIGNING.md](SIGNING.md) 把签名分成三层：Release 清单的 keyless 签名、维护者本机的 Git SSH 签名、Windows/macOS 二进制的商业证书签名。第 3 层写明接线在 0.5.1 就绪，证书未配置，产物仍未签名；macOS 命令行裸二进制另有公证票据钉不上的说明。本清单没有对任一已发布 exe、dmg 或 msi 跑 `signtool`、`codesign` 或 `spctl`，所以操作系统代码签名的结论是 NOT VERIFIED。文档中的「未签名」是发布说明，不是本清单对字节的复验。

## 版本身份

[docs/installers.md](installers.md) 要求发版时六处版本一起升：根 `package.json`、`src/config.ts`、`desktop/package.json`、`desktop/src-tauri/tauri.conf.json`、`desktop/src-tauri/Cargo.toml`、`mobile/package.json`。当前前两处是 `0.5.12-dev`，后四处是 `0.5.11`。同一文档把这个差异写成发版前的过渡态，并写明此期间桌面工作流的版本检查会失败。

[docs/windows-install.md](windows-install.md) 一处写 `--version` 应打印 `nyra 0.5.12-dev (node runtime)`，另一处写 `nyra 0.5.2 (node runtime)`。[README.md](../README.md) 的安装章写最新版 v0.5.11。这些句子与「六处一起升到将要发布的版本」不是同一事实。本清单不改那三份共享文档。

## 怎么做实测

干净机器指：该用户账号下没有 `~/.nyra`、`~/nyra`、`~/.local/share/nyra`、`~/.local/bin/nyra`，PATH 里没有 `nyra`。Windows 还要没有 `%USERPROFILE%\nyra` 和两个桌面快捷方式。CI 检出仓库后跑 `bun test` 不是干净机器。`--from-file` 与「从 GitHub 下载并校验」是两道门。

每一道门的证据槽至少留下：

```text
日期（UTC）：
操作者：
机器：操作系统、版本、架构、是否新用户、是否已有 ~/.nyra
候选：git 提交全长、二进制 sha256、nyra --version 原样输出
命令与退出码：
原样输出（可附文件，不改写数字）：
花费 USD：已知数 / UNKNOWN 次数（UNKNOWN 不要写成 0）
人工介入次数：
结论：PASS 或失败原因
```

失败、阻塞、未知和人工介入都要留下。只贴成功题的输出不算这一门通过。

## 发布阻断项

这些门在公开 tag 之前要有 PASS。当前没有一门是 PASS。

### A. 身份、tag 与校验产物

| ID | 现状 | 通过条件 | 操作 | 证据槽 |
| --- | --- | --- | --- | --- |
| A1 版本六处一致 | NOT MET。前两处 `0.5.12-dev`，桌面与手机四处 `0.5.11` | 六处都是即将打的 tag，去掉 `v` 后与 `nyra --version` 一致，且不再带 `-dev` | 对照 [docs/installers.md](installers.md) 的六处，再跑桌面工作流里的版本检查 | |
| A2 默认安装指向已发布且带清单的 tag | NOT MET。脚本钉 `v0.5.12`，该 Release 不存在；v0.5.2–v0.5.11 没有 `SHA256SUMS` | 三份脚本的默认 tag 在 GitHub 上存在，且带非空 `SHA256SUMS` 与 `.bundle` | 不改脚本的前提下执行默认安装，或先发版再执行。缺清单时安装必须拒绝，这个拒绝本身不是安装成功 | |
| A3 清单签名与哈希 | NOT VERIFIED。v0.5.1 挂了四个校验文件，但本清单没有验签。v0.5.11 没有这些文件，对该 tag 是 NOT MET | 对**这个** tag 下载全部附件后，`bash scripts/verify-release.sh <tag>` 退出码 0；`sha256sum -c` 覆盖安装脚本会装的文件和桌面/手机包。工作流 YAML 存在不算 | 按 [docs/SIGNING.md](SIGNING.md) 的命令。不要用 [tests/node/test-release-verify.test.ts](../tests/node/test-release-verify.test.ts) 代替 | |
| A4 来源证明 | NOT VERIFIED。已查看的 Release 附件名里没有 `*.intoto.jsonl`。[docs/installers.md](installers.md) 写 SLSA 证明不挂附件 | `gh attestation verify <文件> --repo js2005happy/nyra` 对每个对外分发的文件成功，并把证明 URL 写入证据槽。只证明工作流会调用 `attest-build-provenance` 不算 | 见 [docs/SIGNING.md](SIGNING.md) | |
| A5 文档与附件一致 | NOT MET。README 写 `.deb` 不在 Release；v0.5.3 起页面上有 `.deb` 和 AppImage | 安装文档列出的每个下载名都在该 tag 上，文档写「不提供」的文件确实不在页面上 | 对照本文件的附件表和 [README.md](../README.md)、[docs/linux-install.md](linux-install.md)、[docs/installers.md](installers.md) | |

### B. 干净机器：安装、向导、升级、卸载

三个操作系统各做四步。Windows 真机说明在 [docs/windows-install.md](windows-install.md)（2026-11-19：CI 冒烟过 `--version` / `--example`，作者写明还没在真 Windows 电脑上跑过）。macOS 说明在 [docs/macos-install.md](macos-install.md)（脚本当时在 Linux 上做了语法检查，作者写明还没在真 Mac 上跑通）。这些句子是文档边界，不是本清单的新实测。下表全部 NOT VERIFIED。

| ID | 通过条件 | 操作 |
| --- | --- | --- |
| B1 安装 | 默认下载只在 A2 通过后才可能成功。另做一次 `--from-file`：二进制就位，`nyra --version` 与候选一致，不要求机器预装 Python/Node/Bun。Linux 动态链接需要的 glibc 写进证据 | Linux：[docs/linux-install.md](linux-install.md)。macOS：[docs/macos-install.md](macos-install.md)。Windows：[docs/windows-install.md](windows-install.md) 与 `install-node.ps1`。记录 SmartScreen / Gatekeeper 的原样提示；提示出现不等于文件损坏，也不等于已签名 |
| B2 首次向导与第一次任务 | 向导跑完本地示例后，输出明确那是本地示例，不是模型任务。无 Key 时模型任务退出码 1，且不发出模型请求。有 Key 或已启动的本地模型时，另做一次真实的「交互审批后改一个文件」 | 本地示例来自 `nyra setup`。doctor 的承诺范围写在 CHANGELOG 2026-11-24 的首次运行条目：安装、doctor、一个 Key、交互审批改一个文件。不要把示例任务的 SQLite 计数写成模型通过 |
| B3 升级 | 升级替换二进制，`~/.nyra` 里预先放下的标记文件还在，配置没被脚本改写 | 再跑对应安装命令。Linux/macOS 文档写「重复跑就是升级」。Windows 用同一脚本再装一次，并记录 PATH 与快捷方式是否重复 |
| B4 卸载 | 二进制、启动器、用户服务文件和 Windows 快捷方式被删掉；`~/.nyra` 仍在，除非操作者另外手动删除 | Linux：`bash scripts/install-node.sh --uninstall`（含 systemd 单元）。macOS：`bash scripts/install-node-macos.sh --uninstall`（含 launchd）。Windows：`.\install-node.ps1 -Uninstall`，脚本删 `%USERPROFILE%\nyra`、用户 PATH 项和「Nyra 终端」「Nyra 网页界面」两个快捷方式。[docs/windows-install.md](windows-install.md) 正文目前没有卸载节，证据以脚本行为为准 |

每个系统的 B1–B4 分开填证据槽。一个系统通过不能填进另一个系统。

### C. 真实模型任务基线

现状：NOT VERIFIED（对 `ab5f432` 和任何尚未存在的 `v0.5.12` 提交）。上表四份 JSON 只证明它们各自的提交和条件。

通过条件：

1. 用 [docs/eval.md](eval.md) 的入口新跑一份报告。`sourceRevision` 等于要发布的提交全长。旧报告重跑若因源码或环境变化被拒绝，就新建基线，不要改旧文件的数字。
2. 报告写明日期、provider、模型名、单价、`maxCostUsd`、轮数、超时、操作系统、架构、Bun 版本、Node 版本、浏览器版本、模型 digest（API 模型按现有通道记 null，并写明 null 的原因）。
3. 每题保留每次尝试的状态、失败或阻塞原因、验收项、花费、模型调用数、人工介入、`runId`。首次通过率与重试挽回分开，口径用 `summarizeEval`。
4. `unknownCostAttempts` 与 `unknownInterventionAttempts` 原样保留。有未知花费时，对外句子写「已知花费下界」和未知次数，不写一个总美元数。
5. 连接器题若仍走内存测试传输层，结论里写明没有真实投递。真实邮箱、Shopify、Slack 要另开证据，不能借这 20 题。
6. 非 Linux 没有 live 运行时，写成该平台 NOT VERIFIED，不要写成失败率。
7. 私有目录 `.eval-runs/` 不提交。公开证据用报告 JSON、验收指纹和本证据槽。

操作：`bun run scripts/eval.ts run --out <新文件>`。需要付费 provider 时由发布负责人在预算内执行；本清单不提供分数，也不要求用假 provider 填充分数。假 provider 的 `bun test` 不满足这一门。

### D. 预算，含缺用量

行为说明在 [docs/budget.md](budget.md)。严格模式默认开：有美元上限时，未配单价或调用没报用量会暂停，不编一个金额，也不发下一轮。文档写明这套暂停在假 provider 与本地检查上验过，并写「真 API 未跑通」。`c964252` 那份报告说明评测架子在那个提交上从返回的用量算出了 0.0584898 美元；它没有记录一次因触顶而拒绝的真实调用，也没有记录一次缺用量暂停。

现状：NOT VERIFIED。不要把 [tests/node](../tests/node) 里的预算测试或 ROADMAP 的 `$0.0585` 写成这一门 PASS。

| ID | 通过条件 | 操作 |
| --- | --- | --- |
| D1 预留先于请求 | 设一个低于预估的美元上限。请求没有发出，账本里没有一笔已结算的正花费 | 用发布候选二进制、真实 provider。记录上限、预估、拒绝事件和供应商侧是否出现调用 |
| D2 缺用量 | 供应商不返回 usage，或返回畸形 usage。严格模式开时运行暂停，账本不把未知写成 $0，恢复前不发下一轮 | 需要一个会缺用量的真实响应。做不到就保持 NOT VERIFIED，并写明为什么没能构造 |
| D3 未配单价 | 有美元上限、模型没有单价时，第一次调用前暂停 | 选一个故意不在单价表里的模型名，确认没有请求发出 |
| D4 金额展示 | `nyra cost --show` 与运行记录把未知和在途预留分开 | 对照 [docs/budget.md](budget.md) 的字段。跨进程同时预留的竞态文档有说明；本门不要求把它做成严格串行，证据里照实写 |

### E. 审批、停止、撤销、崩溃续跑、外部副作用

| ID | 现状 | 通过条件 | 操作 |
| --- | --- | --- | --- |
| E1 审批 | NOT VERIFIED | 写文件和 shell 在默认模式下停下来等批准。拒绝后该动作没有发生。换文件或换命令后，上一次批准不能套用 | 干净目录里做一次允许、一次拒绝。记录审批原文和文件系统结果 |
| E2 停止 | NOT VERIFIED。[docs/cancellation.md](cancellation.md) 写明已发出的外部动作停不掉，并且这套取消只在假 provider 与本地检查上验过 | 真实模型调用进行中执行停止。只有底层请求或子进程已经停，才标已停；停不下来时输出保持「正在停止」。已送达的外部消息仍在，证据里写明 | `/stop` 或 `nyra subagent stop <运行 id> --yes`，再 `confirm-stopped`。不要用只断言 AbortSignal 的单元测试填这一门 |
| E3 撤销 | NOT VERIFIED | 撤销之后的下一次动作被拒绝。撤销前已经完成的动作保留在审计里 | 按要发布的能力选实际入口，并写明测的是哪一种撤销：信任圈 `nyra circle revoke`（[docs/circles.md](circles.md)）、脚本预授权 `nyra script preauth revoke`、SCIM `nyra sso scim revoke-token`、连接器卸载时的授权撤销。测一种不能代替另一种 |
| E4 崩溃后续跑 | NOT VERIFIED | 进程杀掉后，`nyra --resume-run <运行 ID>` 能说明恢复到哪一步。可核查的写文件若已生效，不重复写；读回不一致时会再执行 | 见 [docs/resume.md](resume.md)。可核查工具只有 `write_file`、`edit_file`、`plan`、`memory_append`、`save_skill` |
| E5 外部副作用不重复 | NOT VERIFIED | 一次外部发送在崩溃或重试后仍然只发生一次。若实现不能证明「已经发出」，就保持失败或待人工处理，不能自动再发一次 | [docs/resume.md](resume.md) 与 [docs/idempotent-retry.md](idempotent-retry.md) 写明 `shell`、`http_post`、浏览器/电脑操作、`delegate`、MCP 不参与自动去重。[docs/kanban.md](kanban.md) 的 `nyra side-effects recover` 要求先核对再决定，已经做过的不重复对外。证据要包含供应商或测试双端上的发送次数，以及 side-effects 队列状态 |

E4 通过不等于 E5 通过。本地文件读回一致，推不出邮件或 HTTP 没有发第二次。

### F. 沙箱与平台边界

行为以 [docs/sandbox.md](sandbox.md) 为准。`auto` 在 Linux 且有 bwrap 时用 bubblewrap，默认断网；没有 bwrap 时退回工具级限制并说明。macOS 有 `sandbox-exec` 时用 Seatbelt。Windows 的 `auto` 仍是工具级；Job Object 要显式 `--sandbox jobobject`。`e2b` 控制面与执行是两件事：文档写执行路径没有接上，显式 `--sandbox e2b` 在执行时直接报错，不回落本机。Python 时代的 E2B 端到端不改变这条现状。

现状：NOT VERIFIED。每个平台分开填。

| ID | 通过条件 | 操作 |
| --- | --- | --- |
| F1 自报级别 | `nyra doctor` 打印的隔离级别与这一门实际用的后端一致 | 保存 doctor 原文 |
| F2 越界写 | 在声明的 OS 沙箱下，工作区外写入失败，失败文本能看出是哪条规则 | 各平台一条。工具级回落时，证据写「工具级」，不写「OS 沙箱已验证」 |
| F3 断网 | 默认沙箱里的出站连接失败；显式放开后，同一命令的网络结果按放开后的规则记录 | Linux bwrap 为主。Windows Job Object 的断网若仍靠工具级拦截，证据照实写 |
| F4 e2b 执行 | 未接执行时，命令失败且没有在本机偷偷执行。若将来接上，要有一次真实沙箱内命令、超时和失败关闭的记录 | 不要用控制面 `list/create/kill` 的成功代替执行 |

## 后续增强

这些项不挡住「把阻断项做实」的工作，但在它们 PASS 之前，发布说明不能把它们说成已经完成。

| ID | 现状 | 说明 |
| --- | --- | --- |
| G1 操作系统代码签名与公证 | NOT VERIFIED | [docs/SIGNING.md](SIGNING.md) 写证书未配置、产物未签名，macOS 命令行二进制还有单独的公证路径。PASS 需要在对应系统上对**该 tag 的文件**跑 `signtool` / `codesign` / `spctl` / `stapler` |
| G2 旧 Release 补清单 | 不作为当前 tag 的门 | 同一文档写 v0.5.2–v0.5.11 不回头补。本清单已看到这些 tag 没有校验文件。补签旧产物会改变「构建时」的含义，不在这一版阻断项里 |
| G3 非 Linux 的 live 评测 | NOT VERIFIED | 当前评测文档把 live 限在 Linux。Windows/macOS 要有自己的报告 |
| G4 真实业务闭环 | NOT VERIFIED | 内存测试邮箱、未接通的 Telegram/WhatsApp、Shopify 写操作不在 20 题里 |
| G5 Git 提交 SSH 签名 | UNKNOWN | [docs/SIGNING.md](SIGNING.md) 把它写成维护者本机配置。本清单没有统计 `ab5f432` 的提交签名 |
| G6 多进程预算串行化 | NOT VERIFIED | [docs/budget.md](budget.md) 把同机多进程预留的覆盖窗口写成已知边界 |
| G7 编辑器真机点命令 | NOT VERIFIED | [ROADMAP.md](../ROADMAP.md) 写 JetBrains 未编译、Zed 只验了协议核 |

## 本清单没有做的事

- 没有跑付费或真实模型任务，没有编造新的通过率、花费或人工介入次数。
- 没有在 Windows、macOS 或一台新的 Linux 用户里安装、升级或卸载。
- 没有下载 Release 字节，没有跑 `cosign`、`sha256sum -c`、`gh attestation verify`、`signtool` 或 `codesign`。
- 没有重跑 `bun test`、探针或预算脚本，所以当前全量通过数是 UNKNOWN。
- 没有修改运行时、安装脚本、工作流或 ROADMAP。共享 README、安装文档和历史验证报告里的过期句子仍然留在原处，由 A5 跟踪。
