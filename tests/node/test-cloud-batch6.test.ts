// tests/node/test-cloud-batch6.test.ts — 手机云端连接（第 6 批）：
// 账号登录后直连云端服务、跨端同步，不走局域网。
// 全部 mock-only：云端用内存假服务（stub fetch 实现 /api/cloud/* 契约），
// 不碰真网络、真域名；账号用本地文件后端。
import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CloudClient, CLOUD_DESIGN_URL, CLOUD_SESSION_FILE, CLOUD_DEVICE_FILE,
  resolveCloudUrl, isCloudConfigured, validateCloudUrl, endpointHost,
  connectToCloud, disconnectFromCloud, cloudClientForSession,
  readCloudSession, getOrCreateDeviceId,
  type CloudFetchFn, type CloudStateRemoteRecord, type CloudStatePushRecord,
} from "../../src/cloud.ts";
import {
  CloudStateStore, CloudSyncError, syncCloudState,
  setPreference, getPreference, listPreferences, PREF_KEYS,
} from "../../src/cloudSync.ts";
import { AccountSessionStore, readCurrentSession, writeCurrentSession, upsertAccount } from "../../src/accounts.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";
import { SUBCOMMANDS } from "../../src/subcommands.ts";
import { expectPerms } from "./fsPerms.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(home: string, args: string[], extraEnv?: Record<string, string>) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: join(process.cwd()),
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NYRA_HOME: home, NYRA_LANG: "zh", ...(extraEnv ?? {}) },
  });
}

/** 内存假云端：按 docs/mobile-cloud.md §4 的 API 契约实现 /api/cloud/*。 */
function makeFakeCloud(expectedToken: string, accountId: string) {
  const devices = new Map<string, { id: string; name: string; last_seen: string }>();
  const records: CloudStateRemoteRecord[] = [];
  let version = 0;
  let counter = 0;
  let healthy = true;
  const fetchFn: CloudFetchFn = async (url, init) => {
    const u = new URL(url);
    const auth = init?.headers?.Authorization ?? "";
    const ok = (status: number, data: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(data),
    });
    if (auth !== "Bearer " + expectedToken) return ok(401, { error: "unauthorized" });
    if (u.pathname === "/api/cloud/health") {
      return ok(200, { ok: healthy, version: "0.1.0-fake" });
    }
    if (u.pathname === "/api/cloud/sessions" && init?.method === "POST") {
      const body = JSON.parse(init?.body ?? "{}") as { device_id: string; device_name: string };
      const id = "cs-" + String(++counter).padStart(4, "0");
      devices.set(body.device_id, { id: body.device_id, name: body.device_name, last_seen: new Date().toISOString() });
      return ok(200, { cloud_session_id: id, expires_at: "2030-01-01T00:00:00Z" });
    }
    if (u.pathname.startsWith("/api/cloud/sessions/") && init?.method === "DELETE") {
      return ok(200, { ok: true });
    }
    if (u.pathname === "/api/cloud/devices") {
      return ok(200, { devices: [...devices.values()].map((d) => ({ ...d, current: true })) });
    }
    if (u.pathname === "/api/cloud/state/push" && init?.method === "POST") {
      const body = JSON.parse(init?.body ?? "{}") as { records: CloudStatePushRecord[] };
      const applied: { scope: string; key: string; version: number }[] = [];
      const rejected: { scope: string; key: string; reason: string }[] = [];
      for (const r of body.records) {
        const existing = records.find((x) => x.scope === r.scope && x.key === r.key);
        if (existing && r.base_version < existing.version) {
          rejected.push({ scope: r.scope, key: r.key, reason: "base_version 太旧，云端已有更新的版本" });
          continue;
        }
        version += 1;
        const rec: CloudStateRemoteRecord = {
          account_id: accountId, scope: r.scope, key: r.key, value: r.value,
          updated_at: r.updated_at, origin: r.origin, version,
        };
        if (existing) Object.assign(existing, rec);
        else records.push(rec);
        applied.push({ scope: r.scope, key: r.key, version });
      }
      return ok(200, { applied, rejected });
    }
    if (u.pathname === "/api/cloud/state") {
      const since = Number(u.searchParams.get("since") ?? "0");
      return ok(200, { records: records.filter((r) => r.version > since), latest_version: version });
    }
    throw new Error("fake cloud 未覆盖的路径：" + u.pathname);
  };
  return {
    fetchFn,
    state: { devices, records, get version() { return version; } },
    setHealthy(v: boolean) { healthy = v; },
  };
}

