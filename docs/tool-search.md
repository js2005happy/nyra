# 工具检索／懒加载

工具一多，模型选工具的准确率非线性下降（BFCL：单函数调用准确率 90%+，
加到 5 个工具就掉一个量级）。Nyra 内置工具 53 个，早过了 30–50 个就
必须检索的拐点。本批把 MCP 已有的懒加载机制扩展到内置工具，并顺带补
了工具描述、依赖链串行化与重复工具合并。

## 常驻核心集 + 按需召回

- **核心集（10 个，常驻）**：`read_file`、`list_dir`、`grep_search`、
  `shell`、`write_file`、`edit_file`、`web_search`、`memory_search`、
  `git_status`、`plan`（`src/toolSearch.ts` 的 `CORE_BUILTIN_TOOLS`）。
  定法有依据：46 题评测集（`~/workspace/nyra-eval-set`，`cases/*.jsonl`
  的 `expect.calls`）里期望调用的分布——`read_file` 10 次、
  `list_dir` / `edit_file` 各 5 次、`shell` 4 次、`grep_search` /
  `web_search` / `memory_search` / `write_file` 各 3 次、`git_status`
  2 次；其余 38 个内置工具在评测任务里一次都没被期望调用。核心集 =
  高频 9 个 + `plan`（“先写计划再执行”是 house 做法，多步任务动手前
  要它在场）。
- **召回**：其余内置工具按任务关键词召回，每轮最多 8 个（总上限
  `BUILTIN_LAZY_LOAD_THRESHOLD = 18`，含核心集）。MCP 池沿用老规则
  （超过 8 个只发最相关的前 8 个）。两池共用同一套 `selectTools` /
  `search_tools` / `deferredTools` 机制，命中工具的完整定义由
  `search_tools` 拉回后追加进本轮 schemas，`describeDeferred` 的说明
  拼进 system prompt 的“未发送的工具”一节。
- **安全底线**：无命中时内置只剩核心集（核心集就是底线，不全量回退）；
  MCP 池无命中时仍全量回退（老行为）；任务为空时两池都全量发送
  （调用方没给任务时不猜，兼容旧行为）；`NYRA_LAZY_TOOLS=0` 一票否决，
  内置 + MCP 都全量（逃生口）。
- **顺序**：`allowedTools` / `disabledTools` 过滤先于检索（白名单外的
  工具既不发送也不进 deferred，模型连检索都检索不到）；参谋长只剩委派
  工具（`delegate` / `delegate_parallel`），Poppy 工具常驻、不进选择池。

## 工具描述补齐

每个内置工具的描述现在都是 3–4 句，写清“这工具是干什么的、何时用、
何时不用、典型误用是什么”（BFCL 误差分析：值错误是主导失败类，多由
描述含糊引起）。描述与工具真实行为逐个核对过，不编造；新增工具评审时
把描述当测试项——`tests/node/test-tool-search.test.ts` 里有测试断言
每个描述都含“何时用／何时不用／典型误用”三段。

## 依赖链串行化

工具元数据里加依赖标记（`src/tools.ts` 的 `TOOL_DEPENDENCIES`，不进
发给模型的 JSON Schema）：

| 依赖方 | 依赖 | 原因 |
| --- | --- | --- |
| `apply_patch`、`edit_file` | `read_file`、`grep_search` | 补丁的 old_text 要先读文件，凭印象拼必错 |
| `browser_click` | `browser_navigate` | 点之前要先打开页面 |
| `computer_click` | `computer_screenshot` | 点的坐标要先看截屏（打字与按键不依赖截屏） |
| `group_session_send`、`group_session_assign` | `group_session_create` | session id 来自 create 的返回 |

规则：依赖方与被依赖方同时出现在一轮里时，依赖方本轮暂缓执行（不执行、
不审批、不计循环守卫），结果里写明原因，模型下一轮看过上游结果再调。
被依赖方不在同轮时不拦（它可能早已在前面的轮次跑过，结果已在上下文里）。
暂缓的调用仍回一条 tool 消息——OpenAI 协议要求每个 tool_call 都有对应
的 tool 结果，所以只拦执行、不拦消息。

并行结果合并：Nyra 的 runLoop 本来就是一轮内串行执行、全部结果在同一轮
一次返回给模型（下一轮 chat 之前消息里已有全部 tool 结果）。字面意义的
“合并进同一条 user 消息”与 OpenAI 的 tool 协议冲突（每个 tool_call
必须有对应的 tool 消息，合并不了），所以这里的实现是“同一轮一次返回”，
不是改消息角色。

## 重复工具合并

审计 53 个工具，只合了一对真正重复的：`memory_delete` 与 `memory_forget`
参数、行为完全相同（同一个 `toolMemoryForget` 分派），文档里自己都写着
“同义”。合并后模型只看得到 `memory_forget`（工具总数 54 → 53）；
`memory_delete` 仍是分派别名（`executeTool` 里同案处理，审批、钩子、
MUTATING_TOOLS 名单里也还认它），老脚本与老技能按旧名调仍能执行，只是不
再发给模型选。其余都没合：`memory_search` / `knowledge_search` /
`session_search` 是三个不同的库（长期记忆／外部文档／旧会话）；
`edit_file` / `apply_patch` / `write_file` 接口与安全属性不同（单处精确
替换／严格 diff／全文覆盖）；`delegate` / `delegate_parallel` 能力不同
（单任务／并行扇出 + 合并步）；`web_fetch` / `web_search`、`gmail_search` /
`gmail_read` 等都是不同操作，不是重复。

## 诚实边界

- 只在临时 home / 假 provider 上验过；真模型没跑；真机未验证。
- 关键词召回是确定性词匹配（名字权重最高，描述次之），不是向量检索；
  描述措辞会直接影响召回质量，改描述时要想到这一层。
- 核心集的依据是 46 题评测集的期望调用分布，不是生产用量——生产用量
  上来后值得按真实分布再调一次核心集。
