// src/localRouterData.ts — 本地小路由的训练数据与标签→成员映射词。
//
// 人工写的典型句式，只做意图分类的训练数据。训练在开发时跑
// （scripts/train-local-router.ts），运行时只读已训好的权重。
// 每类分两份：TRAIN_EXAMPLES 只进训练，HELD_OUT_EXAMPLES 只做
// 验证准确率，训练脚本不许拿留出集训练（防自测 inflated）。

export const LOCAL_ROUTER_LABELS = [
  "code",
  "research",
  "write",
  "ops",
  "chat",
  "spam",
] as const;

export type LocalRouterLabel = (typeof LOCAL_ROUTER_LABELS)[number];

export interface LocalRouterExample {
  label: LocalRouterLabel;
  text: string;
}

export const TRAIN_EXAMPLES: LocalRouterExample[] = [
  // code：写代码、修 bug、跑测试。
  { label: "code", text: "帮我写一个快速排序函数" },
  { label: "code", text: "这段代码有个 bug，帮我修一下" },
  { label: "code", text: "给这个函数补几个单元测试" },
  { label: "code", text: "把这段逻辑重构成一个类" },
  { label: "code", text: "编译报错了，帮我看看什么问题" },
  { label: "code", text: "实现一个登录接口" },
  { label: "code", text: "帮我写个脚本批量改文件名" },
  { label: "code", text: "这个算法时间复杂度能优化吗" },
  { label: "code", text: "前端页面按钮点不动，帮我调试" },
  { label: "code", text: "把回调改成 async await 的写法" },
  { label: "code", text: "空指针异常怎么修" },
  { label: "code", text: "接口太慢了，加个缓存" },
  { label: "code", text: "跑测试失败了，帮我看看原因" },
  // research：查资料、搜索、调研、对比。
  { label: "research", text: "帮我查一下这款手机的最新价格" },
  { label: "research", text: "搜索一下近期的行业新闻" },
  { label: "research", text: "对比一下这两款笔记本的区别" },
  { label: "research", text: "这篇文档讲了什么，帮我总结要点" },
  { label: "research", text: "查一下北京到上海的高铁时刻" },
  { label: "research", text: "帮我找找这个报错是什么意思" },
  { label: "research", text: "调研一下竞品的定价策略" },
  { label: "research", text: "最新的人工智能进展有哪些" },
  { label: "research", text: "推荐几本讲系统设计的书" },
  { label: "research", text: "查一下这家公司的财报数据" },
  // write：写文章、文案、翻译、总结。
  { label: "write", text: "帮我写一篇产品介绍文章" },
  { label: "write", text: "写一段朋友圈文案" },
  { label: "write", text: "把这段话翻译成英文" },
  { label: "write", text: "帮我写封请假邮件" },
  { label: "write", text: "改写一下这段自我介绍" },
  { label: "write", text: "给这篇稿子起个标题" },
  { label: "write", text: "帮我写份简历里的项目经历" },
  { label: "write", text: "把会议纪要整理成报告" },
  { label: "write", text: "润色一下这段产品描述" },
  { label: "write", text: "写个开场白，正式一点" },
  { label: "write", text: "写个视频口播文案" },
  { label: "write", text: "帮我改一下这周的工作总结" },
  // ops：部署、运维、跑命令、看日志。
  { label: "ops", text: "帮我把新版本部署到服务器" },
  { label: "ops", text: "看一下服务器的日志为什么报错" },
  { label: "ops", text: "定时任务每天凌晨三点跑一次" },
  { label: "ops", text: "数据库备份做了吗" },
  { label: "ops", text: "重启一下这个服务" },
  { label: "ops", text: "监控报警了，磁盘快满了" },
  { label: "ops", text: "帮我装一下这个软件的依赖" },
  { label: "ops", text: "域名解析好像出问题了" },
  { label: "ops", text: "看一下现在有几个进程在跑" },
  { label: "ops", text: "把旧版本回滚回去" },
  { label: "ops", text: "帮我看下这台服务器的负载" },
  { label: "ops", text: "部署出问题了，帮我看下日志" },
  // chat：闲聊、打招呼、一般问答。
  { label: "chat", text: "你好，在吗" },
  { label: "chat", text: "今天天气怎么样" },
  { label: "chat", text: "谢谢你，帮大忙了" },
  { label: "chat", text: "你是谁呀" },
  { label: "chat", text: "早上好" },
  { label: "chat", text: "最近怎么样" },
  { label: "chat", text: "闲聊一下，你平时喜欢什么" },
  { label: "chat", text: "再见，明天见" },
  { label: "chat", text: "哈哈，这个挺有意思" },
  { label: "chat", text: "你吃饭了吗" },
  { label: "chat", text: "辛苦了，谢谢" },
  // spam：广告、钓鱼、站外付款。
  { label: "spam", text: "加微信免费领红包，点击链接领取" },
  { label: "spam", text: "投资理财稳赚不赔，加我详聊" },
  { label: "spam", text: "恭喜你中奖了，点链接领奖" },
  { label: "spam", text: "刷单兼职日赚五百，先交保证金" },
  { label: "spam", text: "免费送手机，限时领取，先到先得" },
  { label: "spam", text: "站外付款更便宜，加微信转账" },
  { label: "spam", text: "贷款秒到账，无需抵押，点我申请" },
  { label: "spam", text: "内部消息，跟着买稳赚，加群" },
  { label: "spam", text: "帮我点一下链接，助力领现金" },
  { label: "spam", text: "低价代购名牌包，加微信看货" },
  { label: "spam", text: "加群跟单赚钱，稳赚不赔" },
];

