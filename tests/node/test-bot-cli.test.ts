// tests/node/test-bot-cli.test.ts — Bot 方向 Phase 1：CLI 入口。
// 无 token 时 start 报错、status 正常；token 解析三来源；真 CLI 子进程冒烟。
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleBot, resolveTelegramToken } from "../../src/bot/index.ts";
import { ApprovalBridge, approvalArgsHash } from "../../src/bot/approvalBridge.ts";
import { botPolicyFromConfig } from "../../src/bot/types.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

function tempHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function runCli(argv: string[], home: string, workdir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, ...argv, "--workdir", workdir],
    env: { ...process.env, NYRA_HOME: home, NYRA_CONFIG: join(home, "config.json"), NYRA_LAZY_TOOLS: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

test("token 解析：环境变量优先，缺失时报 missing", () => {
  const home = tempHome("nyra-bot-cli-");
  try {
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      expect(resolveTelegramToken(home).source).toBe("missing");
      process.env.TELEGRAM_BOT_TOKEN = "123:ENVTOKEN";
      const got = resolveTelegramToken(home);
      expect(got.source).toBe("env");
      expect(got.token).toBe("123:ENVTOKEN");
    } finally {
      if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = prev;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("token 解析：keys.json 里的条目能读到", () => {
  const home = tempHome("nyra-bot-cli2-");
  try {
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "keys.json"), JSON.stringify({ version: 1, keys: { "TELEGRAM_BOT_TOKEN": "123:FILETOKEN" } }));
      const got = resolveTelegramToken(home);
      expect(got.source).toBe("file");
      expect(got.token).toBe("123:FILETOKEN");
    } finally {
      if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = prev;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("handleBot：无 token 时 start 报错退出 1", async () => {
  const home = tempHome("nyra-bot-cli3-");
  try {
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    const logs: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const code = await handleBot(["telegram", "start"], home);
      expect(code).toBe(1);
      expect(logs.join("")).toContain("token");
    } finally {
      process.stderr.write = origErr;
      if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = prev;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("handleBot：status 未运行时正常退出 0", async () => {
  const home = tempHome("nyra-bot-cli4-");
  try {
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    const logs: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      const code = await handleBot(["telegram", "status"], home);
      expect(code).toBe(0);
      const out = logs.join("");
      expect(out).toContain("未运行");
      expect(out).toContain("未配置");
    } finally {
      process.stdout.write = origOut;
      if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = prev;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("handleBot：用法错误退出 2", async () => {
  const home = tempHome("nyra-bot-cli5-");
  try {
    const code1 = await handleBot([], home);
    expect(code1).toBe(2);
    const code2 = await handleBot(["telegram", "fly"], home);
    expect(code2).toBe(2);
    const code3 = await handleBot(["wechat", "start"], home);
    expect(code3).toBe(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("handleBot：stop 未运行时正常退出 0", async () => {
  const home = tempHome("nyra-bot-cli6-");
  try {
    const code = await handleBot(["telegram", "stop"], home);
    expect(code).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("真 CLI 子进程：nyra bot telegram status 能跑", async () => {
  const home = tempHome("nyra-bot-cli7-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-bot-cli-w-"));
  try {
    const { code, stdout } = await runCli(["bot", "telegram", "status"], home, workdir);
    expect(code).toBe(0);
    expect(stdout).toContain("Telegram Bot");
    expect(stdout).toContain("未运行");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("真 CLI 子进程：nyra bot 用法错误退出 2", async () => {
  const home = tempHome("nyra-bot-cli8-");
  const workdir = mkdtempSync(join(tmpdir(), "nyra-bot-cli-w2-"));
  try {
    const { code } = await runCli(["bot"], home, workdir);
    expect(code).toBe(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("handleBot：discord 无 token 时 start 报错退出 1", async () => {
  const home = tempHome("nyra-bot-cli9-");
  try {
    const prev = process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;
    const logs: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const code = await handleBot(["discord", "start"], home);
      expect(code).toBe(1);
      expect(logs.join("")).toContain("token");
    } finally {
      process.stderr.write = origErr;
      if (prev === undefined) delete process.env.DISCORD_BOT_TOKEN;
      else process.env.DISCORD_BOT_TOKEN = prev;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("handleBot：discord status 未运行时正常退出 0", async () => {
  const home = tempHome("nyra-bot-cli10-");
  try {
    const prev = process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;
    const logs: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      const code = await handleBot(["discord", "status"], home);
      expect(code).toBe(0);
      const out = logs.join("");
      expect(out).toContain("未运行");
      expect(out).toContain("未配置");
    } finally {
      process.stdout.write = origOut;
      if (prev === undefined) delete process.env.DISCORD_BOT_TOKEN;
      else process.env.DISCORD_BOT_TOKEN = prev;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("handleBot：slack 无 token 时 start 报错退出 1", async () => {
  const home = tempHome("nyra-bot-cli11-");
  try {
    const prevApp = process.env.SLACK_APP_TOKEN;
    const prevBot = process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    const logs: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const code = await handleBot(["slack", "start"], home);
      expect(code).toBe(1);
      expect(logs.join("")).toContain("token");
    } finally {
      process.stderr.write = origErr;
      if (prevApp === undefined) delete process.env.SLACK_APP_TOKEN;
      else process.env.SLACK_APP_TOKEN = prevApp;
      if (prevBot === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = prevBot;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("handleBot：slack status 未运行时正常退出 0", async () => {
  const home = tempHome("nyra-bot-cli12-");
  try {
    const prevApp = process.env.SLACK_APP_TOKEN;
    const prevBot = process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    const logs: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      const code = await handleBot(["slack", "status"], home);
      expect(code).toBe(0);
      const out = logs.join("");
      expect(out).toContain("Slack Bot");
      expect(out).toContain("未运行");
      expect(out).toContain("未配置");
    } finally {
      process.stdout.write = origOut;
      if (prevApp === undefined) delete process.env.SLACK_APP_TOKEN;
      else process.env.SLACK_APP_TOKEN = prevApp;
      if (prevBot === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = prevBot;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("handleBot：whatsapp 无凭证时 start 报错退出 1", async () => {
  const home = tempHome("nyra-bot-cli13-");
  try {
    const prevToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const prevPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    const logs: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const code = await handleBot(["whatsapp", "start"], home);
      expect(code).toBe(1);
      expect(logs.join("")).toContain("凭证");
    } finally {
      process.stderr.write = origErr;
      if (prevToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
      else process.env.WHATSAPP_ACCESS_TOKEN = prevToken;
      if (prevPhone === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
      else process.env.WHATSAPP_PHONE_NUMBER_ID = prevPhone;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("handleBot：whatsapp status 未运行时正常退出 0", async () => {
  const home = tempHome("nyra-bot-cli14-");
  try {
    const prevToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const prevPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    const logs: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      const code = await handleBot(["whatsapp", "status"], home);
      expect(code).toBe(0);
      const out = logs.join("");
      expect(out).toContain("WhatsApp Bot");
      expect(out).toContain("未运行");
      expect(out).toContain("未配置");
    } finally {
      process.stdout.write = origOut;
      if (prevToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
      else process.env.WHATSAPP_ACCESS_TOKEN = prevToken;
      if (prevPhone === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
      else process.env.WHATSAPP_PHONE_NUMBER_ID = prevPhone;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("handleBot approvals：list 列出一直批准的授权，revoke 撤销，用法错误退出 2", async () => {
  const home = tempHome("nyra-bot-cli-appr-");
  try {
    // 先用桥记一条 always 授权。
    const policy = botPolicyFromConfig({ bot: { owner: "1", admins: ["2"], approval_timeout_ms: 60000 } });
    const bridge = new ApprovalBridge({ home, policy, send: async () => "1", audit: () => {} });
    const item = await bridge.requestApproval({
      sessionKey: "telegram:7", chatId: "7", threadId: null, tool: "write_file", summary: "写文件 a.txt",
      argsHash: approvalArgsHash({ tool: "write_file", fileTarget: "a.txt" }),
      requestedBy: "1", requestedByRole: "owner",
    });
    await bridge.decide(item.id, true, "1", "command", "always");
    const grantId = bridge.listGrants()[0].id;
    const out: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out.push(s); return true; };
    try {
      expect(await handleBot(["approvals", "list"], home)).toBe(0);
      expect(out.join("")).toContain(grantId);
      out.length = 0;
      expect(await handleBot(["approvals", "revoke", grantId], home)).toBe(0);
      expect(out.join("")).toContain("已撤销");
      out.length = 0;
      expect(await handleBot(["approvals", "revoke", grantId], home)).toBe(1);
      expect(await handleBot(["approvals"], home)).toBe(2);
      expect(await handleBot(["approvals", "bogus"], home)).toBe(2);
    } finally {
      (process.stdout as unknown as { write: unknown }).write = origWrite;
    }
    // 撤销已落盘：新桥读盘后找不到它。
    const bridge2 = new ApprovalBridge({ home, policy, send: async () => "1", audit: () => {} });
    expect(bridge2.listGrants().length).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
