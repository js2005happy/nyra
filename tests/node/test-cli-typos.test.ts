// tests/node/test-cli-typos.test.ts — 打错子命令不调模型；子命令后的未知选项报错。
//
// 回归：`DEEPSEEK_API_KEY=… nyra doctr` 以前真的把 "doctr" 当任务发给模型（计费）；
// `nyra ui --prot 9000` 静默忽略 --prot，照常起在 8765。
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editDistance, suggestSubcommand, findUnknownFlag, SUBCOMMAND_FLAGS } from "../../src/cliTypos.ts";
import { subcommandSet } from "../../src/subcommands.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const SUBS = subcommandSet();

test("editDistance：插入/删除/替换/相邻对调各算 1", () => {
  expect(editDistance("doctr", "doctor")).toBe(1);
  expect(editDistance("doctro", "doctor")).toBe(1);
  expect(editDistance("setpu", "setup")).toBe(1);
  expect(editDistance("abc", "abc")).toBe(0);
  expect(editDistance("kitten", "sitting")).toBe(3);
});

test("suggestSubcommand：近似的单个词给建议", () => {
  expect(suggestSubcommand("doctr", SUBS)).toBe("doctor");
  expect(suggestSubcommand("settup", SUBS)).toBe("setup");
  expect(suggestSubcommand("scheduel", SUBS)).toBe("schedule");
  expect(suggestSubcommand("uii", SUBS)).toBe("ui");
});

test("suggestSubcommand：正常任务文本不拦（多个词、中文、真子命令、不像任何子命令的词）", () => {
  for (const task of ["帮我写个脚本", "refactor the code", "doctor", "hello", "test", "summarize", "fix", "Doctr", " doctr", "doctr please"]) {
    expect(suggestSubcommand(task, SUBS)).toBeNull();
  }
});

test("findUnknownFlag：ui 认识的选项放行，打错的给最接近的建议，--x=y 提示正确写法", () => {
  const ui = SUBCOMMAND_FLAGS.ui;
  expect(findUnknownFlag(["--host", "127.0.0.1", "--port", "0", "--print-url-json", "--exit-on-stdin-close", "--workdir", "/tmp/x"], ui.value, ui.bool)).toBeNull();
  expect(findUnknownFlag(["--pair"], ui.value, ui.bool)).toBeNull();
  expect(findUnknownFlag(["--prot", "9000"], ui.value, ui.bool)).toEqual({ flag: "--prot", suggestion: "--port" });
  expect(findUnknownFlag(["--port=9000"], ui.value, ui.bool)).toEqual({ flag: "--port=9000", suggestion: "--port 9000" });
  expect(findUnknownFlag(["--zzzzzzzz"], ui.value, ui.bool)).toEqual({ flag: "--zzzzzzzz", suggestion: null });
});

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), "nyra-typo-home-"));
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, ...argv],
    env: {
      ...process.env, NYRA_HOME: home, NYRA_CONFIG: join(home, "config.json"), NYRA_LANG: "en",
      // 假 Key + 不可达地址：万一真的发了请求，会是连接错误而不是“did you mean”。
      DEEPSEEK_API_KEY: "sk-test-not-real", NYRA_BASE_URL: "http://127.0.0.1:9",
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

test("真 CLI：nyra doctr → 提示 doctor、退出码 2、没有模型调用", async () => {
  const r = await run(["doctr"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("nyra doctor");
  expect(r.stdout).toBe("");
}, 30000);

test("真 CLI：nyra ui --prot 9000 → 报未知选项并建议 --port，不启动服务", async () => {
  const r = await run(["ui", "--prot", "9000"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("--prot");
  expect(r.stderr).toContain("--port");
}, 30000);

test("真 CLI：nyra doctor --bogus → 报未知选项", async () => {
  const r = await run(["doctor", "--bogus"]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("--bogus");
}, 30000);