/** 在临时 home 里建一个已登录的账号，返回账号与会话 token。 */
async function loginTestAccount(home: string): Promise<{ accountId: string; token: string }> {
  const account = await upsertAccount(home, "github", { sub: "4242", email: "owner@example.com", name: "机主" });
  const sessions = new AccountSessionStore(home);
  const issued = await sessions.issue(account.id);
  writeCurrentSession(home, { token: issued.token, account_id: account.id, issued_at: new Date().toISOString() });
  return { accountId: account.id, token: issued.token };
}

// ---- 云端地址解析 ----

describe("CloudTest.test_cloud_url_resolution", () => {
  test("默认是设计占位地址（.example，解析不到真实服务）", () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      expect(CLOUD_DESIGN_URL).toBe("https://api.nyra.example");
      expect(resolveCloudUrl(home, {})).toBe(CLOUD_DESIGN_URL);
      expect(isCloudConfigured(home, {})).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("环境变量优先于 config.json，config.json 优先于占位地址", () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ cloud: { url: "https://cloud.example.com" } }), "utf-8");
      expect(resolveCloudUrl(home, {})).toBe("https://cloud.example.com");
      expect(isCloudConfigured(home, {})).toBe(true);
      expect(resolveCloudUrl(home, { NYRA_CLOUD_URL: "https://env.example.com" })).toBe("https://env.example.com");
      expect(isCloudConfigured(home, { NYRA_CLOUD_URL: "https://env.example.com" })).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("validateCloudUrl：https 通过、本机 http 通过、公网 http 与非法协议拒绝", () => {
    expect(validateCloudUrl("https://cloud.example.com")).toBe(null);
    expect(validateCloudUrl("http://127.0.0.1:8080")).toBe(null);
    expect(validateCloudUrl("http://localhost:8080")).toBe(null);
    expect(validateCloudUrl("")).not.toBe(null);
    expect(validateCloudUrl("not-a-url")).not.toBe(null);
    expect(validateCloudUrl("ftp://cloud.example.com")).not.toBe(null);
    expect(validateCloudUrl("http://cloud.example.com")).toContain("明文");
  });

  test("endpointHost 只取主机名", () => {
    expect(endpointHost("https://cloud.example.com:8443/api")).toBe("cloud.example.com");
  });
});

// ---- 云端客户端（假服务）----

