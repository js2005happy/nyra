// src/mcpPresets.ts — 内置 MCP 服务器预置，与 Python 版 nyra/mcp_presets.py 同语义。
// 预置只是配置配方，不是正在跑的服务器；MCP 默认关闭，服务器只在用户
// 启用（mcp_enabled: true）后才启动。需要 Key/路径的预置缺条件时跳过，
// 绝不用假值启动。
export interface McpPreset {
  command: string;
  args: string[];
  env: Record<string, string>;
  requires_env: string[];
  requires_args: boolean;
  description: string;
  note: string;
  /** http 预置才填：stdio 预置留空（默认 stdio）。 */
  transport?: "stdio" | "http";
  /** http 预置的端点。 */
  url?: string;
  /**
   * http 预置的请求头模板：值里的 ${ENV_NAME} 在解析时换成同名环境变量的值。
   * 秘密值只出现在解析后的配置里，绝不写进日志与事件。
   */
  headers?: Record<string, string>;
}

export const MCP_PRESETS: Record<string, McpPreset> = {
  "memory": {
    command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: {},
    requires_env: [], requires_args: false,
    description: "知识图谱记忆：长期记住对话里的事实、偏好和关系。",
    note: "需要本机装好 Node.js（提供 npx 命令）。",
  },
  "sequential-thinking": {
    command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"], env: {},
    requires_env: [], requires_args: false,
    description: "结构化思考：把复杂问题拆成步骤逐步推导。",
    note: "需要本机装好 Node.js（提供 npx 命令）。",
  },
  "fetch": {
    command: "uvx", args: ["mcp-server-fetch"], env: {},
    requires_env: [], requires_args: false,
    description: "抓网页内容：把网页取回并转成干净的 Markdown。",
    note: "需要本机装好 uv（提供 uvx 命令）。",
  },
  "time": {
    command: "uvx", args: ["mcp-server-time"], env: {},
    requires_env: [], requires_args: false,
    description: "时间与时区：当前时间、时区换算。",
    note: "需要本机装好 uv（提供 uvx 命令）。",
  },
  "github": {
    command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: {},
    requires_env: ["GITHUB_PERSONAL_ACCESS_TOKEN"], requires_args: false,
    description: "GitHub：读仓库、issue、PR、提交记录。",
    note: "需要 GITHUB_PERSONAL_ACCESS_TOKEN。官方已归档，不再维护。",
  },
  "brave-search": {
    command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"], env: {},
    requires_env: ["BRAVE_API_KEY"], requires_args: false,
    description: "Brave 搜索：网页搜索与本地搜索。",
    note: "需要 BRAVE_API_KEY。官方已归档，不再维护。",
  },
  "filesystem": {
    command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], env: {},
    requires_env: [], requires_args: true,
    description: "文件系统：只在用户允许的目录里读写、移动、搜索文件。",
    note: "需要在 mcp_preset_args 里写要开放的目录，如 {\"filesystem\": [\"D:/docs\"]}。",
  },
  "git": {
    command: "uvx", args: ["mcp-server-git", "--repository"], env: {},
    requires_env: [], requires_args: true,
    description: "Git：读本地仓库的状态、历史、分支与 diff。",
    note: "需要在 mcp_preset_args 里写仓库目录，如 {\"git\": [\"D:/repo\"]}。",
  },
  "sqlite": {
    command: "uvx", args: ["--with", "mcp==1.30.0", "mcp-server-sqlite", "--db-path"], env: {},
    requires_env: [], requires_args: true,
    description: "SQLite：查询本地 SQLite 数据库。",
    note: "需要在 mcp_preset_args 里写数据库文件路径。官方已归档，不再维护；用 mcp 1.30.0 才能跑（新版 SDK 删了 resources 接口）。",
  },
  "puppeteer": {
    command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"], env: {},
    requires_env: [], requires_args: false,
    description: "浏览器自动化：用无头浏览器打开网页、截图、点页面元素。",
    note: "首次使用会下载 Chromium（约 100MB 以上），比较慢。官方已归档，不再维护。",
  },
  // Cue A 批 5.5：GitHub 官方远程 MCP（只读）。不是本地子进程，走
  // Streamable HTTP；授权先用 PAT（GITHUB_MCP_TOKEN），OAuth 2.1 落地后
  // 再改走 OAuth，PAT 方案届时降级为备用。只开只读端点，写操作会被
  // 服务器拒绝（验证拒绝链路是验收的一部分）。
  "github-remote": {
    command: "", args: [], env: {},
    requires_env: ["GITHUB_MCP_TOKEN"], requires_args: false,
    description: "GitHub 官方远程 MCP（只读）：读仓库、issue、PR、用户，不写。",
    note: "需要在 GitHub 上生成一个只读 PAT（fine-grained，只给读权限），放到 GITHUB_MCP_TOKEN 环境变量。默认不开（不在 DEFAULT_MCP_PRESETS 里）。",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/readonly",
    headers: { "Authorization": "Bearer ${GITHUB_MCP_TOKEN}" },
  },
};

export const DEFAULT_MCP_PRESETS = ["memory", "sequential-thinking", "fetch", "time"] as const;

export function getPreset(name: string): McpPreset | null {
  const preset = MCP_PRESETS[name];
  return preset ? { ...preset, args: [...preset.args], env: { ...preset.env }, requires_env: [...preset.requires_env], headers: preset.headers ? { ...preset.headers } : undefined } : null;
}

export function listPresets(): (McpPreset & { name: string })[] {
  return Object.keys(MCP_PRESETS).sort().map((name) => ({ name, ...getPreset(name)! }));
}

/**
 * 把一个预置名解析成原始服务器配置；不能解析时返回 [null, 原因]。
 * 与 Python resolve_preset 同语义：缺 Key / 缺路径都只跳过，不编造。
 */
export function resolvePreset(
  name: string,
  presetArgs?: Record<string, unknown> | null,
  environ?: Record<string, string | undefined>,
): [Record<string, unknown> | null, string] {
  const env = environ ?? process.env;
  const preset = MCP_PRESETS[name];
  if (!preset) return [null, `未知的 MCP 预置：${name}`];
  const missingKeys = preset.requires_env.filter((key) => !env[key]);
  if (missingKeys.length) {
    return [null, `MCP 预置 ${name} 缺少环境变量 ${missingKeys.join("、")}，已跳过`];
  }
  const args = [...preset.args];
  if (preset.requires_args) {
    const supplied = (presetArgs ?? {})[name];
    if (!Array.isArray(supplied) || !supplied.length || !supplied.every((v) => typeof v === "string")) {
      return [null, `MCP 预置 ${name} 需要在 mcp_preset_args 里提供路径，如 {"mcp_preset_args": {"${name}": ["<路径>"]}}，已跳过`];
    }
    args.push(...(supplied as string[]));
  }
  // http 预置：不启子进程，请求头模板里的 ${ENV_NAME} 换成环境变量的值
  // （requires_env 已保证它们存在）；缺 url 的 http 预置是配置错误。
  if (preset.transport === "http") {
    if (!preset.url) return [null, `MCP 预置 ${name} 是 http 传输但没有配 url，已跳过`];
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(preset.headers ?? {})) {
      headers[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, varName: string) => env[varName] ?? "");
    }
    return [{ transport: "http", url: preset.url, headers }, ""];
  }
  const raw: Record<string, unknown> = {
    command: preset.command, args, env: { ...preset.env },
  };
  if (preset.requires_env.length) raw.inherit_env = [...preset.requires_env];
  return [raw, ""];
}
