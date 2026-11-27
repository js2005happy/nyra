// src/mobileExplore.ts — 探索页任务模板（Cue 方向 B 批）。
//
// 模板只是“开场白”：点模板后在群聊里开一轮执行，群聊里的 Bot 按提示先问清
// 缺失的信息再动手。模板本身不编造执行结果、不编地址、不编价格、不编班次。
// 6 个模板按用户发来的 Cue 截图里的探索页来：寄包裹、找房、找显示器、
// 补满冰箱、省钱、预订票。
export interface ExploreTemplate {
  id: string;
  /** webuiMobile.ts 里 P 表的图标名。 */
  icon: string;
  title: { zh: string; en: string };
  subtitle: { zh: string; en: string };
  /** 发进群聊的开场消息（中英各一份，手机按语言选）。 */
  prompt: { zh: string; en: string };
}

const T: ExploreTemplate[] = [
  {
    id: "parcel",
    icon: "inbox",
    title: { zh: "寄包裹", en: "Send a parcel" },
    subtitle: { zh: "寄到海外，帮你比渠道", en: "Ship abroad, compare options" },
    prompt: {
      zh: "帮我寄一个包裹。先问我：寄到哪里（国家/城市/地址）、寄什么、重量和时效要求；再根据这些帮我比对渠道和费用，确认后告诉我下一步怎么操作。没有我给的信息不要编造地址和价格。",
      en: "Help me send a parcel. First ask me: where to (country/city/address), what is inside, weight and how fast it needs to arrive; then compare shipping options and costs, and tell me the next step after I confirm. Do not invent addresses or prices I have not given.",
    },
  },
  {
    id: "housing",
    icon: "search",
    title: { zh: "寻找出租房", en: "Find a rental" },
    subtitle: { zh: "按预算和地段筛选", en: "Filter by budget and area" },
    prompt: {
      zh: "帮我找租房。先问我：城市、预算、地段、户型和入住时间；再按条件帮我列出筛选思路和要核实的问题，不要编造具体房源和价格。",
      en: "Help me find a rental. First ask me: city, budget, area, layout and move-in date; then list how to filter and what to verify. Do not invent specific listings or prices.",
    },
  },
  {
    id: "monitor",
    icon: "laptop",
    title: { zh: "找显示器", en: "Find a monitor" },
    subtitle: { zh: "办公显示器选购建议", en: "Office monitor buying guide" },
    prompt: {
      zh: "帮我找一台办公显示器。先问我：尺寸、分辨率、预算和用途（办公/设计/编程）；再按条件给选购建议和对比要点，不要编造具体型号的价格和库存。",
      en: "Help me find an office monitor. First ask me: size, resolution, budget and use (office/design/coding); then give buying advice and comparison points. Do not invent prices or stock for specific models.",
    },
  },
  {
    id: "fridge",
    icon: "plus",
    title: { zh: "补满冰箱", en: "Restock the fridge" },
    subtitle: { zh: "按家里人口列采购清单", en: "Shopping list for the household" },
    prompt: {
      zh: "帮我补满冰箱。先问我：家里几口人、忌口和预算；再按这个列一份采购清单，标出哪些是常备、哪些看价格再定，不要编造超市价格。",
      en: "Help me restock the fridge. First ask me: household size, dietary restrictions and budget; then make a shopping list, marking staples versus price-dependent items. Do not invent supermarket prices.",
    },
  },
  {
    id: "save",
    icon: "tag",
    title: { zh: "一起省钱", en: "Save money together" },
    subtitle: { zh: "列个本月省钱计划", en: "A saving plan for this month" },
    prompt: {
      zh: "和我一起省钱。先问我这个月想省在哪几项上；再帮我看看每项能怎么省，列个本月省钱计划，每项都要能落地、不要编数字。",
      en: "Help me save money. First ask me which spending I want to cut this month; then suggest how to save on each and make a plan for this month. Every item must be actionable — do not invent numbers.",
    },
  },
  {
    id: "ticket",
    icon: "ticket",
    title: { zh: "预订票", en: "Book tickets" },
    subtitle: { zh: "机票、火车票、演出票", en: "Flights, trains, shows" },
    prompt: {
      zh: "帮我预订票。先问我：去哪、哪天、几个人、预算；再按这个给订票思路和要核实的时间价格，不要编造班次和票价。",
      en: "Help me book tickets. First ask me: where to, which day, how many people, budget; then give booking guidance and what time/price to verify. Do not invent schedules or fares.",
    },
  },
];

/** 探索页模板（返回副本，调用方改了不影响内置表）。 */
export function listExploreTemplates(): ExploreTemplate[] {
  return T.map((t) => ({
    id: t.id,
    icon: t.icon,
    title: { ...t.title },
    subtitle: { ...t.subtitle },
    prompt: { ...t.prompt },
  }));
}

/** 按 id 取一个模板，没有返回 null（网关 404 用）。 */
export function getExploreTemplate(id: string): ExploreTemplate | null {
  return listExploreTemplates().find((t) => t.id === id) ?? null;
}
