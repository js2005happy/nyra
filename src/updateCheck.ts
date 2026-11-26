// src/updateCheck.ts — 更新检查（默认关闭的 opt-in）。
//
// 隐私政策承诺不联网回报：只有 config.json 里 update_check_enabled 显式为
// true 时才联网（查 GitHub Releases latest）；关闭时 checkForUpdates 绝不发
// 请求——连 fetch 注入点都不会被调用（测试锁定）。
// 开关本身只在三处改：config.json 手改、`nyra config import`、网页设置页
// （/api/settings 白名单）。`nyra update-check` 是手动触发一次检查的入口，
// 开关没开时它只提示、同样不联网。
export const UPDATE_CHECK_CONFIG_KEY = "update_check_enabled";
export const UPDATE_CHECK_RELEASES_URL =
  "https://api.github.com/repos/js2005happy/nyra/releases/latest";
export const UPDATE_CHECK_RELEASES_PAGE =
  "https://github.com/js2005happy/nyra/releases/latest";

export function isUpdateCheckEnabled(
  config: Record<string, unknown> | null | undefined,
): boolean {
  return config?.[UPDATE_CHECK_CONFIG_KEY] === true;
}

/** 把 "v0.5.12" / "0.5.12-dev" 规整成数字段；解析不出返回 null。 */
export function parseVersion(v: string): number[] | null {
  const m = /^\s*v?(\d+(?:\.\d+)*)/.exec(v ?? "");
  if (!m) return null;
  return m[1].split(".").map((x) => Number(x));
}

/** 比较两个版本：a 更新返回 >0，一样返回 0，a 更旧返回 <0；解析不出返回 null。 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export interface UpdateCheckResult {
  /** 是否真的联网查了（开关关着时为 false，且 fetch 一次都没调）。 */
  checked: boolean;
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  url: string | null;
  /** checked 为 false 时的原因（目前只有 "disabled"）；查不到时是错误信息。 */
  reason?: string;
}

export interface ReleaseInfo {
  tag_name: string;
  html_url?: string;
}

async function defaultFetchRelease(url: string): Promise<ReleaseInfo> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`GitHub Releases 返回 ${res.status}`);
    const data = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    if (typeof data.tag_name !== "string" || !data.tag_name) {
      throw new Error("GitHub Releases 返回里没有 tag_name");
    }
    return {
      tag_name: data.tag_name,
      html_url: typeof data.html_url === "string" ? data.html_url : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForUpdates(opts: {
  enabled: boolean;
  currentVersion: string;
  fetchRelease?: (url: string) => Promise<ReleaseInfo>;
}): Promise<UpdateCheckResult> {
  const currentVersion = opts.currentVersion;
  if (!opts.enabled) {
    return {
      checked: false,
      updateAvailable: false,
      currentVersion,
      latestVersion: null,
      url: null,
      reason: "disabled",
    };
  }
  const fetchRelease = opts.fetchRelease ?? defaultFetchRelease;
  try {
    const rel = await fetchRelease(UPDATE_CHECK_RELEASES_URL);
    const cmp = compareVersions(rel.tag_name, currentVersion);
    return {
      checked: true,
      updateAvailable: cmp !== null && cmp > 0,
      currentVersion,
      latestVersion: rel.tag_name,
      url: rel.html_url ?? UPDATE_CHECK_RELEASES_PAGE,
    };
  } catch (err) {
    return {
      checked: true,
      updateAvailable: false,
      currentVersion,
      latestVersion: null,
      url: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
