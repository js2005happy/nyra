// src/doctor.ts — `nyra doctor` 中文自检。
// 检查项（每项中文说明 + 故障给中文修复步骤，最多 8 项）：
// 1）运行时（含版本下限：Bun >= 1.4 或 Node >= 24；Node 22 及以下没有开箱即用的
// node:sqlite，示例任务跑不起来）2）配置文件 3）配置目录（存在 + 0700）
// 4）provider 与 Key 5）网络 6）磁盘空间 7）写权限 8）vault.json 权限（存在时）。
// vault.json 不存在时只有 7 项；配置文件损坏或 provider 未知时提前返回，
// 后面的项本次不查（不是“通过”，是没查到）。
// 网络检查只发一个不带 Key 的连通性请求（HEAD 到 provider base_url 的根），
// 超时 5 秒；失败时明确说“网络不通”，不把模型报错当网络故障。
import { existsSync, statSync, writeFileSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveProvider, VERSION } from "./config.ts";
import { loadModelCache, manualWindowFromConfig, resolveContextWindow, type WindowSource } from "./modelCatalog.ts";
import { vaultExists, vaultMode } from "./vault/index.ts";
// 调研报告第 9 项：OS 级分级沙箱（学 Codex CLI）——doctor 加一项隔离级别检查。
import { getSandboxStatus, sandboxLevelText } from "./sandbox.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface DoctorOptions {
  home: string;
  providerName?: string;
  /** 测试注入：替代默认的 fetch（验收“网络不通”时注入一个必失败的 fetch）。 */
  fetchFn?: typeof fetch;
  /** 测试注入：替代默认的网络目标（默认用当前 provider 的 base_url 根）。 */
  networkUrl?: string;
}

const MB = 1024 * 1024;

