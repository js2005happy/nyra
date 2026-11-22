# 单写者门与零工具编排者（第 1 批 G-P0-4、G-P0-5）

群聊/团队里同一时间只允许一个 agent 写同一个文件，写者名额由参谋长持有、
显式移交；参谋长本人从工具层面拿掉写工具，只剩委派工具。

## 单写者门（G-P0-4）

```bash
nyra team writer status                       # 看本团队当前谁拿着哪些文件的写名额
nyra team writer transfer <文件> <成员>       # 参谋长把某文件的写名额移交给成员
nyra team writer release <文件> [--yes]       # 参谋长收回某文件的写名额
```

规则：

- 租约键 =（团队，工作区相对路径），TTL 1 小时。过期租约下次查门时清掉。
- 没租约：参谋长写放行，成员写被拒（名额默认在参谋长手里，请参谋长先移交）。
- 有租约：持有者本人放行，别人被拒并报出持有者。
- 租约只在写操作真落地后才记：参谋长首次写某文件，查门只放行不占名额，
  写成功后才记租约。写被模式/审批/审查拦下时不占名额、不发 granted 事件——
  否则一次没落地的写白白占租约一小时，别人写同一文件要等租约过期。
- 移交：分派时 `delegate` / `delegate_parallel` 传 `write_files`（文件列表），
  子任务开始前移交、结束时自动还回（还不回的在 `try/finally` 里清）；
  移交失败直接拒绝委派，不先跑一半再发现写不了。`nyra team writer transfer`
  是手工移交入口（只有参谋长或当前持有者能移交）。
- 被拦的写操作绝不重试：拒绝文案“单写者门拦截”进了
  `APPROVAL_REFUSAL_MARKERS`，幂等重试认标记不重试——重试只会再被同一道
  门拦下，跳过门去执行等于把两个 agent 同时写同一文件的竞态放进来。
- 账本 `~/.nyra/write-gate.json`（原子写 0600，损坏先备份再抛错，
  备份名 `write-gate.json.corrupt-<毫秒>`，符号链接拒绝）；
  审计 `~/.nyra/write-gate-audit.jsonl`（只记团队 id、相对路径、持有者）。
  事件只记相对路径，不记绝对路径。

## 零工具编排者（G-P0-5）

参谋长“不写业务代码”以前只写在任务文本的提示词里，模型不遵守就没办法。
本批从工具层面拿掉：

- 参谋长角色的 agent 构造时，其余全部工具加进 `disabledTools`，`toolSchemas()`
  只发 `delegate` 与 `delegate_parallel`（`ORCHESTRATOR_TOOLS`），MCP 工具与
  只读工具也不发。
- 执行层再拦一道：模型幻觉调出被拿掉的工具（包括 `mcp_*` 前缀）时，
  runLoop 直接拒绝、不进 `executeTool`。
- 限制是参谋长这个角色的，不是人的：委派出去的子 agent 不继承这份禁用，
  成员拿回完整工具集；显式传的 `disabledTools` 照常继承。

注意：这和 H-7 的 `orchestrator`（子 agent 再往下分派的开关）是两回事——
H-7 管“能不能再委派”，这批管“参谋长本人能不能写”。

## 账本与证据链

- 4 个新运行事件已注册进 EVENT_FIELDS（`write_gate_granted` / `denied` /
  `transferred` / `released`），`src/timeline.ts` 加渲染；只记团队 id、
  相对路径、持有者，不记绝对路径。`granted` 只在首次拿到新租约时发一次，
  已持有者续写不发，不刷事件链。
- 参谋长的任务文本（`buildChiefTask`）多了一条：写文件须走 `write_files`
  移交。提示词是第二道防线，工具层是第一道。

## 已知局限

- 门只管 `write_file` / `edit_file` / `apply_patch` 三个写工具；shell 里
  的写操作（`echo > file`、`sed -i`）不走门，仍靠审批与权限边界管。
- 租约是文件级、不是行级：同一文件的两处不同行也不能两个人同时写。
- 跨进程同时抢同一文件有竞态窗口（后写的以最新文件重算），同一进程内
  的并发查门是原子的（整段查门都是同步文件操作）。
- 真实多 agent 场景只在假 provider 上验过；Windows/macOS 真机未验证。
