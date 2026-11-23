// src/cloudCli.ts — `nyra cloud` 命令（第 6 批）。
// 手机云端连接的 CLI 入口：看状态、连/断云端、同步、偏好、设备、配地址。
// 所有子命令都不碰模型、不花 token；连云端与同步失败时直接报错，不谎报成功。
import { loadConfig, saveConfig } from "./config.ts";
import {
  CloudError, connectToCloud, disconnectFromCloud, cloudClientForSession,
  resolveCloudUrl, isCloudConfigured, validateCloudUrl, endpointHost,
  readCloudSession, getOrCreateDeviceId, CLOUD_DESIGN_URL,
} from "./cloud.ts";
import { CloudStateStore, syncCloudState, setPreference, getPreference, listPreferences, PREF_KEYS } from "./cloudSync.ts";

export const CLOUD_USAGE =
  "用法：nyra cloud <status|connect|disconnect|sync|push|pull|pref|devices|set-url> [选项]\n" +
  "  nyra cloud status              云端连接状态（地址、账号、云端会话、待同步条数、上次同步）\n" +
  "  nyra cloud connect [--device-name <名字>]  连云端（须先登录账号、配好云端地址）\n" +
  "  nyra cloud disconnect          断开云端（撤销云端会话 + 清掉本机云端凭证）\n" +
  "  nyra cloud sync                同步一次（先拉后推）\n" +
  "  nyra cloud push                只推本地改动上云端\n" +
  "  nyra cloud pull                只从云端拉新状态\n" +
  "  nyra cloud pref <get <键>|set <键> <值>|list>  跨端偏好（model、language、theme；改完跑 sync 推上去）\n" +
  "  nyra cloud devices             列出该账号在云端登记的设备\n" +
  "  nyra cloud set-url <云端地址>  配云端地址（写进 config.json 的 cloud.url，也可用 NYRA_CLOUD_URL 环境变量）\n" +
  "  手机先登账号（nyra account login google|github|email），再连云端；云端地址没配好时 connect 直接拒绝，不会偷偷连回局域网。详见 docs/mobile-cloud.md。";

async function currentAccountId(home: string): Promise<string | null> {
  const accounts = await import("./accounts.ts");
  const account = await accounts.getCurrentAccount(home);
  return account ? account.id : null;
}

async function requireAccount(home: string): Promise<string> {
  const id = await currentAccountId(home);
  if (!id) throw new CloudError("还没登录账号：先跑 nyra account login google|github|email 登录，再用云端功能");
  return id;
}

