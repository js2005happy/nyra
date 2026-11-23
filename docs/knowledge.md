# 外部文档知识库（缺口 33 第一批 + 第二批）

缺口 1 只解决“Nyra 自己的记忆”检索；用户的外部文档（PDF、手册、网页）
没有 ingestion→分块→检索→重排的管道，更没有检索测试台。第一批补：
外部文档收录 + 确定性分块 + BM25 检索 + 检索测试台，检索结果带出处进
证据链。第二批补：parent-child 分块、确定性 rerank、中文 PDF 抽取。
向量检索、多知识库合并重排、数据集级 API key 仍未做（见末节）。

## 收录什么

`nyra kb`（`nyra knowledge` 同义）复用缺口 1 的存储（`~/.nyra/knowledge/<库名>/`，
`kb.json` + `notes.jsonl`，原子写 0600）：

| 来源 | 命令 | 说明 |
|---|---|---|
| 文本 / Markdown | `nyra kb add <库> --file <文件>` / `--dir <目录>` | `.txt` / `.md`，目录递归收 |
| PDF | `nyra kb add <库> --file <文件.pdf>` | 最小文本抽取（见下） |
| 网页 | `nyra kb add <库> --url <网址>` | 抓正文（20 秒超时，只认 text/html） |
| 手动输入 | `nyra kb add <库> --text <文本> [--title <标题>]` | 直接写一段 |

分块是确定性的：按 Markdown 标题切节、段落拼块、超 1500 字在句末处切断，
每块带 ID、标题（章节）、来源（文档名或网址）、日期（文件 mtime 或今天）。
不调模型、不花 token。

**第二批 parent-child**：父块（≤1500 字）再切子块（≤300 字，句末优先
断开；父块本身 ≤300 字时不另切）。检索按子块精确匹配打分，命中后返回
父块全文，并在父块上挂 `matchExcerpt`（命中子块原文，工具输出与测试台
摘录都优先用它）；同一父块的多个子块命中时只返回一个父块结果（取最高分
那块）。老库（只有父块、没有子块）照样能查，短父块本身就是评分单元。
`nyra kb list` 的条数只计父块。

PDF 文本抽取（第二批）：FlateDecode 压缩与未压缩的内容流，取括号
字面量字符串（Tj / TJ）与十六进制字符串，带 ToUnicode CMap 的字体按
CMap 解码（bfchar / bfrange，含数组式 bfrange；中文 PDF 只要带 ToUnicode
就能读）。以下情况直接报错或跳过、不假装读到了：

- 不是 PDF、超过 20MB；
- 抽不出文本（扫描件、加密 PDF）；
- 无 ToUnicode 且非 ASCII 的十六进制串（那是字形编号，宁可不返回也不
  返回乱码）、/Differences 自定义编码——复杂 PDF 请先转文本再收录。

## 检索

`nyra kb search <库> <问题>`，或 agent 在运行里调 `knowledge_search` 工具。
参数面是 Dify 已验证的三样：

- `--top-k N`（默认 5）：最多返回几条；
- `--min-score X`：最低分，低于的不返回（默认 0）；
- `--source <子串>`：只查来源含该子串的文档（如某个文件名）；
- `--date-from <YYYY-MM-DD>` / `--date-to <YYYY-MM-DD>`：只查该段时间内的文档。

检索是 BM25（英文词 + 中文单字与二元组，与缺口 1 同一套公式；笔记数
达到 100 条时评分挪到 worker 池）+ 确定性 rerank：先取 topK×3 个
BM25 候选，按 `BM25 ×（1 + 0.3 × 查询词覆盖率 + 0.2 × 标题命中）`
重排（覆盖率 = 查询词在命中文本里的去重覆盖比例；标题命中 = 标题含
任一查询词；权重是常量，见 `src/knowledge.ts` 的 COVERAGE_BOOST /
TITLE_BOOST）。每条结果附出处：文档名、章节、分数与命中片段摘录
（有子块时是命中子块原文，否则是父块前 200 字）。

`--no-rerank` 关掉重排、只按 BM25 排序（测试台调参对比用）。

`knowledge_search` 是只读工具，不需审批。每次检索的记录（问了什么、

`knowledge_search` 是只读工具，不需审批。每次检索的记录（问了什么、
命中几条、每条出处与分数）进证据链：有运行上下文时写该运行的
`knowledge_search` 事件（`src/runs.ts` 的 EVENT_FIELDS 已注册，
`src/timeline.ts` 有渲染），没有时写 `evidence/knowledge/` 下的证据文件。
这样“这句话是模型编的还是文档里有的”可以回溯原文、可以审计。

## 检索测试台

`nyra knowledge test <库> --file <问题文件> [--top-k N] [--min-score X] [--source S] [--date-from D] [--date-to D] [--no-rerank] [--json]`

问题文件每行一个问题（空行与 `#` 开头的行跳过）。输出每题的命中
（分数、标题、来源、日期、命中片段）与汇总（共几题、几题有命中、命中题的平均
最高分）。调参对比就是换一组参数再跑一次：`--json` 出机器可读结果，
方便 diff 两次跑法。测试台是诊断用的，只读、不调模型、不花 token、
不写证据。

调参的一般顺序：先看无命中的题是“库里真没有”还是“参数太严”
（min-score 先放 0、top-k 放大）；再看命中排第一的是不是想要的那篇，
不是就收紧 source 或日期范围；怀疑重排帮倒忙时用 `--no-rerank` 跑一遍
对比 BM25 原序；最后才调 top-k。

## 命令一览

`nyra kb <create|list|add|search|ask|remove|test>`，`nyra knowledge` 与 `kb` 同义。
`ask` 仍是缺口 1 的问答（只按库内笔记回答，库内没有就直说不知道）。

## 还没做的

向量检索（`src/providers.ts` 没有 embeddings 通道，要接须新增模型方
能力 + 成本口径，本批只留了接口位：`scoreBm25` 与 rerank 的管线是
纯函数，向量分加进来时当第三路信号拼进同一条 rerank）、多知识库
合并重排、数据集级 Knowledge API key（按知识库授权）。
