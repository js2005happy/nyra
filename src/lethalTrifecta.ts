/**
 * 致命三元组（十年清单第 5 项，Simon Willison 2025-06，OWASP ASI01）。
 *
 * 一个 agent 同时具备下面三项，就能被一段不可信内容骗着把隐私数据发出去：
 *   ① 接触隐私数据——读邮箱、数据库、内部文档、密钥；
 *   ② 暴露在不可信内容里——网页、邮件、用户上传的文档、第三方工具输出；
 *   ③ 能对外通信——发 HTTP 请求、发邮件、写共享位置。
 * 砍掉任意一项，窃取路径就断了。Nyra 三项都有，所以不靠“模型自己小心”，
 * 靠确定性控制：每轮任务记清三条腿各走了哪一步，三项齐全的任务里所有写
 * 操作强制走人工审批，没人可问就默认只读；`nyra doctor` 里也查这一项。
 *
 * 注意：这里只做“记账 + 强制审批”，不做模型提示词层面的提醒——系统提示
 * 不是安全控制（见 docs/lethal-trifecta.md）。
 */

import { parseUntrustedTag } from "./untrusted.ts";

/** 三条腿。 */
export type TrifectaLeg = "private_data" | "untrusted_content" | "external_comms";

/** 腿的中文名（给 doctor / 审批摘要用）。 */
export const TRIFECTA_LEG_NAMES: Record<TrifectaLeg, string> = {
  private_data: "接触隐私数据",
  untrusted_content: "暴露在不可信内容里",
  external_comms: "能对外通信",
};

/**
 * 腿 1：接触隐私数据——读的是用户自己的东西（文件、记忆、邮件、聊天记录、
 * 店铺数据、代码、图片）。只读工具也在内：读本身就是接触。
 */
export const PRIVATE_DATA_TOOLS: ReadonlySet<string> = new Set([
  "read_file", "list_dir", "grep_search", "git_status",
  "memory_search", "session_search", "knowledge_search",
  "gmail_search", "gmail_read",
  "slack_channels", "slack_history",
  "shopify_products", "shopify_orders", "shopify_inventory",
  "editor_context", "describe_image", "media_ingest", "read_skill",
  "lsp_diagnostics", "lsp_symbols",
  // 截图读的是屏幕内容（可能含邮件、密码、聊天记录），窗口列表读的是桌面
  // 状态（窗口标题可能就是一封邮件的主题），都算接触隐私数据。
  "browser_screenshot", "computer_screenshot", "computer_windows",
]);

/**
 * 腿 2：暴露在不可信内容里——返回的东西来自用户控制之外（网页、邮件、
 * 第三方输出、别的 agent 的回复、图片里的文字）。这类工具的返回在进上下
 * 文前要带结构化不可信标记（见 untrusted.ts 的 markUntrusted）。
 */
export const UNTRUSTED_CONTENT_TOOLS: ReadonlySet<string> = new Set([
  "web_fetch", "web_search",
  "github_repo_read", "github_search",
  "feed_read",
  "browser_navigate", "browser_click", "computer_windows",
  "gmail_search", "gmail_read",
  "slack_channels", "slack_history",
  "describe_image", "media_ingest",
  "delegate", "delegate_parallel",
  "multi_model_research",
]);

/**
 * 腿 3：能对外通信——把东西发出去（发 HTTP 请求、发邮件、写共享位置、
 * 调第三方模型）。本地写文件不算：写盘本身不发出去（但三项齐全后，本地
 * 写也一样要审批——写出去的文件可能就是要发的东西）。
 */
export const EXTERNAL_COMMS_TOOLS: ReadonlySet<string> = new Set([
  "shell", "http_post",
  "gmail_send", "slack_send",
  "web_fetch", "web_search",
  "github_repo_read", "github_search",
  "feed_read",
  "browser_navigate", "browser_click",
  "group_session_create", "group_session_send", "group_session_assign",
  "multi_model_research", "media_ingest",
]);

/**
 * 动态 MCP 工具（运行时名形如 `mcp__<server>__<tool>`）与裸 `mcp` 名：调的
 * 是第三方服务器——回来的东西不可信（腿 2），调用本身就是对外通信（腿 3）。
 */
export function isMcpToolName(name: string): boolean {
  return name === "mcp" || name.startsWith("mcp__");
}

/** 一个工具占三条腿里的哪几条（动态名按规则算）。 */
export function legsForTool(name: string): TrifectaLeg[] {
  const legs: TrifectaLeg[] = [];
  if (PRIVATE_DATA_TOOLS.has(name)) legs.push("private_data");
  if (UNTRUSTED_CONTENT_TOOLS.has(name)) legs.push("untrusted_content");
  if (EXTERNAL_COMMS_TOOLS.has(name)) legs.push("external_comms");
  if (isMcpToolName(name)) {
    if (!legs.includes("untrusted_content")) legs.push("untrusted_content");
    if (!legs.includes("external_comms")) legs.push("external_comms");
  }
  return legs;
}

