// tests/node/wizard.test.ts — 向导的提问队列（管道输入不丢行）与 Key 绝不落盘。
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { expectPerms } from "./fsPerms.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { createAsker, runWizard, detectShellRc, maskKey, findRcKey, removeRcKey, readSecret } from "../../src/wizard.ts";
import { loadConfig, resolveProvider } from "../../src/config.ts";
import { Vault, getCredential } from "../../src/vault.ts";

test("createAsker：管道式一次性到齐的行不丢，按序回答", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = createInterface({ input, output });
  const { ask } = createAsker(rl);
  input.write("first\nsecond\nthird\n");
  input.end();
  expect(await ask("q1: ")).toBe("first");
  expect(await ask("q2: ")).toBe("second");
  expect(await ask("q3: ")).toBe("third");
  expect(await ask("q4: ")).toBe(""); // EOF 后当作空回答，不挂住
  rl.close();
});

test("向导无 Key 全默认：三步跑通，config 只有 provider/model，没有 Key", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-wizard-test-"));
  const origHome = process.env.HOME;
  process.env.HOME = home;
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
    expect(result.provider).toBe("deepseek");
    expect(result.model).toBe("deepseek-flash");
    expect(result.exampleOk).toBe(true);
    expect(result.keyConfigured).toBe(false);
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf-8"));
    expect(saved.provider).toBe("deepseek");
    expect(JSON.stringify(saved)).not.toMatch("sk-");
  } finally {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  }
});

test("向导填 Key 后拒绝写 rc：Key 不进 config.json，也不进 shell rc", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-wizard-key-test-"));
  const rc = join(home, ".bashrc");
  writeFileSync(rc, "", "utf-8");
  const origHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const config = loadConfig(home);
    const provider = resolveProvider({ home, config });
    const file = join(home, "sample.txt");
    writeFileSync(file, "hello", "utf-8");
    const run = runWizard({ home, provider, config, exampleFile: file, input, output });
    // 新流程先问存哪、再读 Key：选 deepseek → 模型默认 → 不追加进 rc → 填 Key。
    input.write("3\n\nn\nsk-test-fake-key-999\n");
    input.end();
    const result = await run;
    expect(result.exampleOk).toBe(true);
    expect(readFileSync(join(home, "config.json"), "utf-8")).not.toMatch("sk-test-fake-key-999");
    expect(readFileSync(rc, "utf-8")).not.toMatch("sk-test-fake-key-999");
  } finally {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  }
});

test("向导用自定义 provider：全默认不崩，示例任务跑通", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-wizard-custom-test-"));
  const input = new PassThrough();
  const output = new PassThrough();
  const config = loadConfig(home);
  config.custom_providers = {
    myllm: { base_url: "http://127.0.0.1:8080/v1", default_model: "my-model", env_key: "MYLLM_API_KEY", models: ["my-model"] },
  };
  config.provider = "myllm";
  config.model = "my-model";
  delete process.env.MYLLM_API_KEY;
  const provider = resolveProvider({ home, config });
  const file = join(home, "sample.txt");
  writeFileSync(file, "hello custom", "utf-8");
  const run = runWizard({ home, provider, config, exampleFile: file, input, output });
  input.write("\n\n\n");
  input.end();
  const result = await run;
  expect(result.provider).toBe("myllm");
  expect(result.model).toBe("my-model");
  expect(result.exampleOk).toBe(true);
});

test("detectShellRc：SHELL=zsh 时优先 .zshrc", () => {
  const origShell = process.env.SHELL;
  const origHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "nyra-rc-test-"));
  process.env.HOME = home;
  process.env.SHELL = "/bin/zsh";
  try {
    expect(detectShellRc()).toBe(join(home, ".zshrc"));
  } finally {
    process.env.SHELL = origShell;
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  }
});

// -- 0.4.1 审查 12 项：第 10 项（向导 Key 掩码与 rc 明文） --
test("Wizard041Test.test_mask_key_shows_last_4_only", () => {
  expect(maskKey("sk-abcdef1234")).toBe("****1234");
  expect(maskKey("abc")).toBe("****");
  expect(maskKey("")).toBe("****");
});

test("Wizard041Test.test_find_and_remove_rc_key", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-wizard-rc-"));
  const rc = join(home, ".bashrc");
  writeFileSync(rc, "export FOO=1\nexport DEEPSEEK_API_KEY=sk-old-111\nexport DEEPSEEK_API_KEY=\"sk-new-222\"\n# export DEEPSEEK_API_KEY=sk-comment-333\nexport BAR=2\n", "utf-8");
  expect(findRcKey(rc, "DEEPSEEK_API_KEY")).toBe("sk-new-222");
  expect(findRcKey(rc, "MISSING_KEY")).toBeNull();
  expect(findRcKey(null, "DEEPSEEK_API_KEY")).toBeNull();
  expect(removeRcKey(rc, "DEEPSEEK_API_KEY")).toBe(true);
  const text = readFileSync(rc, "utf-8");
  expect(text).not.toContain("sk-old-111");
  expect(text).not.toContain("sk-new-222");
  expect(text).toContain("export FOO=1");
  expect(text).toContain("export BAR=2");
  expect(removeRcKey(rc, "DEEPSEEK_API_KEY")).toBe(false);
});