/** 只做验证准确率：训练脚本不许拿它训练。 */
export const HELD_OUT_EXAMPLES: LocalRouterExample[] = [
  { label: "code", text: "写个函数把列表去重" },
  { label: "code", text: "帮我修一下空指针的报错" },
  { label: "code", text: "给这段代码加个缓存" },
  { label: "code", text: "跑测试挂了，帮我定位原因" },
  { label: "research", text: "帮我搜一下这款耳机的评测" },
  { label: "research", text: "查一下这个 API 的用法" },
  { label: "research", text: "对比一下两种方案的优缺点" },
  { label: "research", text: "找一下关于新能源汽车的最新报道" },
  { label: "write", text: "帮我写一封感谢信" },
  { label: "write", text: "把这段中文翻成英文" },
  { label: "write", text: "写个短视频的口播稿" },
  { label: "write", text: "帮我改改这篇周报" },
  { label: "ops", text: "服务挂了，重启一下" },
  { label: "ops", text: "帮我看下这台机器的负载" },
  { label: "ops", text: "把定时任务改成每小时跑一次" },
  { label: "ops", text: "部署失败了，帮我看下日志" },
  { label: "chat", text: "嗨，你在吗" },
  { label: "chat", text: "晚上好" },
  { label: "chat", text: "今天过得怎么样" },
  { label: "chat", text: "谢谢，辛苦了" },
  { label: "spam", text: "点链接免费领会员，先到先得" },
  { label: "spam", text: "加微信送优惠券，立减五十" },
  { label: "spam", text: "投资群带你赚钱，稳赚不赔" },
  { label: "spam", text: "中奖了，点击链接兑换奖品" },
];

/**
 * 标签→成员的映射词：本地路由判出标签后，按成员的 role/name/instructions
 * 里命中几个词打分，挑最高的。spam 没有映射词——垃圾消息不归任何 Bot，
 * 本地路由判出 spam 时直接回落，不静默派给某个 Bot。
 */
export const LABEL_KEYWORDS: Record<LocalRouterLabel, string[]> = {
  code: ["代码", "编程", "程序", "函数", "bug", "调试", "测试", "重构", "编译", "实现", "脚本", "接口", "前端", "后端", "算法", "开发"],
  research: ["查", "搜索", "调研", "资料", "对比", "区别", "价格", "最新", "新闻", "文档", "介绍", "推荐", "评测", "报道"],
  write: ["文章", "文案", "翻译", "总结", "邮件", "简历", "报告", "改写", "润色", "标题", "写作", "文稿"],
  ops: ["部署", "上线", "服务器", "日志", "定时", "备份", "重启", "监控", "安装", "运维", "域名", "数据库", "进程", "服务"],
  chat: ["闲聊", "聊天", "问答", "助手", "客服", "陪聊"],
  spam: [],
};