/** 工具名是不是真的往外发东西（腿 3）。checkApproval 记第三条腿只认这个。 */
export function isExternalCommsTool(name: string): boolean {
  return EXTERNAL_COMMS_TOOLS.has(name) || isMcpToolName(name);
}

/** 守卫开关：`NYRA_TRIFECTA_GUARD=0` 关掉强制审批（逃生口；doctor 会报失败）。 */
export function trifectaGuardEnabled(): boolean {
  return process.env.NYRA_TRIFECTA_GUARD !== "0";
}

export interface TrifectaAssessment {
  /** 每条腿有哪些工具。 */
  legs: Record<TrifectaLeg, string[]>;
  /** 实际占了哪几条腿。 */
  present: TrifectaLeg[];
  /** 三条腿是否齐全。 */
  complete: boolean;
  /** 判定：safe（0–1 条腿）/ caution（2 条腿）/ full（三条腿齐全）。 */
  verdict: "safe" | "caution" | "full";
}

/** 静态画像：一组工具名占了三条腿里的哪几条（doctor 与测试用）。 */
export function assessTrifecta(toolNames: Iterable<string>): TrifectaAssessment {
  const legs: Record<TrifectaLeg, string[]> = {
    private_data: [],
    untrusted_content: [],
    external_comms: [],
  };
  for (const name of toolNames) {
    for (const leg of legsForTool(name)) legs[leg].push(name);
  }
  const present = (Object.keys(legs) as TrifectaLeg[]).filter((leg) => legs[leg].length > 0);
  const complete = present.length === 3;
  return {
    legs,
    present,
    complete,
    verdict: complete ? "full" : present.length === 2 ? "caution" : "safe",
  };
}

/**
 * 本轮三条腿的行使记录。Agent 在构造时建一个、挂进 ToolContext，每轮任务
 * 开始前 reset。记账失败绝不破坏主循环（emit 包在 try 里）；没挂 tracker
 * 的调用方（网关直调工具、老测试）守卫不生效，行为与以前一致。
 */
export class TrifectaTracker {
  private legs = new Set<TrifectaLeg>();
  private completedEmitted = false;
  /** 哪次记账补齐了第三条腿（事件里只记工具名，不记内容）。 */
  private completedBy: string | null = null;

  constructor(private emit?: ((kind: string, data: Record<string, unknown>) => void) | null) {}

  /** 腿 1：某个工具接触了隐私数据。 */
  notePrivateDataAccess(tool: string): void {
    this.note("private_data", tool);
  }

  /** 腿 2：不可信内容进了上下文（source 是来源名，不记内容）。 */
  noteUntrustedContent(source: string): void {
    this.note("untrusted_content", source);
  }

  /** 腿 3：一次对外通信尝试（checkApproval 里记）。 */
  noteExternalAttempt(tool: string): void {
    this.note("external_comms", tool);
  }

  /**
   * 工具执行成功后记账：工具本身占腿 1 就记腿 1；结果里带结构化不可信
   * 标记就记腿 2（来源取标签里的 source）。在 executeTool 里、返回结果
   * 前调；失败的结果不记——没拿到的东西不算接触。
   */
  noteToolExecuted(tool: string, result: string): void {
    if (legsForTool(tool).includes("private_data")) this.notePrivateDataAccess(tool);
    const tag = parseUntrustedTag(result);
    if (tag) this.noteUntrustedContent(tag.source);
  }

  /** 三条腿是否齐全。 */
  isComplete(): boolean {
    return this.legs.size === 3;
  }

  /** 已占的腿（按 private_data → untrusted_content → external_comms 的顺序）。 */
  presentLegs(): TrifectaLeg[] {
    return (["private_data", "untrusted_content", "external_comms"] as const).filter((leg) => this.legs.has(leg));
  }

  /** 一句话说明（给 doctor / 日志用，不含任何内容）。 */
  describe(): string {
    const present = this.presentLegs().map((leg) => TRIFECTA_LEG_NAMES[leg]);
    if (present.length === 0) return "三元组：三条腿都没走";
    return `三元组：已占 ${present.join("、")}${this.isComplete() ? "（三项齐全，本轮写操作强制审批）" : ""}`;
  }

  /** 新一轮任务开始前清零。 */
  reset(): void {
    this.legs.clear();
    this.completedEmitted = false;
    this.completedBy = null;
  }

  private note(leg: TrifectaLeg, tool: string): void {
    const wasComplete = this.isComplete();
    this.legs.add(leg);
    if (!wasComplete && this.isComplete() && !this.completedEmitted) {
      this.completedEmitted = true;
      this.completedBy = tool;
      try {
        this.emit?.("trifecta_completed", {
          legs: this.presentLegs().join(","),
          tool,
        });
      } catch { /* 记账失败绝不破坏主循环 */ }
    }
  }
}