test("Wizard041Test.test_read_secret_falls_back_to_plain_ask_when_piped", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rl = createInterface({ input, output });
  const { ask } = createAsker(rl);
  const run = readSecret("Key：", ask, input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
  input.write("sk-piped-key-123\n");
  input.end();
  expect(await run).toBe("sk-piped-key-123");
  rl.close();
});

test("Wizard041Test.test_wizard_append_rc_chmod_600", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-wizard-append-"));
  const rc = join(home, ".bashrc");
  writeFileSync(rc, "", "utf-8");
  const origHome = process.env.HOME;
  const origKey = process.env.DEEPSEEK_API_KEY;
  process.env.HOME = home;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const config = loadConfig(home);
    const provider = resolveProvider({ home, config });
    const file = join(home, "sample.txt");
    writeFileSync(file, "hello", "utf-8");
    const run = runWizard({ home, provider, config, exampleFile: file, input, output });
    input.write("3\n\ny\nsk-test-fake-key-999\n");
    input.end();
    const result = await run;
    expect(result.exampleOk).toBe(true);
    expect(result.keyConfigured).toBe(false);
    expect(readFileSync(rc, "utf-8")).toContain("export DEEPSEEK_API_KEY=sk-test-fake-key-999");
    expect(readFileSync(join(home, "config.json"), "utf-8")).not.toContain("sk-test-fake-key-999");
    if (process.platform !== "win32") {
      expectPerms(rc, 0o600);
    }
  } finally {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origKey !== undefined) process.env.DEEPSEEK_API_KEY = origKey;
  }
});

test("Wizard041Test.test_wizard_migrates_rc_key_into_vault", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-wizard-migrate-"));
  const rc = join(home, ".bashrc");
  writeFileSync(rc, "export DEEPSEEK_API_KEY=sk-rc-key-777\n", "utf-8");
  const vault = new Vault(join(home, "vault.json"));
  vault.init("master-pass");
  const origHome = process.env.HOME;
  const origKey = process.env.DEEPSEEK_API_KEY;
  const origPw = process.env.NYRA_VAULT_PASSWORD;
  process.env.HOME = home;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.NYRA_VAULT_PASSWORD = "master-pass";
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const config = loadConfig(home);
    const provider = resolveProvider({ home, config });
    const file = join(home, "sample.txt");
    writeFileSync(file, "hello", "utf-8");
    const run = runWizard({ home, provider, config, exampleFile: file, input, output });
    // 选 deepseek → 模型默认 → 迁入密码箱（y）。
    input.write("3\n\ny\n");
    input.end();
    const result = await run;
    expect(result.exampleOk).toBe(true);
    expect(result.keyConfigured).toBe(true);
    expect(getCredential("DEEPSEEK_API_KEY", home)).toBe("sk-rc-key-777");
    expect(readFileSync(rc, "utf-8")).not.toContain("sk-rc-key-777");
  } finally {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origKey !== undefined) process.env.DEEPSEEK_API_KEY = origKey;
    if (origPw === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = origPw;
  }
});

test("Wizard041Test.test_wizard_stores_new_key_in_vault_by_default", async () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-wizard-vault-"));
  const rc = join(home, ".bashrc");
  writeFileSync(rc, "", "utf-8");
  const vault = new Vault(join(home, "vault.json"));
  vault.init("master-pass");
  const origHome = process.env.HOME;
  const origKey = process.env.DEEPSEEK_API_KEY;
  const origPw = process.env.NYRA_VAULT_PASSWORD;
  process.env.HOME = home;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.NYRA_VAULT_PASSWORD = "master-pass";
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const config = loadConfig(home);
    const provider = resolveProvider({ home, config });
    const file = join(home, "sample.txt");
    writeFileSync(file, "hello", "utf-8");
    const run = runWizard({ home, provider, config, exampleFile: file, input, output });
    // 选 deepseek → 模型默认 → 存哪默认（回车=密码箱）→ 填 Key。
    input.write("3\n\n\nsk-new-key-888\n");
    input.end();
    const result = await run;
    expect(result.exampleOk).toBe(true);
    expect(result.keyConfigured).toBe(true);
    expect(getCredential("DEEPSEEK_API_KEY", home)).toBe("sk-new-key-888");
    expect(readFileSync(rc, "utf-8")).not.toContain("sk-new-key-888");
    expect(readFileSync(join(home, "config.json"), "utf-8")).not.toContain("sk-new-key-888");
  } finally {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origKey !== undefined) process.env.DEEPSEEK_API_KEY = origKey;
    if (origPw === undefined) delete process.env.NYRA_VAULT_PASSWORD;
    else process.env.NYRA_VAULT_PASSWORD = origPw;
  }
});
