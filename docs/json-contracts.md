# `--json` 出口统一契约

> 五个出口一份纪律：**只加字段、不改名、不删字段**；客户端按 `schema_version` 判断兼容。

| 命令 | 回答什么 | `schema_version` 常量 |
|---|---|---|
| `nyra verdict --json` | 这次跑得值不值 | `VERDICT_JSON_SCHEMA` |
| `nyra savings --json` | 省了多少 token / 钱 | `SAVINGS_JSON_SCHEMA` |
| `nyra cost --show --json` | 配置了什么（定价 / 上限） | `COST_JSON_SCHEMA` |
| `nyra stats --json` | 实际花了多少、每天多少 | `STATS_JSON_SCHEMA` |
| `nyra redlines --json` | 能不能上生产（红线） | `REDLINES_JSON_SCHEMA` |

## 五条共同属性（`tests/node/test-json-contracts.test.ts` 表驱动锁住）

1. **`schema_version` 是正整数常量**，输出用的就是那个常量（不是另写一个数字）
2. **顶层字段顺序稳定**，`schema_version` 排第一（加字段时插错位置会让快照全红）
3. **JSON 往返不丢字段**
4. **同样输入构建两次结果一致**（无隐藏随机/时间依赖——看板会 diff 前后输出）
5. 各出口自己的业务语义断言留在各自测试文件里（例如"未计价 → `null` 而不是 0"）

## 为什么单列一份契约表

契约属性原本分散在 5 个文件里各测一遍。散着的问题不是重复，而是**加字段时容易漏改其中
一个**，于是契约悄悄分叉。表驱动版本把这五条共同属性钉在一处：新增出口时**只需加一
行**，属性自动覆盖。

## `null` 与 `0` 的分界线（最容易写错的地方）

| 字段 | `null` 含义 | `0` 含义 |
|---|---|---|
| `savings.lines[].tokens_per_turn_saved` | 算不出 | 确实不省 |
| `cost.max_cost_usd` | 没设上限 | 上限为 0 美元 |
| `stats.month_spent_usd` | 本月有调用但没配单价（`incomplete: true`） | 本月真没花钱 |

把"不知道"写成 0，看板会画出**假的下降曲线**，CI 会漏报"没有硬顶"。