export async function handleCloud(argv: string[], home: string): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(CLOUD_USAGE + "\n");
    return 0;
  }
  try {
    switch (cmd) {
      case "status": {
        const endpoint = resolveCloudUrl(home);
        const configured = isCloudConfigured(home);
        process.stdout.write(`云端地址：${endpoint}${configured ? "" : "（设计占位地址，未配置真实云端，不会真的连过去）"}\n`);
        if (!configured) {
          process.stdout.write("云端状态：未配置（nyra cloud set-url <云端地址>，或设 NYRA_CLOUD_URL 环境变量）\n");
        }
        const accounts = await import("./accounts.ts");
        const account = await accounts.getCurrentAccount(home);
        process.stdout.write(account ? `账号：${account.email}（${account.role === "owner" ? "机主" : "普通用户"}）\n` : "账号：未登录（nyra account login google|github|email）\n");
        const session = readCloudSession(home);
        if (session) {
          process.stdout.write(`云端会话：已连上（设备 ${session.device_name}，会话 ${session.cloud_session_id.slice(0, 8)}…，过期 ${session.expires_at}）\n`);
        } else {
          process.stdout.write("云端会话：未连接（nyra cloud connect）\n");
        }
        if (account) {
          const store = new CloudStateStore(home);
          const dirty = store.listDirty(account.id);
          const meta = store.readMeta();
          process.stdout.write(`待同步：${dirty.length} 条本地改动未推上云端\n`);
          process.stdout.write(meta.last_sync_at
            ? `上次同步：${meta.last_sync_at}（推 ${meta.last_pushed} 条、拉 ${meta.last_pulled} 条、冲突 ${meta.last_conflicts} 条）\n`
            : "上次同步：还没同步过\n");
        }
        return 0;
      }
      case "connect": {
        let deviceName: string | undefined;
        for (let i = 1; i < argv.length; i++) {
          if (argv[i] === "--device-name" && argv[i + 1]) { deviceName = argv[i + 1]; i++; }
          else if (argv[i] === "--device-name") { process.stderr.write("用法：nyra cloud connect [--device-name <名字>]\n"); return 2; }
          else { process.stderr.write(`未知选项：${argv[i]}\n用法：nyra cloud connect [--device-name <名字>]\n`); return 2; }
        }
        const { session, accountEmail, health } = await connectToCloud(home, { deviceName });
        process.stdout.write(`已连上云端 ${endpointHost(session.endpoint)}（账号 ${accountEmail}，设备 ${session.device_name}）\n`);
        if (health.version) process.stdout.write(`云端版本：${health.version}\n`);
        process.stdout.write("手机登同一个账号就能看到同一份状态；改了偏好后跑 nyra cloud sync 同步。\n");
        return 0;
      }
      case "disconnect": {
        const { revoked_remote: revoked } = await disconnectFromCloud(home);
        process.stdout.write(revoked ? "已断开云端（云端会话已撤销，本机凭证已清）\n" : "已断开云端（本机凭证已清）\n");
        return 0;
      }
      case "sync":
      case "push":
      case "pull": {
        const { client, accountId } = await cloudClientForSession(home);
        const device = getOrCreateDeviceId(home);
        const result = await syncCloudState(home, {
          client,
          accountId,
          deviceId: device.device_id,
          pushOnly: cmd === "push",
          pullOnly: cmd === "pull",
        });
        process.stdout.write(`同步完成：推 ${result.pushed} 条、拉 ${result.pulled} 条、冲突 ${result.conflicts.length} 条\n`);
        for (const c of result.conflicts) {
          process.stdout.write(`  冲突 ${c.scope}/${c.key}：最后留了${c.kept === "local" ? "本机" : "云端"}的版本\n`);
        }
        for (const r of result.rejected) {
          process.stdout.write(`  没推上去 ${r.scope}/${r.key}：${r.reason}（还留在本地，下次同步再推）\n`);
        }
        return 0;
      }
      case "pref": {
        const sub = argv[1];
        if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
          process.stdout.write("用法：nyra cloud pref <get <键>|set <键> <值>|list>\n偏好只认 " + PREF_KEYS.join("、") + "；改完跑 nyra cloud sync 推到云端。\n");
          return 0;
        }
        const accountId = await requireAccount(home);
        const device = getOrCreateDeviceId(home);
        if (sub === "list") {
          const prefs = listPreferences(home, accountId);
          if (!prefs.length) process.stdout.write("还没有偏好（nyra cloud pref set <键> <值>）\n");
          for (const p of prefs) {
            process.stdout.write(`${p.key} = ${p.value}${p.dirty ? "（未同步）" : ""}\n`);
          }
          return 0;
        }
        if (sub === "get") {
          const key = argv[2];
          if (!key) { process.stderr.write("用法：nyra cloud pref get <键>\n"); return 2; }
          const value = getPreference(home, accountId, key);
          process.stdout.write(value === null ? `${key}：未设置\n` : `${key} = ${value}\n`);
          return 0;
        }
        if (sub === "set") {
          const key = argv[2];
          const value = argv[3];
          if (!key || value === undefined) { process.stderr.write("用法：nyra cloud pref set <键> <值>\n"); return 2; }
          setPreference(home, accountId, key, value, device.device_id);
          process.stdout.write(`已记下 ${key} = ${value}（本地已改，跑 nyra cloud sync 推到云端）\n`);
          return 0;
        }
        process.stderr.write(`未知 pref 子命令：${sub}\n用法：nyra cloud pref <get <键>|set <键> <值>|list>\n`);
        return 2;
      }
      case "devices": {
        const { client } = await cloudClientForSession(home);
        const devices = await client.listDevices();
        if (!devices.length) {
          process.stdout.write("云端没有登记的设备\n");
          return 0;
        }
        for (const d of devices) {
          process.stdout.write(`${d.current ? "* " : "  "}${d.name}（${d.id.slice(0, 8)}…，上次出现 ${d.last_seen}）\n`);
        }
        return 0;
      }
      case "set-url": {
        const url = argv[1];
        if (!url) { process.stderr.write("用法：nyra cloud set-url <云端地址>\n"); return 2; }
        const err = validateCloudUrl(url);
        if (err) { process.stderr.write(err + "\n"); return 1; }
        const cfg = loadConfig(home);
        const prev = cfg.cloud && typeof cfg.cloud === "object" && !Array.isArray(cfg.cloud)
          ? cfg.cloud as Record<string, unknown>
          : {};
        saveConfig(home, { cloud: { ...prev, url: url.trim() } });
        process.stdout.write(`云端地址已记下：${url.trim()}\n`);
        if (url.trim() === CLOUD_DESIGN_URL) {
          process.stdout.write("注意：这是设计占位地址（解析不到真实服务），只作占位；真云端地址到位后再改一次。\n");
        }
        return 0;
      }
      default: {
        process.stderr.write(`未知 cloud 子命令：${cmd}\n${CLOUD_USAGE}\n`);
        return 2;
      }
    }
  } catch (err: unknown) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    return 1;
  }
}
