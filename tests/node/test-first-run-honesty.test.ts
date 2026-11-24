// tests/node/test-first-run-honesty.test.ts — P0-2 首次运行诚实：向导结束语、
// doctor 的 Ollama 实测与过期说法、无 Key 提示按当前 provider 写变量名、
// 桌面测试失败文案带原因。只测纯逻辑与文案，不调真模型、不用真 Key。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runWizard } from "../../src/wizard.ts";
import { runDoctor } from "../../src/doctor.ts";
import { noKeyMessage } from "../../src/noKey.ts";
import { loadConfig, resolveProvider } from "../../src/config.ts";
import { MESSAGES } from "../../src/i18n.ts";

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
    expect(text).not.toContain("python3 -m nyra");
    expect(text).toContain("nyra doctor");
    expect(text).toContain("本地示例任务");
  } finally {
    console.log = origLog;
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
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
