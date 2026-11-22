// tests/node/test-cli-batch3.test.ts — 第 3 批 CLI 冒烟：sfu video /
// meeting / rendezvous / queue / peer discover 与 card 签名命令在全新
// home 上能跑完。用子进程跑真 CLI（`bun src/cli.ts …`），不调模型；
// 发现用本机 Bun.serve 假 peer，不联网。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../../src/vault.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(argv: string[], home: string, workdir: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, ...argv, "--workdir", workdir],
    env: {
      ...process.env,
      NYRA_HOME: home,
      NYRA_CONFIG: join(home, "config.json"),
      NYRA_LAZY_TOOLS: "0",
      ...extraEnv,
    },
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

function fresh(): { home: string; workdir: string } {
  return {
    home: mkdtempSync(join(tmpdir(), "nyra-b3cli-home-")),
    workdir: mkdtempSync(join(tmpdir(), "nyra-b3cli-wd-")),
  };
}

test("CliBatch3.test_sfu_video_commands", async () => {
  const { home, workdir } = fresh();
  try {
    expect((await runCli(["sfu", "create", "room-1"], home, workdir)).code).toBe(0);
    for (const p of ["alice", "bob", "carol"]) {
      const j = await runCli(["sfu", "join", "room-1", p], home, workdir);
      expect(j.code).toBe(0);
    }
    const start = await runCli(["sfu", "video", "start", "room-1", "alice"], home, workdir);
    expect(start.code).toBe(0);
    expect(start.stdout).toContain("已在房间 room-1 开视频");
    const sub = await runCli(["sfu", "video", "subscribe", "room-1", "bob", "alice", "--kbps", "2000"], home, workdir);
    expect(sub.code).toBe(0);
    expect(sub.stdout).toContain("high");
    const pub = await runCli(["sfu", "video", "publish", "room-1", "alice", "frame-bytes-1"], home, workdir);
    expect(pub.code).toBe(0);
    expect(pub.stdout).toContain("#1");
    const frames = await runCli(["sfu", "video", "frames", "room-1", "bob", "alice"], home, workdir);
    expect(frames.code).toBe(0);
    expect(frames.stdout).toContain("#1");
    const list = await runCli(["sfu", "video", "list", "room-1"], home, workdir);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("alice");
    // 听众开视频直接拒绝
    await runCli(["sfu", "join", "room-1", "dave", "--role", "listener"], home, workdir);
    const bad = await runCli(["sfu", "video", "start", "room-1", "dave"], home, workdir);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("只能看视频");
    // 10 分钟模拟（fps=1，虚拟 600 秒）
    const sim = await runCli(["sfu", "video", "simulate", "room-1", "alice", "bob", "carol", "--seconds", "600", "--fps", "1"], home, workdir);
    expect(sim.code).toBe(0);
    expect(sim.stdout).toContain("模拟 600 秒");
    expect(sim.stdout).toContain("还开着");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("CliBatch3.test_meeting_commands_no_browser", async () => {
  const { home, workdir } = fresh();
  try {
    const bad = await runCli(["meeting", "create", "https://teams.microsoft.com/l/meetup"], home, workdir);
    expect(bad.code).toBe(1);
    const created = await runCli(["meeting", "create", "https://meet.google.com/abc-defg-hij"], home, workdir);
    expect(created.code).toBe(0);
    const id = created.stdout.match(/会议已建：([^\s（]+)/)?.[1];
    expect(id).toBeTruthy();
    // 没批不进会
    const noYes = await runCli(["meeting", "join", id!, "--listen", "0"], home, workdir);
    expect(noYes.code).toBe(2);
    const added = await runCli(["meeting", "transcript", "add", id!, "alice", "待办：发纪要给小明"], home, workdir);
    expect(added.code).toBe(0);
    const minutes = await runCli(["meeting", "minutes", id!], home, workdir);
    expect(minutes.code).toBe(0);
    expect(minutes.stdout).toContain("待办：发纪要给小明");
    // 派发进队列：第一次派上，第二次跳过
    const d1 = await runCli(["meeting", "dispatch", id!, "发纪要给小明", "--yes"], home, workdir);
    expect(d1.code).toBe(0);
    expect(d1.stdout).toContain("已派发进任务队列");
    const d2 = await runCli(["meeting", "dispatch", id!, "发纪要给小明", "--yes"], home, workdir);
    expect(d2.code).toBe(0);
    expect(d2.stdout).toContain("没派发");
    const list = await runCli(["meeting", "list"], home, workdir);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(id!);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("CliBatch3.test_rendezvous_and_queue_commands", async () => {
  const { home, workdir } = fresh();
  try {
    const noNode = await runCli(["rendezvous", "route", "task-1"], home, workdir);
    expect(noNode.code).toBe(1);
    expect(noNode.stderr).toContain("没有 active 节点");
    const pub = await runCli(["rendezvous", "register", "node-a", "https://example.com"], home, workdir);
    expect(pub.code).toBe(1);
    expect(pub.stderr).toContain("只登记本机");
    expect((await runCli(["rendezvous", "register", "node-a", "http://127.0.0.1:18001"], home, workdir)).code).toBe(0);
    expect((await runCli(["rendezvous", "register", "node-b", "http://127.0.0.1:18002"], home, workdir)).code).toBe(0);
    const route = await runCli(["rendezvous", "route", "task-1"], home, workdir);
    expect(route.code).toBe(0);
    expect(route.stdout).toMatch(/路由到节点 node-[ab]/);
    const epoch = await runCli(["rendezvous", "epoch"], home, workdir);
    expect(epoch.code).toBe(0);
    expect(epoch.stdout).toContain("3");
    // 队列：入队 → 认领 → 完成（租约令牌从认领输出里取）
    const enq = await runCli(["queue", "enqueue", "task-1", "do the thing"], home, workdir);
    expect(enq.code).toBe(0);
    const taskId = enq.stdout.match(/任务已入队：([^\s（]+)/)?.[1];
    expect(taskId).toBeTruthy();
    const enq2 = await runCli(["queue", "enqueue", "task-1", "do the thing"], home, workdir);
    expect(enq2.stdout).toContain(taskId!); // 幂等：重复提交回同一条
    const claim = await runCli(["queue", "claim", taskId!], home, workdir);
    expect(claim.code).toBe(0);
    const node = claim.stdout.match(/节点 ([^\s，]+)/)?.[1];
    const token = claim.stdout.match(/租约令牌（只显示这一次，完成\/标失败时凭它认领）：(\S+)/)?.[1];
    expect(node).toBeTruthy();
    expect(token).toBeTruthy();
    const done = await runCli(["queue", "complete", taskId!, "--node", node!, "--token", token!], home, workdir);
    expect(done.code).toBe(0);
    expect(done.stdout).toContain("已完成");
    const show = await runCli(["queue", "show", taskId!], home, workdir);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("completed");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("CliBatch3.test_peer_discover_fake_peer_and_card_signing", async () => {
  const { home, workdir } = fresh();
  // 假 peer：本机 Bun.serve，只回一张素名片
  const card = {
    name: "FakeBot",
    description: "fake peer agent",
    url: "http://127.0.0.1:0",
    version: "0.5.6",
    skills: [],
    authentication: { schemes: ["bearer"] },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    endpoints: { mcp: null },
  };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/agent-card.json") {
        return new Response(JSON.stringify(card), { headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const disc = await runCli(["peer", "discover", origin], home, workdir);
    expect(disc.code).toBe(0);
    expect(disc.stdout).toContain("已发现 FakeBot");
    expect(disc.stdout).toContain("名片签名：无");
    const list = await runCli(["peer", "discover", "list"], home, workdir);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("FakeBot");
    // --as 发好友请求须先开对端协作
    const enable = await runCli(["peer", "enable"], home, workdir);
    expect(enable.code).toBe(0);
    const add = await runCli(["peer", "discover", origin, "--as", "pilot"], home, workdir);
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("好友请求已发给 pilot");
    // 名片签名：密码箱进程内初始化（`nyra vault init` 严格拒绝额外参数，
    // runCli 统一追加的 --workdir 会被它当成额外参数，CLI 路径本身没问题）
    new Vault(join(home, "vault.json")).init("pw123456");
    const keygen = await runCli(["peer", "card", "keygen"], home, workdir, { NYRA_VAULT_PASSWORD: "pw123456" });
    expect(keygen.code).toBe(0);
    expect(keygen.stdout).toContain("签名钥匙已生成");
    const signOn = await runCli(["peer", "card", "sign", "on"], home, workdir, { NYRA_VAULT_PASSWORD: "pw123456" });
    expect(signOn.code).toBe(0);
    const show = await runCli(["peer", "card"], home, workdir, { NYRA_VAULT_PASSWORD: "pw123456" });
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("signature");
    expect(show.stdout).toContain("public_key");
    const tokenList = await runCli(["peer", "token", "list"], home, workdir, { NYRA_VAULT_PASSWORD: "pw123456" });
    expect(tokenList.code).toBe(0);
    expect(tokenList.stdout).toContain("还没存过出站 token");
  } finally {
    server.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});
