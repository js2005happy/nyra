# 公开发布验收与证据清单

本文件是公开发布的验收门。安装、签名、沙箱、预算、取消、续跑和评测的行为说明仍在各自文档里；这里只规定哪一条门必须有哪一种证据，以及对照当时的 `main` 时这些门停在哪里。

这次对照的 `main` 是 [b1e3d7c0fa27744b97fdf0b1876ccfdac4fe9f96](https://github.com/js2005happy/nyra/commit/b1e3d7c0fa27744b97fdf0b1876ccfdac4fe9f96)（2026-11-25 12:02 +0800，`Document one-way compile rule and CHANGELOG`）。核对日期是 2026-11-26。上一版清单写的是 `ab5f432` 和未发布的 `v0.5.12`；那些句子以这一版为准。

本清单没有跑付费模型任务，没有在干净机器上安装，没有下载安装包字节，没有跑 `cosign`（这台机器上也没有这个命令），没有打 tag，也没有合并。空白证据槽保持空白。没有一门是 PASS。

## 状态词

| 状态 | 含义 |
| --- | --- |
| PASS | 本文件引用的当前证据表明这一门已经成立。模拟测试、旧提交上的报告、工作流文件存在、附件名字出现在 Release 上，都不能单独写成 PASS。 |
| NOT MET | 已经看到与这一门相反的事实。 |
| NOT VERIFIED | 有设计、有命令、有附件或有旧记录，但没有对当前候选版本的实测证据。 |
| UNKNOWN | 这一项没有查到足够的事实，不能写成通过或失败。 |

通过条件写在每一门里。证据槽留空，由做实测的人填：日期、机器、操作者、命令、退出码、原样输出、产物哈希、花费、以及不知道的项。缺用量记 UNKNOWN，不补成 0。

## 两套运行时

当前仓库是 TypeScript，由 Bun 执行和打包。

- [package.json](../package.json) 要求 `bun >= 1.4.0`。这次读到的 `version` 是 `0.5.15`。
- [src/config.ts](../src/config.ts) 的 `VERSION` 同样是 `0.5.15`。
- 发布用的单文件二进制由 Bun `--compile` 产生。安装脚本写明使用者不需要另装 Python、Node 或 Bun。见 [scripts/install-node.sh](../scripts/install-node.sh)。
- 现行测试工作流是 [.github/workflows/node-ci.yml](../.github/workflows/node-ci.yml)。文件头写明：0.4.0 起它是唯一测试工作流，Python CI 与旧的 Windows exe 工作流已随 Python 删除。矩阵是 Ubuntu / Windows / macOS，Bun 1.4.4。

[VERIFICATION.md](../VERIFICATION.md) 记录的是 2026-11-16 的 Python 0.3.0。Python 树已在 0.4.0 删除。文件里的 unittest 次数、GitHub Actions Python 矩阵，以及「真实 DeepSeek + 真实 E2B 沙盒端到端」都属于那棵 Python 树。它们不给当前 TypeScript 二进制任何一门 PASS。

[docs/node-migration-phase1.md](node-migration-phase1.md) 是 2026-11-18、基线 `d2eb6d9` 的第 1 阶段实测笔记。那份笔记里的耗时和通过数属于那个工作树，不转移到 `b1e3d7c`。

[src/eval/apiProvider.ts](../src/eval/apiProvider.ts) 的 DeepSeek 评测通道会启动仓库外的连接器助手 `deepseek.py`。这是评测记账用的外部助手，不是已删除的 Nyra Python 包。

## 评测记录：范围和新鲜度

仓库里有多份 20 题记录。它们测的不是同一个提交，也不能合成一个「当前成功率」。[src/eval/runner.ts](../src/eval/runner.ts) 的 `summarizeEval` 里，`passed` / `failed` / `blocked` / `successRateAll` 只数每次任务的第一次尝试；`recoveredOnRetry` 另计，不回填进首次通过率。`spentUsd` 在任一尝试的花费为 null 时整份报告为 null。连接器题用的是内存测试传输层，[docs/eval.md](eval.md) 写明那不是真实 Gmail。live 执行只声明了 Linux。

| 记录 | 提交是否在 `b1e3d7c` 的历史上 | 范围 | 新鲜度 |
| --- | --- | --- | --- |
| [baseline-840a522.json](eval-results/baseline-840a522.json)，叙述在 [docs/eval.md](eval.md)「本轮基线」 | 是 | 2026-11-22T03:59:14Z。Ollama `qwen2.5:7b`，Linux x64，Bun 1.4.5。20 题全部 `blocked`，原因 `local-model-unavailable`。模型调用 0，花费 $0，`unknownCostAttempts` 0。文件写明这是前置条件记录 | 叙述没有收录后来的 DeepSeek JSON |
| [baseline-deepseek-flash-840a522.json](eval-results/baseline-deepseek-flash-840a522.json) | 文件在 main 上。`sourceRevision` 是 [bb42f7f](https://github.com/js2005happy/nyra/commit/bb42f7f7d32658db746ae6cf74f55605b65b4419)，在 `origin/codex/reliability-eval-batch1`，不是 `b1e3d7c` 的祖先。文件名里的 `840a522` 与 `sourceRevision` 不一致 | 2026-11-22T04:41:43Z。`deepseek-flash`。首次尝试 0 通过、10 失败、10 阻塞。20 次失败尝试的 `spentUsd` 为 null，`modelCalls` 为 0，摘要 `spentUsd` 为 null | 早于后续有模型调用的报告 |
| [baseline-deepseek-flash-ba0153c.json](eval-results/baseline-deepseek-flash-ba0153c.json) | 是 | 2026-11-22T07:03:31Z。首次尝试 8 通过、2 失败、10 阻塞。`knownSpentUsd` 0.0264654，未知花费次数 0。`research-03` 两次都失败；`connector-04` 重试后通过 | 只覆盖当时能执行的 10 题 |
| [baseline-deepseek-flash-c964252.json](eval-results/baseline-deepseek-flash-c964252.json) | 是。[c964252](https://github.com/js2005happy/nyra/commit/c96425211be7e132f085b6f1c2bef3ee23289cc9) 比 `b1e3d7c` 早 351 个提交 | 2026-11-22T07:53:38Z。Linux x64，Bun 1.4.4，Chrome 158。首次尝试 18 通过、2 失败（`research-01` 重试通过，`research-03` 两次失败）。模型调用 96，`knownSpentUsd` 0.05848980000000001，未知花费次数 0，人工介入 0 | [ROADMAP.md](../ROADMAP.md) 可靠性第 3 行的「20 题 $0.0585」与这份已知花费的四舍五入相符。那一行没有写这份报告属于 `b1e3d7c` |
| [baseline-deepseek-flash-91a6132.json](eval-results/baseline-deepseek-flash-91a6132.json) | 是。[91a6132](https://github.com/js2005happy/nyra/commit/91a6132bfecce2554e4500a3b3335be9895c8615) 比 `b1e3d7c` 早 96 个提交 | 2026-11-24T12:04:44Z 至 12:08:24Z。`deepseek-flash`，Linux x64，Bun 1.4.4，Chrome 158，`modelDigest` null。首次尝试 19 通过、1 失败（`research-03`，`acceptance-failed`），重试通过，`recoveredOnRetry` 1。模型调用 88，`knownSpentUsd` 0.05379029999999999，未知花费次数 0，人工介入 0 | 比路线图引用的那份更新，仍然不是 `b1e3d7c` 或 `v0.5.15` 构建提交的报告 |

[docs/eval-results/verification-840a522.json](eval-results/verification-840a522.json) 把 2026-11-22 的全量记成 3241 通过、13 失败，并写 `readyForUnqualifiedRelease: false`。本清单没有重跑 `bun test`，所以 `b1e3d7c` 的通过条数是 UNKNOWN。

2026-11-26 看到的 Node CI：[run 45544210580](https://github.com/js2005happy/nyra/actions/runs/45544210580) 的结论是 `success`，提交就是 `b1e3d7c`。四个作业（Ubuntu / Windows / macOS 的 Bun 1.4.4，以及 Ubuntu 启动与内存预算）的结论都是 `success`。本清单没有打开作业日志，没有抄测试条数。这次成功是托管 runner 上的源码测试，不是干净机器安装，也不是真实模型任务。

## 已挂上的发布产物

签名工作流 [.github/workflows/release-sign.yml](../.github/workflows/release-sign.yml)、事实检查 [.github/workflows/release-facts.yml](../.github/workflows/release-facts.yml) 和 [scripts/verify-release.sh](../scripts/verify-release.sh) 是接线。[tests/node/test-release-verify.test.ts](../tests/node/test-release-verify.test.ts) 用本地夹具检查解析。接线、工作流成功和夹具测试都不给签名门 PASS。

2026-11-26 用 Release API 按 tag 看了附件名。下表「有四个校验文件」指列出了 `SHA256SUMS`、`SHA256SUMS.sig`、`SHA256SUMS.pem`、`SHA256SUMS.bundle`。没有下载安装包，没有跑 `cosign verify-blob`，也没有跑 `sha256sum -c`。`v0.5.15` 的 `SHA256SUMS` 对象大小是 1406 字节，`.bundle` 是 8585 字节，`.pem` 是 3320 字节，`.sig` 是 96 字节；大小只说明文件不是空的。GitHub 资产上的 `digest` 字段不是 Nyra 的清单。

| Tag | 这次看到的记录 | 校验文件 |
| --- | --- | --- |
| [v0.5.15](https://github.com/js2005happy/nyra/releases/tag/v0.5.15) | 2026-11-25T02:20:51Z，当前最新。20 个附件：5 个 Node 二进制、带版本号的桌面包（`.deb`、AppImage、`.dmg`、`.msi`、`-setup.exe`）、同内容的稳定名副本、`nyra-android.apk`，加上四个校验文件 | 有。哈希与签名是否验得过：NOT VERIFIED |
| [v0.5.14](https://github.com/js2005happy/nyra/releases/tag/v0.5.14) | 2026-11-24T17:04:32Z。20 个附件，文件名模式与 v0.5.15 相同 | 有。NOT VERIFIED |
| [v0.5.13](https://github.com/js2005happy/nyra/releases/tag/v0.5.13) | 2026-11-24T15:35:11Z。21 个附件，另含 `nyra-android-debug.apk` | 有。NOT VERIFIED |
| [v0.5.12](https://github.com/js2005happy/nyra/releases/tag/v0.5.12) | 2026-11-24T12:59:09Z。15 个附件，没有稳定名副本 | 有。NOT VERIFIED |
| [v0.5.11](https://github.com/js2005happy/nyra/releases/tag/v0.5.11) | 2026-11-23T18:09:30Z。15 个附件。2026-11-24 早上的清单曾看到没有校验文件；这次再查，四个校验文件已经在页面上。[docs/SIGNING.md](SIGNING.md) 写这是当天手动补签，证明的是补签时的文件，不是构建时来源 | 有。NOT VERIFIED |
| v0.5.2、v0.5.3、v0.5.4、v0.5.5、v0.5.6、v0.5.7、v0.5.8、v0.5.9、v0.5.10 | 这次按 tag 重查。附件数分别是 5、10、11、11、11、11、11、11、11 | 无 |
| [v0.5.1](https://github.com/js2005happy/nyra/releases/tag/v0.5.1) | 2026-11-19T12:30:15Z。11 个附件 | 有。NOT VERIFIED |
| v0.5.0、v0.4.0 | 这次重查，分别是 7 个和 5 个附件 | 无 |

[Release facts 的定时运行 45617795954](https://github.com/js2005happy/nyra/actions/runs/45617795954) 在 `b1e3d7c` 上的结论是 `success`（2026-11-25T12:51:29Z）。工作流说明写它会对默认版本的二进制和 `SHA256SUMS` 做 1 字节 GET。本清单没有打开该日志，不把这次成功写成安装、哈希或签名通过。

三份安装脚本的默认版本现在都是 `v0.5.15`。见 [scripts/install-node.sh](../scripts/install-node.sh)、[scripts/install-node-macos.sh](../scripts/install-node-macos.sh)、[scripts/install-node.ps1](../scripts/install-node.ps1)。`--from-file` 不联网、不校验。

[docs/SIGNING.md](SIGNING.md) 现在写四层：Release 清单的 keyless 签名、维护者本机的 Git SSH 签名、Windows/macOS 商业证书签名、安卓 APK 签名。第 3 层仍写证书未配置、Windows/macOS 产物未签名或未公证。第 4 层写 0.5.14 起 APK 正式签名（CN=Nyra）。本清单没有对 exe、dmg、msi 或 apk 跑 `signtool`、`codesign`、`apksigner` 或 `spctl`，所以这些操作系统签名结论都是 NOT VERIFIED。

## 版本身份

[docs/installers.md](installers.md) 要求发版时六处版本一起升。这次在 `b1e3d7c` 上读到的六处，以及 `desktop/src-tauri/Cargo.lock` 里的 `nyra-desktop`，都是 `0.5.15`，没有 `-dev`。没有运行发布出去的二进制，所以 `nyra --version` 的原样输出仍是 NOT VERIFIED。

[docs/windows-install.md](windows-install.md) 一处写 `nyra 0.5.15 (node runtime)`，另一处仍写 `nyra 0.5.2 (node runtime)`。本清单不改那份文档。

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

这些门在把一个 tag 称为已验收之前要有 PASS。当前没有一门是 PASS。

### A. 身份、tag 与校验产物

| ID | 现状 | 通过条件 | 操作 | 证据槽 |
| --- | --- | --- | --- | --- |
| A1 版本六处一致，且二进制自报同一版本 | NOT VERIFIED。六处源码字符串和 Cargo.lock 的 `nyra-desktop` 都读到 `0.5.15`。没有运行二进制 | 六处与即将分发的 tag 一致，且该 tag 的 `nyra --version` 原样输出同一版本 | 对照 [docs/installers.md](installers.md)。在每个平台的已发布二进制上跑 `--version` | |
| A2 默认安装指向已发布且带清单的 tag，并且安装成功 | NOT VERIFIED。三份脚本钉 `v0.5.15`，该 Release 存在，并列出非空 `SHA256SUMS` 与 `.bundle`。没有执行安装 | 不改脚本，默认安装退出码 0，装上的二进制通过 A3 | 三平台各一次。缺清单时的拒绝要单独记录，那个拒绝不是安装成功 | |
| A3 清单签名与哈希 | NOT VERIFIED。v0.5.12 至 v0.5.15 以及 v0.5.11、v0.5.1 都列出了四个校验文件。没有验签，没有逐文件对哈希 | 对这个 tag 下载全部附件后，`bash scripts/verify-release.sh <tag>` 退出码 0，并且 `sha256sum -c` 覆盖要分发的文件 | 按 [docs/SIGNING.md](SIGNING.md)。不要用夹具测试或 Release facts 的 1 字节 GET 代替 | |
| A4 来源证明 | NOT VERIFIED。已查看的附件名里没有 `*.intoto.jsonl`。[docs/installers.md](installers.md) 写 SLSA 证明不挂附件 | `gh attestation verify <文件> --repo js2005happy/nyra` 对每个对外分发的文件成功，并把证明 URL 写入证据槽 | 见 [docs/SIGNING.md](SIGNING.md) | |
| A5 文档与附件一致 | NOT MET。[README.md](../README.md) 现在指向的稳定名 `Nyra-linux-amd64.deb` 与 `Nyra-linux-x86_64.AppImage` 在 v0.5.15 上存在。[docs/installers.md](installers.md) 仍写一个 Release 应有 13 个附件，而 v0.5.15 列出 20 个；它还有一句把缺失范围写成 v0.5.2–v0.5.11，与这次看到的 v0.5.11 四个校验文件不符。[docs/windows-install.md](windows-install.md) 同时要求 `--version` 打出 `0.5.15` 和 `0.5.2` | 安装文档列出的每个下载名都在该 tag 上；文档写「没有」的文件确实不在页面上；同一文档里的版本句子一致 | 对照本文件的附件表。本 PR 不改 README 和安装文档 | |

### B. 干净机器：安装、向导、升级、卸载

三个操作系统各做四步。现状全部 NOT VERIFIED。Windows 与 macOS 安装文档里仍有「还没在真机上跑通」的旧句子；那些句子是文档边界，不是这次的新实测。

| ID | 通过条件 | 操作 |
| --- | --- | --- |
| B1 安装 | 默认下载通过 A2 与 A3。另做一次 `--from-file`：二进制就位，`nyra --version` 与候选一致，不要求机器预装 Python/Node/Bun。Linux 动态链接需要的 glibc 写进证据 | Linux：[docs/linux-install.md](linux-install.md)。macOS：[docs/macos-install.md](macos-install.md)。Windows：[docs/windows-install.md](windows-install.md) 与 `install-node.ps1`。记录 SmartScreen / Gatekeeper 的原样提示 |
| B2 首次向导与第一次任务 | 向导跑完本地示例后，输出明确那是本地示例，不是模型任务。无 Key 时模型任务退出码 1，且不发出模型请求。有 Key 或已启动的本地模型时，另做一次真实的「交互审批后改一个文件」 | 本地示例来自 `nyra setup`。不要把示例任务的 SQLite 计数写成模型通过 |
| B3 升级 | 升级替换二进制，`~/.nyra` 里预先放下的标记文件还在，配置没被脚本改写 | 再跑对应安装命令。Linux/macOS 文档写「重复跑就是升级」。Windows 用同一脚本再装一次，并记录 PATH 与快捷方式是否重复 |
| B4 卸载 | 二进制、启动器、用户服务文件和 Windows 快捷方式被删掉；`~/.nyra` 仍在，除非操作者另外手动删除 | Linux：`bash scripts/install-node.sh --uninstall`。macOS：`bash scripts/install-node-macos.sh --uninstall`。Windows：`.\install-node.ps1 -Uninstall`。[docs/windows-install.md](windows-install.md) 正文目前没有卸载节，证据以脚本行为为准 |

每个系统的 B1–B4 分开填证据槽。一个系统通过不能填进另一个系统。

### C. 真实模型任务基线

现状：NOT VERIFIED（对 `b1e3d7c` 和已发布的 `v0.5.15`）。上表 JSON 只证明它们各自的提交和条件。`91a6132` 是目前 main 上最新的一份 DeepSeek 报告，仍早于这次对照的 main 96 个提交。

通过条件：

1. 用 [docs/eval.md](eval.md) 的入口新跑一份报告。`sourceRevision` 等于要发布的提交全长。旧报告因源码或环境变化不能重跑时，新建基线，不要改旧文件的数字。
2. 报告写明日期、provider、模型名、单价、`maxCostUsd`、轮数、超时、操作系统、架构、Bun 版本、Node 版本、浏览器版本、模型 digest（API 模型按现有通道记 null，并写明 null 的原因）。
3. 每题保留每次尝试的状态、失败或阻塞原因、验收项、花费、模型调用数、人工介入、`runId`。首次通过率与重试挽回分开，口径用 `summarizeEval`。
4. `unknownCostAttempts` 与 `unknownInterventionAttempts` 原样保留。有未知花费时，对外句子写「已知花费下界」和未知次数。
5. 连接器题若仍走内存测试传输层，结论里写明没有真实投递。真实邮箱、Shopify、Slack 要另开证据。
6. 非 Linux 没有 live 运行时，写成该平台 NOT VERIFIED。
7. 私有目录 `.eval-runs/` 不提交。公开证据用报告 JSON、验收指纹和本证据槽。

操作：`bun run scripts/eval.ts run --out <新文件>`。需要付费 provider 时由发布负责人在预算内执行。假 provider 的 `bun test` 不满足这一门。

### D. 预算，含缺用量

行为说明在 [docs/budget.md](budget.md)。严格模式默认开：有美元上限时，未配单价或调用没报用量会暂停，不编一个金额，也不发下一轮。文档仍写这套暂停在假 provider 与本地检查上验过，并写「真 API 未跑通」。`c964252` 与 `91a6132` 说明评测架子在那两个提交上从返回的用量算出了美元数；它们没有记录一次因触顶而拒绝的真实调用，也没有记录一次缺用量暂停。

现状：NOT VERIFIED。不要把预算单元测试、ROADMAP 的 `$0.0585` 或 `91a6132` 的 `$0.0537903` 写成这一门 PASS。

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
| E3 撤销 | NOT VERIFIED | 撤销之后的下一次动作被拒绝。撤销前已经完成的动作保留在审计里 | 写明测的是哪一种撤销：信任圈 `nyra circle revoke`（[docs/circles.md](circles.md)）、脚本预授权 `nyra script preauth revoke`、SCIM `nyra sso scim revoke-token`、连接器卸载时的授权撤销。测一种不能代替另一种 |
| E4 崩溃后续跑 | NOT VERIFIED | 进程杀掉后，`nyra --resume-run <运行 ID>` 能说明恢复到哪一步。可核查的写文件若已生效，不重复写；读回不一致时会再执行 | 见 [docs/resume.md](resume.md)。可核查工具只有 `write_file`、`edit_file`、`plan`、`memory_append`、`save_skill` |
| E5 外部副作用不重复 | NOT VERIFIED | 一次外部发送在崩溃或重试后仍然只发生一次。若实现不能证明「已经发出」，就保持失败或待人工处理，不能自动再发一次 | [docs/resume.md](resume.md) 与 [docs/idempotent-retry.md](idempotent-retry.md) 写明 `shell`、`http_post`、浏览器/电脑操作、`delegate`、MCP 不参与自动去重。[docs/kanban.md](kanban.md) 的 `nyra side-effects recover` 要求先核对再决定。证据要包含供应商或测试双端上的发送次数 |

E4 通过不等于 E5 通过。本地文件读回一致，推不出邮件或 HTTP 没有发第二次。

### F. 沙箱与平台边界

行为以 [docs/sandbox.md](sandbox.md) 为准。`auto` 在 Linux 且有 bwrap 时用 bubblewrap，默认断网；没有 bwrap 时退回工具级限制并说明。macOS 有 `sandbox-exec` 时用 Seatbelt。Windows 的 `auto` 仍是工具级；Job Object 要显式 `--sandbox jobobject`。`e2b` 的控制面与执行是两件事：文档写执行路径没有接上，显式 `--sandbox e2b` 在执行时直接报错，不回落本机。Python 时代的 E2B 端到端不改变这条现状。

现状：NOT VERIFIED。每个平台分开填。

| ID | 通过条件 | 操作 |
| --- | --- | --- |
| F1 自报级别 | `nyra doctor` 打印的隔离级别与这一门实际用的后端一致 | 保存 doctor 原文 |
| F2 越界写 | 在声明的 OS 沙箱下，工作区外写入失败，失败文本能看出是哪条规则 | 各平台一条。工具级回落时，证据写「工具级」 |
| F3 断网 | 默认沙箱里的出站连接失败；显式放开后，同一命令的网络结果按放开后的规则记录 | Linux bwrap 为主。Windows Job Object 的断网若仍靠工具级拦截，证据照实写 |
| F4 e2b 执行 | 未接执行时，命令失败且没有在本机执行。若将来接上，要有一次真实沙箱内命令、超时和失败关闭的记录 | 不要用控制面 `list/create/kill` 的成功代替执行 |

## 后续增强

这些项不挡住「把阻断项做实」的工作。在它们 PASS 之前，发布说明不能把它们说成已经完成。

| ID | 现状 | 说明 |
| --- | --- | --- |
| G1 Windows/macOS 代码签名与公证 | NOT VERIFIED | [docs/SIGNING.md](SIGNING.md) 与 [README.md](../README.md) 写 Windows 未签名、macOS 只有 ad-hoc、未经公证。PASS 需要在对应系统上对这个 tag 的文件跑 `signtool` / `codesign` / `spctl` / `stapler` |
| G1b 安卓 APK 签名 | NOT VERIFIED | 同一文档和 README 写 0.5.14 起签名者 CN=Nyra。本清单没有跑 `apksigner` |
| G2 v0.5.2–v0.5.10 的清单 | 不作为 v0.5.15 的门 | 这次重查，这些 tag 没有四个校验文件。v0.5.11 已经有文件，但没有验签。补签旧产物的含义见 [docs/SIGNING.md](SIGNING.md) 对 v0.5.11 的说明 |
| G3 非 Linux 的 live 评测 | NOT VERIFIED | 当前评测文档把 live 限在 Linux |
| G4 真实业务闭环 | NOT VERIFIED | 内存测试邮箱、未接通的渠道和 Shopify 写操作不在这 20 题里 |
| G5 Git 提交 SSH 签名 | UNKNOWN | [docs/SIGNING.md](SIGNING.md) 把它写成维护者本机配置。本清单没有统计 `b1e3d7c` 的提交签名 |
| G6 多进程预算串行化 | NOT VERIFIED | [docs/budget.md](budget.md) 把同机多进程预留的覆盖窗口写成已知边界 |
| G7 编辑器真机点命令 | NOT VERIFIED | [ROADMAP.md](../ROADMAP.md) 写 JetBrains 未编译、Zed 只验了协议核 |

## 本清单没有做的事

- 没有跑付费或真实模型任务，没有编造新的通过率、花费或人工介入次数。
- 没有在 Windows、macOS 或一台新的 Linux 用户里安装、升级或卸载。
- 没有下载 Release 里的安装包字节，没有跑 `cosign`、`sha256sum -c`、`gh attestation verify`、`signtool`、`codesign` 或 `apksigner`。
- 没有重跑 `bun test`、探针或预算脚本，所以当前全量通过条数是 UNKNOWN。
- 没有修改运行时、安装脚本、工作流、README 或 ROADMAP。A5 记下的文档差异留在原文件里。