/** 运行时版本是否够用：Bun >= 1.4，或 Node >= 24（node:sqlite 在 24 才开箱即用）。 */
export function runtimeVersionOk(runtime: string): boolean {
  const m = runtime.match(/^(Bun|Node) v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const kind = m[1];
  const major = Number(m[2]);
  const minor = Number(m[3]);
  if (kind === "Bun") return major > 1 || (major === 1 && minor >= 4);
  return major >= 24;
}

async function checkNetwork(url: string, fetchFn: typeof fetch): Promise<{ ok: boolean; detail: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const resp = await fetchFn(url, { method: "HEAD", signal: ctrl.signal, redirect: "manual" });
    return { ok: true, detail: `能连通 ${url}（HTTP ${resp.status}，不带 Key 的连通性检查）` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `连不上 ${url}：${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function runDoctor(opts: DoctorOptions): Promise<{ checks: DoctorCheck[]; allOk: boolean }> {
  const { home } = opts;
  const checks: DoctorCheck[] = [];

  // 1）运行时（含版本下限；以前只打印版本号、永远通过，旧运行时也能“全绿”）
  const runtime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
    ? `Bun ${(globalThis as { Bun: { version: string } }).Bun.version}`
    : `Node ${process.version}`;
  const runtimeOk = runtimeVersionOk(runtime);
  checks.push({
    name: "运行时", ok: runtimeOk,
    detail: `${runtime}（nyra ${VERSION}，Node 运行时第 1 阶段）${runtimeOk ? "" : "（版本太低）"}`,
    fix: runtimeOk ? undefined : "升级 Bun 到 1.4+（bun upgrade），或改用 Node 24+ 运行；Node 22 及以下没有开箱即用的 node:sqlite，示例任务会失败。",
  });

  // 2）配置文件（先读：不存在时按 Python 版行为自动建默认文件与 0700 目录）
  let config: Record<string, unknown>;
  try {
    config = loadConfig(home);
    checks.push({ name: "配置文件", ok: true, detail: `${join(home, "config.json")} 可读，provider=${config.provider ?? "（未设）"}，model=${config.model ?? "（未设）"}` });
  } catch (err) {
    checks.push({ name: "配置文件", ok: false, detail: `config.json 读失败：${err instanceof Error ? err.message : String(err)}`, fix: `删掉损坏的 ${join(home, "config.json")} 后重跑 nyra setup，会重建默认配置。` });
    return { checks, allOk: false };
  }

  // 2b）隔离级别（调研报告第 9 项：OS 级分级沙箱，学 Codex CLI）。
  // 这一项恒为通过：bwrap 不可用、回落到工具级是预期内的降级，不是故障，
  // 不要让 doctor 因为 bwrap 缺失而整体报失败；显式要求 bwrap 但缺失时，
  // 原因写进 detail，shell 执行时会 fail-closed 报错（见 docs/sandbox.md）。
  const sandboxStatus = getSandboxStatus(config);
  // P0-6：级别文案按 level 全列出来——之前只有 bwrap/tool-level 两档，
  // seatbelt 与 jobobject 会误显示"未生效"。jobobject 是进程级沙箱，文案写明。
  // 隔离补强批：三后端可用性全列出来，auto 会选谁一眼可见（本机无某后端时
  // 只显示不可用，不报错——回落到工具级是预期内的降级）。
  const levelText = sandboxLevelText(sandboxStatus.level);
  checks.push({
    name: "隔离级别", ok: true,
    detail: `沙箱后端 ${sandboxStatus.backend}，模式 ${sandboxStatus.mode}，隔离级别 ${levelText}，可用后端：bwrap ${sandboxStatus.bwrapAvailable ? "可用" : "不可用"}、Seatbelt ${sandboxStatus.seatbeltAvailable ? "可用" : "不可用"}、Job Object ${sandboxStatus.jobObjectAvailable ? "可用" : "不可用"}——${sandboxStatus.detail}`,
  });

  // 3）配置目录（loadConfig 已建好；这里只验存在与 0700）
  if (!existsSync(home)) {
    checks.push({ name: "配置目录", ok: false, detail: `配置目录 ${home} 不存在`, fix: `手动建：mkdir -m 700 ${home}` });
  } else {
    let modeOk = true;
    let modeText = "（Windows 没有 POSIX 权限位，不检查）";
    if (process.platform !== "win32") {
      try {
        const mode = statSync(home).mode & 0o777;
        modeOk = mode === 0o700;
        modeText = `权限 ${mode.toString(8)}${modeOk ? "" : "（应为 700）"}`;
      } catch { modeOk = false; modeText = "读不到目录权限"; }
    }
    checks.push({
      name: "配置目录", ok: modeOk, detail: `${home} 存在，${modeText}`,
      fix: modeOk ? undefined : `chmod 700 ${home}（目录权限太松时，别人可能读到你的配置）。`,
    });
  }

  // 4）provider 与 Key
  let provider;
  try {
    provider = resolveProvider({ home, config, providerName: opts.providerName });
  } catch (err) {
    checks.push({ name: "模型配置", ok: false, detail: String(err instanceof Error ? err.message : err), fix: "运行 nyra setup 重新选模型来源，或检查 ~/.nyra/config.json 里的 provider / model。" });
    return { checks, allOk: false };
  }
  // 模型上下文窗口：自动识别（内置表/刷新缓存），手动配置优先；未知模型写清原因。
  const winManual = manualWindowFromConfig(config);
  const winResolved = resolveContextWindow({ model: provider.model, provider: provider.name, manual: winManual.value, manualKey: winManual.key, cache: loadModelCache(home) });
  const winSourceZh: Record<WindowSource, string> = { cli: "命令行 --context-window 指定", manual: "手动配置", cache: "刷新缓存（OpenRouter）", builtin: "内置模型表", family: "内置模型表（同系列推断）", unknown: "未知" };
  const winText = winResolved.window !== null
    ? `，上下文窗口 ${winResolved.window.toLocaleString("en-US")} tokens（${winSourceZh[winResolved.source]}）`
    : `，上下文窗口未知（${winResolved.detail}）`;
  if (provider.auth === "cli") {
    checks.push({ name: "模型配置", ok: true, detail: `provider=${provider.name}（Codex CLI，复用本机登录，不需要 Key）${winText}` });
  } else if (provider.name === "ollama") {
    checks.push({ name: "模型配置", ok: true, detail: `provider=ollama（本地模型，不需要 Key，默认 ${provider.baseUrl}）${winText}` });
  } else if (provider.hasKey) {
    checks.push({ name: "模型配置", ok: true, detail: `provider=${provider.name}，模型 ${provider.model}，Key 已配置（来源：${provider.keySource === "file" ? "界面保存（keys.json）" : provider.keySource === "vault" ? "密码箱" : `环境变量 ${provider.envKey}`}）${winText}` });
  } else if (provider.keySource === "vault") {
    checks.push({
      name: "模型配置", ok: false,
      detail: `provider=${provider.name}，模型 ${provider.model}，环境变量里没有 Key；检测到密码箱 vault.json，但第 1 阶段还不能解密它${winText}`,
      fix: provider.envKey
        ? `先用环境变量提供 Key：export ${provider.envKey}=你的Key（第 2 阶段恢复密码箱读取后就不用每次 export）。`
        : `先用环境变量 NYRA_API_KEY 提供 Key。`,
    });
  } else if (provider.auth === "connector") {
    checks.push({
      name: "模型配置", ok: false,
      detail: `provider=${provider.name}，模型 ${provider.model}，环境变量里没有 Key；该 provider 在 Python 版走连接器注入，Node 版第 1 阶段尚未接连接器${winText}`,
      fix: provider.envKey ? `先用环境变量提供 Key：export ${provider.envKey}=你的Key。` : "先用环境变量 NYRA_API_KEY 提供 Key。",
    });
  } else {
    checks.push({
      name: "模型配置", ok: false,
      detail: `provider=${provider.name}，模型 ${provider.model}，没有配置 Key${winText}`,
      fix: provider.envKey
        ? `设置 Key：export ${provider.envKey}=你的Key；或运行 nyra setup 走向导配置。`
        : "运行 nyra setup 走向导配置。",
    });
  }

  // 5）网络（只对需要联网的 provider 检查；ollama/codex 本地型跳过外网检查）
  const needsNetwork = provider.auth !== "cli" && provider.name !== "ollama";
  if (needsNetwork) {
    const target = opts.networkUrl || provider.baseUrl.replace(/\/v1\/?$/, "/");
    const net = await checkNetwork(target, opts.fetchFn || fetch);
    checks.push({
      name: "网络", ok: net.ok, detail: net.detail,
      fix: net.ok ? undefined : "1）检查网络是否通（换个 Wi-Fi / 有线试试）；2）确认没有代理拦截：echo $https_proxy；3）如果在公司/学校网络，问网管是否放行了该域名；4）网络通了再重跑 nyra doctor。",
    });
  } else {
    checks.push({ name: "网络", ok: true, detail: `${provider.name} 是本地型 provider，不检查外网` });
  }

  // 6）磁盘空间
  try {
    const stat = statfsSync(home);
    const freeMB = Math.floor((stat.bavail * stat.bsize) / MB);
    const ok = freeMB >= 100;
    checks.push({
      name: "磁盘空间", ok, detail: `${home} 所在磁盘剩余约 ${freeMB} MB${ok ? "" : "（少于 100 MB）"}`,
      fix: ok ? undefined : "磁盘快满了：先清理磁盘再继续，否则会话、知识库写不进去。",
    });
  } catch {
    checks.push({ name: "磁盘空间", ok: true, detail: "读不到磁盘信息（跳过）" });
  }

  // 7）写权限
  const probeFile = join(home, ".nyra-doctor-write-test");
  try {
    writeFileSync(probeFile, "doctor-write-test", "utf-8");
    rmSync(probeFile);
    checks.push({ name: "写权限", ok: true, detail: `能在 ${home} 里写文件` });
  } catch (err) {
    checks.push({ name: "写权限", ok: false, detail: `写不进 ${home}：${err instanceof Error ? err.message : String(err)}`, fix: `检查目录归属与权限：ls -ld ${home}；必要时 chown 回你自己的用户，或 chmod 700 ${home}。` });
  }

  // 8）vault.json 权限（存在时；vaultMode 在 Windows 上返回 null，
  // POSIX 上返回 null 只可能是 stat 失败——不能当“通过”）。
  if (vaultExists(home)) {
    const mode = vaultMode(home);
    if (mode === null && process.platform === "win32") {
      checks.push({ name: "密码箱权限", ok: true, detail: "vault.json 存在（Windows 不检查权限位）" });
    } else if (mode === null) {
      checks.push({
        name: "密码箱权限", ok: false, detail: "vault.json 存在，但读不到它的权限位",
        fix: `检查 ${join(home, "vault.json")} 是否还存在、属主对不对：ls -l ${join(home, "vault.json")}；确认后跑 chmod 600 ${join(home, "vault.json")}。`,
      });
    } else {
      const ok = mode === 0o600;
      checks.push({
        name: "密码箱权限", ok, detail: `vault.json 存在，权限 ${mode.toString(8)}${ok ? "" : "（应为 600）"}`,
        fix: ok ? undefined : `chmod 600 ${join(home, "vault.json")}（密码箱权限太松时，别人可能读到你的凭据）。`,
      });
    }
  }

  return { checks, allOk: checks.every((c) => c.ok) };
}

export function printDoctorResult(result: { checks: DoctorCheck[]; allOk: boolean }): void {
  console.log("Nyra 自检（nyra doctor）");
  console.log("====================");
  for (const c of result.checks) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.name}：${c.detail}`);
    if (!c.ok && c.fix) console.log(`    修复：${c.fix}`);
  }
  console.log("====================");
  console.log(result.allOk ? "全部通过，可以开始用 Nyra。" : "有未通过的项，按上面的“修复”步骤处理后重跑 nyra doctor。");
}
