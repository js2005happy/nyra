// src/childEnv.ts — 子进程环境白名单（叶模块，只引 node 内置）。
//
// 背景：shell / 沙箱 / MCP / Codex 四处子进程此前都继承整份 process.env，
// 模型 Key、GitHub token 这类密钥会一路漏进子进程（第四份审计 P0）。
// 从此只传白名单里的变量：PATH/HOME/TERM、语言与区域设置、
// 出口代理（评测教训：剥掉代理变量 DeepSeek 直连会报 SSL 错）、
// 以及调用方显式声明的变量。密钥类一律不传。
//
// 白名单是“允许的变量名”清单，不是“禁止的变量名”清单：
// 新出现的 *_API_KEY / *_TOKEN / *_SECRET* / *_PASSWORD* 只要不在白名单里，
// 默认就不会漏出去。
export const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  // 出口代理是传输层配置，不是凭据；但代理 URL 里可能带 user:pass，
  // 传之前先剥掉凭据段（见 stripProxyCredentials）。
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  // Windows 运行时查找与临时目录。
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  // Nyra 自身的无害开关：语言、调试、以及“本进程已被沙箱包住”的标记。
  "NYRA_LANG",
  "NYRA_DEBUG",
  "NYRA_SANDBOXED",
  "NYRA_HOME",
] as const;

export const PROXY_ENV_VARS = [
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
] as const;

// 代理 URL 里可能夹带 user:pass（http://user:pass@host:port），
// 传给子进程前把凭据段剥掉，只留 host:port。
export function stripProxyCredentials(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      return url.toString();
    }
    return value;
  } catch {
    return value;
  }
}

// 只从 process.env 挑白名单里的变量，拼成子进程环境。
// extra 是调用方显式声明的变量（例如沙箱要带的 SANDBOX_ALLOW_NET 语义
// 或 MCP 配置里写明的 env），原样放行——调用方自己对它负责。
export function buildChildEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value === undefined) continue;
    env[key] = (PROXY_ENV_VARS as readonly string[]).includes(key)
      ? stripProxyCredentials(value)
      : value;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}