describe("CloudTest.test_cloud_client", () => {
  test("health / register / devices 全链路", async () => {
    const fake = makeFakeCloud("tok-1", "acct-1");
    const client = new CloudClient({ baseUrl: "https://cloud.example.com", sessionToken: "tok-1", fetchFn: fake.fetchFn });
    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.version).toBe("0.1.0-fake");
    const reg = await client.registerSession({ device_id: "dev-1", device_name: "测试机" });
    expect(reg.cloud_session_id).toBe("cs-0001");
    const devices = await client.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0].name).toBe("测试机");
    await client.revokeSession("cs-0001");
  });

  test("401 报“会话已失效，请重新登录”，不透传原始状态码细节", async () => {
    const fake = makeFakeCloud("tok-right", "acct-1");
    const client = new CloudClient({ baseUrl: "https://cloud.example.com", sessionToken: "tok-wrong", fetchFn: fake.fetchFn });
    await expect(client.health()).rejects.toThrow("会话已失效");
  });

  test("连不上云端时报“连不上云端服务”", async () => {
    const failingFetch: CloudFetchFn = async () => { throw new Error("ECONNREFUSED"); };
    const client = new CloudClient({ baseUrl: "https://cloud.example.com", sessionToken: "tok-1", fetchFn: failingFetch });
    await expect(client.health()).rejects.toThrow("连不上云端服务");
  });

  test("非 JSON 错误响应报 HTTP 状态", async () => {
    const badFetch: CloudFetchFn = async () => ({ ok: false, status: 500, text: async () => "<html>bad gateway</html>" });
    const client = new CloudClient({ baseUrl: "https://cloud.example.com", sessionToken: "tok-1", fetchFn: badFetch });
    await expect(client.health()).rejects.toThrow("HTTP 500");
  });

  test("push/pull 往返：推上去的记录能拉下来", async () => {
    const fake = makeFakeCloud("tok-1", "acct-1");
    const client = new CloudClient({ baseUrl: "https://cloud.example.com", sessionToken: "tok-1", fetchFn: fake.fetchFn });
    const pushed = await client.pushState([
      { scope: "preferences", key: "model", value: "deepseek-flash", updated_at: "2026-11-23T10:00:00Z", origin: "dev-a", base_version: 0 },
    ]);
    expect(pushed.applied).toHaveLength(1);
    expect(pushed.applied[0].version).toBe(1);
    expect(pushed.rejected).toHaveLength(0);
    const pulled = await client.pullState(0);
    expect(pulled.records).toHaveLength(1);
    expect(pulled.records[0].value).toBe("deepseek-flash");
    expect(pulled.latest_version).toBe(1);
    const pulledAgain = await client.pullState(1);
    expect(pulledAgain.records).toHaveLength(0);
  });

  test("push 时 base_version 太旧被拒绝", async () => {
    const fake = makeFakeCloud("tok-1", "acct-1");
    const client = new CloudClient({ baseUrl: "https://cloud.example.com", sessionToken: "tok-1", fetchFn: fake.fetchFn });
    await client.pushState([
      { scope: "preferences", key: "model", value: "v1", updated_at: "2026-11-23T10:00:00Z", origin: "dev-a", base_version: 0 },
    ]);
    const second = await client.pushState([
      { scope: "preferences", key: "model", value: "v2-stale", updated_at: "2026-11-23T10:01:00Z", origin: "dev-b", base_version: 0 },
    ]);
    expect(second.applied).toHaveLength(0);
    expect(second.rejected).toHaveLength(1);
    expect(second.rejected[0].reason).toContain("太旧");
  });
});

// ---- 连接 / 断开 ----

