// tests/node/test-first-run-honesty.test.ts — P0-2 首次运行诚实：向导结束语、
// doctor 的 Ollama 实测与过期说法、无 Key 提示按当前 provider 写变量名、
// 桌面测试失败文案带原因。只测纯逻辑与文案，不调真模型、不用真 Key。
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runWizard } from "../../src/wizard.ts";
import { runDoctor } from "../../src/doctor.ts";
import { noKeyMessage } from "../../src/noKey.ts";
import { loadConfig, resolveProvider } from "../../src/config.ts";
import { MESSAGES, getLang, setLang } from "../../src/i18n.ts";

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "nyra-first-run-"));
  chmodSync(home, 0o700); // doctor 的“配置目录”一项要求 0700
  return home;
}

test("FirstRunHonesty.test_wizard_closing_is_honest", async () => {
  const home = tempHome();
  const origHome = process.env.HOME;
  const origKey = process.env.DEEPSEEK_API_KEY;
  process.env.HOME = home;
  delete process.env.DEEPSEEK_API_KEY;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const config = loadConfig(home);
    const provider = resolveProvider({ home, config });
    const file = join(home, "sample.txt");
    writeFileSync(file, "hello wizard", "utf-8");
    const run = runWizard({ home, provider, config, exampleFile: file, input, output });
    input.write("\n\n\n");
    input.end();
    const result = await run;
    expect(result.exampleOk).toBe(true);
    const text = logs.join("\n");
    expect(text).not.toContain("第一个任务已经跑通");
    expect(text).not.toContain("跑起第一个任务");
    expect(text).not.toContain("python3 -m nyra");
    expect(text).toContain("本地示例不调用模型");
    expect(text).toContain("也不代表 Key 或模型已经连通");
    expect(text).toContain("nyra doctor");
    expect(text).toContain("本地示例");
  } finally {
    console.log = origLog;
    process.env.HOME = origHome;
    if (origKey !== undefined) process.env.DEEPSEEK_API_KEY = origKey;
  }
});

test("FirstRunHonesty.test_no_key_message_names_current_provider_env_key", () => {
  const home = tempHome();
  const origQwen = process.env.DASHSCOPE_API_KEY;
  const origDeepseek = process.env.DEEPSEEK_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const config = loadConfig(home);
    const qwen = resolveProvider({ home, config, providerName: "qwen" });
    const qwenMsg = noKeyMessage(qwen);
    expect(qwenMsg).toContain("DASHSCOPE_API_KEY");
    expect(qwenMsg).not.toContain("DEEPSEEK_API_KEY");
    const deepseek = resolveProvider({ home, config, providerName: "deepseek" });
    expect(noKeyMessage(deepseek)).toContain("DEEPSEEK_API_KEY");
  } finally {
    if (origQwen !== undefined) process.env.DASHSCOPE_API_KEY = origQwen;
    if (origDeepseek !== undefined) process.env.DEEPSEEK_API_KEY = origDeepseek;
  }
});

test("FirstRunHonesty.test_no_key_message_points_at_window_key_input", () => {
  const home = tempHome();
  const origKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const config = loadConfig(home);
    const provider = resolveProvider({ home, config, providerName: "deepseek" });
    const msg = noKeyMessage(provider);
    expect(msg).toContain("测试连接");
    expect(msg).toContain("窗口");
  } finally {
    if (origKey !== undefined) process.env.DEEPSEEK_API_KEY = origKey;
  }
});

test("FirstRunHonesty.test_no_key_message_has_no_stale_phase_claims", () => {
  const home = tempHome();
  const origKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const config = loadConfig(home);
    for (const name of ["deepseek", "qwen", "ollama", "codex"]) {
      const provider = resolveProvider({ home, config, providerName: name });
      const msg = noKeyMessage(provider);
      expect(msg).not.toContain("第 1 阶段");
      expect(msg).not.toContain("第 2 阶段");
      expect(msg).not.toContain("尚未接连接器");
    }
  } finally {
    if (origKey !== undefined) process.env.DEEPSEEK_API_KEY = origKey;
  }
});

test("FirstRunHonesty.test_doctor_ollama_down_fails", async () => {
  const home = tempHome();
  const throwingFetch = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
  }) as unknown as typeof fetch;
  const result = await runDoctor({ home, providerName: "ollama", fetchFn: throwingFetch });
  expect(result.allOk).toBe(false);
  const modelCheck = result.checks.find((c) => c.name === "模型配置");
  expect(modelCheck).toBeDefined();
  expect(modelCheck!.ok).toBe(false);
  expect(modelCheck!.detail).toContain("Ollama 未启动");
  expect(modelCheck!.fix).toContain("ollama serve");
});

test("FirstRunHonesty.test_doctor_ollama_up_passes", async () => {
  const home = tempHome();
  const okFetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  const result = await runDoctor({ home, providerName: "ollama", fetchFn: okFetch });
  const modelCheck = result.checks.find((c) => c.name === "模型配置");
  expect(modelCheck).toBeDefined();
  expect(modelCheck!.ok).toBe(true);
  expect(modelCheck!.detail).toContain("Ollama 已启动");
  // 不断言 allOk：全量跑时 /tmp 会被其他测试的临时 home 占满，“磁盘空间”
  // 一项可能因剩余不足 100MB 而失败，那与 Ollama 探针无关。
});

