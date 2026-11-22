// src/oauth.ts — 通用的 OAuth2 授权码流程助手（缺口 41：用户账号登录）。
//
// 为什么单独成模块：Gmail 连接器（src/connectors/gmail.ts）已经有一套
// 回环回调 + token 换取，但那是 Gmail 专用的（错误文案里写着 Gmail、
// 超时文案写着 nyra gmail auth）。账号登录要接 Google 与 GitHub 两家，
// 共用的部分（PKCE、回环服务器、form POST）抽出来，调用方只给固定端点。
// gmail.ts 本批不动（下一批再考虑合并不合，不动能跑的代码）。
//
// 安全口径（与 Gmail 连接器同款）：
//   - 端点必须是调用方代码里的固定常量，postForm 只接受 https:// 开头的
//     URL，不接受调用方传入任意 URL（http 明文直接拒绝）。
//   - 回环服务器只听 127.0.0.1，state 对不上直接拒绝（防 CSRF）。
//   - token 端点返回缺字段即报错，不猜、不补默认值。
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

export type FetchFn = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** 授权流程用的随机 state（防 CSRF）。 */
export function newAuthState(): string {
  return randomBytes(16).toString("hex");
}

/** PKCE code_verifier：43–128 字 base64url（RFC 7636）。 */
export function newCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** PKCE S256 code_challenge = base64url(SHA-256(verifier))。 */
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf-8").digest("base64url");
}

/** 拼授权 URL：authUrl 与参数名都由调用方定，这里只负责编码与拼接。 */
export function buildAuthUrl(authUrl: string, params: Record<string, string>): string {
  if (!authUrl.startsWith("https://")) throw new OAuthError("授权端点必须是 https:// 开头");
  const url = new URL(authUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** 单次 form POST 超时（毫秒）；token 换取、设备流轮询都走同一口径。 */
export const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

/**
 * application/x-www-form-urlencoded POST，返回解析后的 JSON。
 * 只接受 https:// URL；非 JSON 响应、HTTP 错误一律按错误处理（不猜内容）。
 */
export async function postForm(
  url: string,
  params: Record<string, string>,
  fetchFn: FetchFn,
  timeoutMs: number = OAUTH_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  if (!url.startsWith("https://")) throw new OAuthError("token 端点必须是 https:// 开头");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* 非 JSON 响应按错误处理 */
    }
    if (!res.ok) {
      const detail =
        data && typeof data === "object" && typeof (data as Record<string, unknown>).error_description === "string"
          ? String((data as Record<string, unknown>).error_description)
          : data && typeof data === "object" && typeof (data as Record<string, unknown>).error === "string"
            ? String((data as Record<string, unknown>).error)
            : "HTTP " + String(res.status);
      throw new OAuthError("OAuth 请求失败：" + detail);
    }
    return data;
  } catch (err: unknown) {
    if (err instanceof OAuthError) throw err;
    throw new OAuthError("OAuth 请求失败：" + (err instanceof Error ? err.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
}

/** 回环回调服务器默认超时（5 分钟）。 */
export const LOOPBACK_TIMEOUT_MS = 5 * 60_000;

/**
 * 回环回调服务器：在 127.0.0.1 上起一个临时 HTTP 服务等授权方把授权码
 * 送回来；state 对不上直接拒绝（防 CSRF）。只在交互式授权时用，测试里
 * 同样可以起一个真服务再用 fetch 回调它。
 * 注意：函数返回时服务器已经 listen 好了，redirectUri 可以直接用。
 */
export async function startLoopbackCallbackServer(opts: {
  state: string;
  timeoutMs?: number;
  /** 授权成功后浏览器里显示的一句话（默认中文通用文案）。 */
  successText?: string;
  /** 授权被拒绝时浏览器里显示的一句话。 */
  deniedText?: string;
}): Promise<{
  redirectUri: string;
  waitForCode(): Promise<string>;
  close(): void;
}> {
  let server: ReturnType<typeof createServer> | null = null;
  let settled = false;
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (err: Error) => void = () => {};
  const promise = new Promise<string>((resolvePromise, rejectPromise) => {
    resolveCode = resolvePromise;
    rejectCode = rejectPromise;
  });
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      try {
        server?.close();
      } catch {
        /* ignore */
      }
      rejectCode(new OAuthError("等待授权回调超时（5 分钟）：请重新运行登录命令，在浏览器里完成授权"));
    }
  }, opts.timeoutMs ?? LOOPBACK_TIMEOUT_MS);
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      if (settled) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<p>" + (opts.successText ?? "授权已完成，可以关掉这个页面了。") + "</p>");
        return;
      }
      const errParam = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (errParam) {
        settled = true;
        clearTimeout(timer);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<p>" + (opts.deniedText ?? "授权被拒绝或失败，可以关掉这个页面了。") + "</p>");
        rejectCode(new OAuthError("授权失败：" + errParam));
        return;
      }
      if (state !== opts.state || !code) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("state 不匹配或缺少授权码");
        return;
      }
      settled = true;
      clearTimeout(timer);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<p>" + (opts.successText ?? "授权成功，可以关掉这个页面、回到终端了。") + "</p>");
      resolveCode(code);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Server error");
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server!.once("error", rejectListen);
    server!.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    clearTimeout(timer);
    try {
      server.close();
    } catch {
      /* ignore */
    }
    throw new OAuthError("回环回调服务器启动失败");
  }
  return {
    redirectUri: "http://127.0.0.1:" + String(addr.port) + "/callback",
    waitForCode: () => promise,
    close: () => {
      clearTimeout(timer);
      try {
        server?.close();
      } catch {
        /* ignore */
      }
    },
  };
}