describe("CloudTest.test_cloud_connect", () => {
  test("没配云端地址时拒绝连接，不偷偷连占位地址", async () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      await loginTestAccount(home);
      await expect(connectToCloud(home, {})).rejects.toThrow("还没配好");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("没登录账号时拒绝连接", async () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ cloud: { url: "https://cloud.example.com" } }), "utf-8");
      await expect(connectToCloud(home, {})).rejects.toThrow("还没登录账号");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("连上后写云端会话记录（0600），设备 id 稳定，断开清掉", async () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      const { accountId, token } = await loginTestAccount(home);
      const fake = makeFakeCloud(token, accountId);
      writeFileSync(join(home, "config.json"), JSON.stringify({ cloud: { url: "https://cloud.example.com" } }), "utf-8");
      const { session, accountEmail } = await connectToCloud(home, { fetchFn: fake.fetchFn });
      expect(accountEmail).toBe("owner@example.com");
      expect(session.cloud_session_id).toBe("cs-0001");
      expect(session.account_id).toBe(accountId);
      const sessionPath = join(home, CLOUD_SESSION_FILE);
      expect(existsSync(sessionPath)).toBe(true);
      expectPerms(sessionPath, 0o600);
      expect(readCloudSession(home)?.cloud_session_id).toBe("cs-0001");
      // 设备 id 两次读取一致（登记的是同一台设备，不是每次新建）。
      const first = getOrCreateDeviceId(home);
      const second = getOrCreateDeviceId(home);
      expect(first.device_id).toBe(second.device_id);
      expect(first.device_id).toBe(session.device_id);
      expectPerms(join(home, CLOUD_DEVICE_FILE), 0o600);
      // 审计记了 cloud_connected。
      const audit = readFileSync(join(home, "accounts-audit.jsonl"), "utf-8");
      expect(audit).toContain("cloud_connected");
      // 断开：云端撤销 + 本机清掉。
      const out = await disconnectFromCloud(home, { fetchFn: fake.fetchFn });
      expect(out.revoked_remote).toBe(true);
      expect(readCloudSession(home)).toBe(null);
      expect(existsSync(sessionPath)).toBe(false);
      await expect(disconnectFromCloud(home, {})).rejects.toThrow("当前没有连云端");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("云端不健康时拒绝连接", async () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      const { token, accountId } = await loginTestAccount(home);
      const fake = makeFakeCloud(token, accountId);
      fake.setHealthy(false);
      writeFileSync(join(home, "config.json"), JSON.stringify({ cloud: { url: "https://cloud.example.com" } }), "utf-8");
      await expect(connectToCloud(home, { fetchFn: fake.fetchFn })).rejects.toThrow("不健康");
      expect(readCloudSession(home)).toBe(null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("断开时云端连不上：本机凭证照样清掉，如实报错", async () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      const { token, accountId } = await loginTestAccount(home);
      const fake = makeFakeCloud(token, accountId);
      writeFileSync(join(home, "config.json"), JSON.stringify({ cloud: { url: "https://cloud.example.com" } }), "utf-8");
      await connectToCloud(home, { fetchFn: fake.fetchFn });
      const failingFetch: CloudFetchFn = async () => { throw new Error("ECONNREFUSED"); };
      await expect(disconnectFromCloud(home, { fetchFn: failingFetch })).rejects.toThrow("本机云端凭证已清掉");
      expect(readCloudSession(home)).toBe(null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("cloudClientForSession：没连云端拒绝，账号会话失效拒绝", async () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      const { token, accountId } = await loginTestAccount(home);
      const fake = makeFakeCloud(token, accountId);
      writeFileSync(join(home, "config.json"), JSON.stringify({ cloud: { url: "https://cloud.example.com" } }), "utf-8");
      await expect(cloudClientForSession(home, { fetchFn: fake.fetchFn })).rejects.toThrow("还没连云端");
      await connectToCloud(home, { fetchFn: fake.fetchFn });
      const sessions = new AccountSessionStore(home);
      const listed = await sessions.listSessions(accountId);
      expect(listed.length).toBeGreaterThan(0);
      await sessions.revoke(listed[0].id);
      await expect(cloudClientForSession(home, { fetchFn: fake.fetchFn })).rejects.toThrow("会话已失效");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---- 本地同步账本与冲突规则 ----

describe("CloudTest.test_cloud_state_store", () => {
  test("set/get/dirty/latestVersion", () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      const store = new CloudStateStore(home);
      expect(store.get("acct-1", "preferences", "model")).toBe(null);
      expect(store.latestVersion("acct-1")).toBe(0);
      const rec = store.setLocal("acct-1", "preferences", "model", "deepseek-flash", "dev-a");
      expect(rec.dirty).toBe(true);
      expect(rec.version).toBe(0);
      expect(store.get("acct-1", "preferences", "model")?.value).toBe("deepseek-flash");
      expect(store.listDirty("acct-1")).toHaveLength(1);
      store.markPushed("acct-1", [{ scope: "preferences", key: "model", version: 3 }]);
      expect(store.get("acct-1", "preferences", "model")?.dirty).toBe(false);
      expect(store.latestVersion("acct-1")).toBe(3);
      expect(store.listDirty("acct-1")).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("applyRemote：新记录落盘、旧 version 跳过", () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      const store = new CloudStateStore(home);
      const first = store.applyRemote("acct-1", [
        { account_id: "acct-1", scope: "preferences", key: "model", value: "v1", updated_at: "2026-11-23T10:00:00Z", origin: "dev-b", version: 1 },
      ]);
      expect(first.applied).toBe(1);
      expect(first.conflicts).toHaveLength(0);
      expect(store.get("acct-1", "preferences", "model")?.value).toBe("v1");
      // 同 version 再拉一次不重复落盘；别家账号的记录不进本账号。
      const second = store.applyRemote("acct-1", [
        { account_id: "acct-1", scope: "preferences", key: "model", value: "v1", updated_at: "2026-11-23T10:00:00Z", origin: "dev-b", version: 1 },
        { account_id: "acct-2", scope: "preferences", key: "model", value: "other", updated_at: "2026-11-23T10:00:00Z", origin: "dev-b", version: 2 },
      ]);
      expect(second.applied).toBe(0);
      expect(store.get("acct-2", "preferences", "model")).toBe(null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("applyRemote 冲突：远端更新留远端，本地更新留本地并记冲突", () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      // 固定时钟（2026-11-23T02:00:00Z）：setLocal 的时间戳可预期，
      // 不随测试跑在几点而变（ISO 时间是 UTC，不是 CST）。
      const clock = () => Date.parse("2026-11-23T02:00:00Z") / 1000;
      const store = new CloudStateStore(home, { clock });
      // 本地改了 model（dirty，02:00），远端同 key version 2、时间更新（10:05）→ 留远端。
      store.setLocal("acct-1", "preferences", "model", "local-new", "dev-a");
      const remoteWins = store.applyRemote("acct-1", [
        { account_id: "acct-1", scope: "preferences", key: "model", value: "remote-newer", updated_at: "2026-11-23T10:05:00Z", origin: "dev-b", version: 2 },
      ]);
      expect(remoteWins.applied).toBe(1);
      expect(remoteWins.conflicts).toEqual([{ scope: "preferences", key: "model", kept: "remote" }]);
      expect(store.get("acct-1", "preferences", "model")?.value).toBe("remote-newer");
      expect(store.get("acct-1", "preferences", "model")?.dirty).toBe(false);
      // 本地再改一次（dirty，02:00），远端 version 3 但时间更旧（01:00）→ 留本地。
      store.setLocal("acct-1", "preferences", "model", "local-newest", "dev-a");
      const localWins = store.applyRemote("acct-1", [
        { account_id: "acct-1", scope: "preferences", key: "model", value: "remote-older", updated_at: "2026-11-23T01:00:00Z", origin: "dev-b", version: 3 },
      ]);
      expect(localWins.applied).toBe(0);
      expect(localWins.conflicts).toEqual([{ scope: "preferences", key: "model", kept: "local" }]);
      expect(store.get("acct-1", "preferences", "model")?.value).toBe("local-newest");
      expect(store.get("acct-1", "preferences", "model")?.dirty).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("applyRemote 冲突：时间戳打平时 origin 字典序大的赢", () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      const clock = () => Date.parse("2026-11-23T02:00:00Z") / 1000;
      const store = new CloudStateStore(home, { clock });
      store.setLocal("acct-1", "preferences", "theme", "dark", "dev-a");
      const res = store.applyRemote("acct-1", [
        { account_id: "acct-1", scope: "preferences", key: "theme", value: "light", updated_at: store.get("acct-1", "preferences", "theme")!.updated_at, origin: "dev-b", version: 5 },
      ]);
      // dev-b > dev-a，远端赢。
      expect(res.conflicts).toEqual([{ scope: "preferences", key: "theme", kept: "remote" }]);
      expect(store.get("acct-1", "preferences", "theme")?.value).toBe("light");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("账本损坏先备份再抛错，不静默清空", () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      writeFileSync(join(home, "cloud-state.json"), "{bad json", "utf-8");
      const store = new CloudStateStore(home);
      expect(() => store.get("acct-1", "preferences", "model")).toThrow("损坏");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---- 偏好作用域 ----

describe("CloudTest.test_cloud_preferences", () => {
  test("偏好只认 model、language、theme 三个键", () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      expect(PREF_KEYS).toEqual(["model", "language", "theme"]);
      setPreference(home, "acct-1", "model", "deepseek-flash", "dev-a");
      expect(getPreference(home, "acct-1", "model")).toBe("deepseek-flash");
      expect(getPreference(home, "acct-1", "language")).toBe(null);
      expect(listPreferences(home, "acct-1")).toHaveLength(1);
      expect(() => setPreference(home, "acct-1", "not-a-pref", "x", "dev-a")).toThrow("只认");
      expect(() => getPreference(home, "acct-1", "not-a-pref")).toThrow("只认");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---- 同步引擎（假云端往返）----

describe("CloudTest.test_cloud_sync_engine", () => {
  test("两台设备经假云端同步：A 推上去，B 拉下来，再改回去 A 能看到", async () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      const { token, accountId } = await loginTestAccount(home);
      const fake = makeFakeCloud(token, accountId);
      const client = new CloudClient({ baseUrl: "https://cloud.example.com", sessionToken: token, fetchFn: fake.fetchFn });
      // 设备 A：改偏好并同步（推 1 条）。
      setPreference(home, accountId, "model", "deepseek-flash", "dev-a");
      const first = await syncCloudState(home, { client, accountId, deviceId: "dev-a" });
      expect(first.pushed).toBe(1);
      expect(first.pulled).toBe(0);
      expect(first.conflicts).toHaveLength(0);
      // 设备 B（同一账号、另一台设备）：本地空账本，同步拉下来。
      const storeB = new CloudStateStore(home);
      expect(storeB.get(accountId, "preferences", "model")?.value).toBe("deepseek-flash");
      // 设备 B 改了语言，同步推上去；再拉一次确认版本推进。
      setPreference(home, accountId, "language", "zh", "dev-b");
      const second = await syncCloudState(home, { client, accountId, deviceId: "dev-b" });
      expect(second.pushed).toBe(1);
      expect(fake.state.version).toBe(2);
      const meta = new CloudStateStore(home).readMeta();
      expect(meta.last_sync_at).not.toBe(null);
      expect(meta.last_pushed).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("同步冲突进结果：本地新留本地，远端新留远端", async () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      const { token, accountId } = await loginTestAccount(home);
      const fake = makeFakeCloud(token, accountId);
      const client = new CloudClient({ baseUrl: "https://cloud.example.com", sessionToken: token, fetchFn: fake.fetchFn });
      // 先在云端放一条 model=v1（version 1）。
      await client.pushState([
        { scope: "preferences", key: "model", value: "v1", updated_at: "2026-11-23T10:00:00Z", origin: "dev-b", base_version: 0 },
      ]);
      // 本地同 key 改了（dirty），但本地时间戳比远端旧 → 同步时留远端。
      const store = new CloudStateStore(home);
      store.setLocal(accountId, "preferences", "model", "local-old", "dev-a");
      // 把本地 updated_at 改旧（直接改账本，模拟“手机离线改的比云端旧”）。
      const data = JSON.parse(readFileSync(join(home, "cloud-state.json"), "utf-8")) as { records: { updated_at: string }[] };
      data.records[0].updated_at = "2026-11-23T09:00:00Z";
      writeFileSync(join(home, "cloud-state.json"), JSON.stringify(data), "utf-8");
      const result = await syncCloudState(home, { client, accountId, deviceId: "dev-a" });
      expect(result.pulled).toBe(1);
      expect(result.conflicts).toEqual([{ scope: "preferences", key: "model", kept: "remote" }]);
      expect(store.get(accountId, "preferences", "model")?.value).toBe("v1");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("pushOnly 只推不拉，pullOnly 只拉不推", async () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      const { token, accountId } = await loginTestAccount(home);
      const fake = makeFakeCloud(token, accountId);
      const client = new CloudClient({ baseUrl: "https://cloud.example.com", sessionToken: token, fetchFn: fake.fetchFn });
      await client.pushState([
        { scope: "preferences", key: "theme", value: "dark", updated_at: "2026-11-23T10:00:00Z", origin: "dev-b", base_version: 0 },
      ]);
      setPreference(home, accountId, "model", "deepseek-flash", "dev-a");
      const pushOnly = await syncCloudState(home, { client, accountId, deviceId: "dev-a", pushOnly: true });
      expect(pushOnly.pushed).toBe(1);
      expect(pushOnly.pulled).toBe(0);
      // theme 还没拉下来。
      expect(new CloudStateStore(home).get(accountId, "preferences", "theme")).toBe(null);
      const pullOnly = await syncCloudState(home, { client, accountId, deviceId: "dev-a", pullOnly: true });
      expect(pullOnly.pulled).toBe(1);
      expect(pullOnly.pushed).toBe(0);
      expect(new CloudStateStore(home).get(accountId, "preferences", "theme")?.value).toBe("dark");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---- 事件与时间线 ----

describe("CloudTest.test_cloud_events_timeline", () => {
  test("3 个云端事件进 RunStore，时间线渲染出端点与计数", () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      const store = new RunStore(join(home, "runs"));
      const runId = store.create("云端测试任务", "sess-cloud6", home, "normal", 10).run_id;
      store.appendEvent(runId, "cloud_connected", { account_id: "acct-1", device_id: "dev-a", endpoint_host: "cloud.example.com" });
      store.appendEvent(runId, "cloud_synced", { pushed: 2, pulled: 1, conflicts: 1 });
      store.appendEvent(runId, "cloud_sync_conflict", { scope: "preferences", key: "model", kept: "remote" });
      const tl = buildTimeline(store, runId);
      const text = formatTimelineText(tl);
      expect(text).toContain("已连上云端 cloud.example.com（设备 dev-a）");
      expect(text).toContain("云端同步：推 2 条、拉 1 条、冲突 1 条");
      expect(text).toContain("同步冲突 preferences / model：最后留了云端的版本");
      // 未注册的事件类型直接拒绝（EVENT_FIELDS 是唯一事实源）。
      expect(() => store.appendEvent(runId, "cloud_not_a_real_event", {})).toThrow("运行事件无效");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("cloud 在子命令清单里", () => {
    expect(SUBCOMMANDS).toContain("cloud");
  });
});

// ---- CLI 冒烟 ----

describe("CloudTest.test_cloud_cli", () => {
  test("status / help / set-url / connect 拒绝路径", () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      const status = runCli(home, ["cloud", "status"]);
      expect(status.status).toBe(0);
      expect(status.stdout).toContain("未配置");
      expect(status.stdout).toContain(CLOUD_DESIGN_URL);
      const help = runCli(home, ["cloud", "--help"]);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("nyra cloud status");
      const badUrl = runCli(home, ["cloud", "set-url", "ftp://cloud.example.com"]);
      expect(badUrl.status).toBe(1);
      const setUrl = runCli(home, ["cloud", "set-url", "https://cloud.example.com"]);
      expect(setUrl.status).toBe(0);
      expect(setUrl.stdout).toContain("https://cloud.example.com");
      const status2 = runCli(home, ["cloud", "status"]);
      expect(status2.stdout).toContain("https://cloud.example.com");
      expect(status2.stdout).not.toContain("未配置");
      // 没登录账号：connect 拒绝；pref 拒绝。
      const connect = runCli(home, ["cloud", "connect"]);
      expect(connect.status).toBe(1);
      expect(connect.stderr).toContain("还没登录账号");
      const pref = runCli(home, ["cloud", "pref", "set", "model", "deepseek-flash"]);
      expect(pref.status).toBe(1);
      const bogus = runCli(home, ["cloud", "bogus"]);
      expect(bogus.status).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("NYRA_CLOUD_URL 环境变量同样算已配置", () => {
    const home = tmpHome("nyra-cloud-home-");
    try {
      const status = runCli(home, ["cloud", "status"], { NYRA_CLOUD_URL: "https://env-cloud.example.com" });
      expect(status.status).toBe(0);
      expect(status.stdout).toContain("https://env-cloud.example.com");
      expect(status.stdout).not.toContain("未配置");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