test("FirstRunHonesty.test_doctor_no_key_names_env_key_not_connector", async () => {
  const home = tempHome();
  const origKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const result = await runDoctor({ home });
    const modelCheck = result.checks.find((c) => c.name === "模型配置");
    expect(modelCheck).toBeDefined();
    expect(modelCheck!.ok).toBe(false);
    expect(modelCheck!.detail).not.toContain("第 1 阶段");
    expect(modelCheck!.detail).not.toContain("尚未接连接器");
    expect(modelCheck!.detail).not.toContain("连接器");
    expect(modelCheck!.fix ?? "").toMatch(/DEEPSEEK_API_KEY|nyra setup/);
  } finally {
    if (origKey !== undefined) process.env.DEEPSEEK_API_KEY = origKey;
  }
});

test("FirstRunHonesty.test_no_key_message_follows_cli_language", () => {
  const home = tempHome();
  const prev = getLang();
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const config = loadConfig(home);
    const qwen = resolveProvider({ home, config, providerName: "qwen" });
    setLang("en");
    const en = noKeyMessage(qwen);
    expect(en).toContain("qwen");
    expect(en).toContain("DASHSCOPE_API_KEY");
    expect(en).toContain("nyra setup");
    expect(en).toContain("nyra ui");
    expect(en).toContain("Test the connection");
    expect(en).not.toContain("DEEPSEEK_API_KEY");
    expect(en).not.toContain("<redacted>");
    expect(en).not.toContain("python3 -m nyra");
    setLang("zh");
    const zh = noKeyMessage(qwen);
    expect(zh).toContain("qwen");
    expect(zh).toContain("DASHSCOPE_API_KEY");
    expect(zh).toContain("测试连接");
    expect(zh).toContain("窗口");
    expect(zh).toContain("nyra setup");
    expect(zh).not.toContain("DEEPSEEK_API_KEY");
    expect(zh).not.toContain("<redacted>");
    expect(zh).not.toContain("python3 -m nyra");
  } finally {
    setLang(prev);
  }
});

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NYRA_HOME: home };
  for (const key of Object.keys(env)) {
    if (key === "NYRA_LANG" || key === "NYRA_VAULT_PASSWORD" || key === "NYRA_API_KEY" || key.endsWith("_API_KEY")) delete env[key];
  }
  env.NYRA_SENTINEL = "nyra-sentinel-not-a-key";
  return env;
}

function runCli(home: string, args: string[], input?: string) {
  return spawnSync("bun", ["run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: isolatedEnv(home),
    encoding: "utf-8",
    input,
    timeout: 30000,
  });
}

test("FirstRunHonesty.test_cli_missing_credentials_names_provider_in_both_languages", () => {
  const home = tempHome();
  const zh = runCli(home, ["--lang", "zh", "--provider", "qwen", "hello"]);
  const en = runCli(home, ["--lang", "en", "--provider", "qwen", "hello"]);
  for (const run of [zh, en]) {
    expect(run.status).toBe(1);
    const text = `${run.stdout}\n${run.stderr}`;
    expect(text).toContain("qwen");
    expect(text).toContain("DASHSCOPE_API_KEY");
    expect(text).toContain("nyra setup");
    expect(text).not.toContain("DEEPSEEK_API_KEY");
    expect(text).not.toContain("<redacted>");
    expect(text).not.toContain("python3 -m nyra");
    expect(text).not.toContain("nyra-sentinel-not-a-key");
  }
  expect(zh.stdout).toContain("测试连接");
  expect(en.stdout).toContain("Test the connection");
  expect(en.stdout).toContain("did not contact the model");
});

test("FirstRunHonesty.test_cli_setup_describes_offline_example", () => {
  const home = tempHome();
  const run = runCli(home, ["setup"], "\n\n\n");
  expect(run.status).toBe(0);
  const text = `${run.stdout}\n${run.stderr}`;
  expect(text).toContain("本地示例不调用模型");
  expect(text).toContain("也不代表 Key 或模型已经连通");
  expect(text).toContain("还不是模型任务");
  expect(text).not.toContain("第一个任务已经跑通");
  expect(text).not.toContain("python3 -m nyra");
  expect(text).not.toContain("nyra-sentinel-not-a-key");
});

test("FirstRunHonesty.test_setup_no_creds_template_is_gone", () => {
  expect(Object.keys(MESSAGES.zh)).not.toContain("setup.noCreds");
  expect(Object.keys(MESSAGES.en)).not.toContain("setup.noCreds");
});

test("FirstRunHonesty.test_key_test_failure_text_carries_a_reason", () => {
  expect(MESSAGES.zh["d.key.testBad"]).toContain("确认服务");
  expect(MESSAGES.en["d.key.testBad"]).toContain("Check the service");
  expect(MESSAGES.zh["d.setup.title"]).toBe("设置 Nyra");
  expect(MESSAGES.en["d.setup.title"]).toBe("Set up Nyra");
});

test("FirstRunHonesty.test_desktop_save_is_gated_on_passed_test", () => {
  const asset = readFileSync(new URL("../../src/assets/desktop-app.js.txt", import.meta.url), "utf-8");
  // 保存按钮只在测试通过后可用，没测通时是禁用的。
  expect(asset).toContain("S.setup.tested && S.setup.tested.ok");
  // 测试失败时展示服务端回的错误，拿不到错误说明时才回落到带原因的通用文案。
  expect(asset).toContain("r.error || t('d.key.testBad')");
});
