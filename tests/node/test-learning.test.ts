// tests/node/test-learning.test.ts — O5：记忆/学习的产品化。
// 全部用临时 home 与本地文件，不联网、不调真模型、不连真实 IdP。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../../src/gateway.ts";
import { AccountStore, AccountSessionStore } from "../../src/accounts.ts";
import { extractMemoryProposals, readMemoryProposals } from "../../src/memoryProposals.ts";
import { listMemoryGateEntries } from "../../src/memoryGate.ts";
import { draftSkillFromRun, findDraft } from "../../src/skillDrafts.ts";
import { RunStore } from "../../src/runs.ts";
import { createOrg } from "../../src/orgs.ts";
import {
  LEARNING_AUDIT_FILE,
  LearningError,
  approveLearning,
  getLearning,
  listLearning,
  proposeLearning,
  publishLearning,
  rejectLearning,
  removeLearning,
  scanLearning,
  shareLearning,
} from "../../src/learning.ts";
import { handleLearn } from "../../src/learningCli.ts";
import { readFileSync } from "node:fs";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const OWNER = "default";

function seedMemoryCandidate(home: string): string {
  const result = extractMemoryProposals(home, "sess-1", [
    { role: "user", content: "记住，我喜欢深色界面。" },
  ]);
  expect(result.added).toBe(1);
  return readMemoryProposals(home)[0]!.id;
}

function makeRun(home: string): { store: RunStore; runId: string } {
  const store = new RunStore(join(home, "runs"));
  const state = store.create("Fix login bug and write tests", "sess-test", home, "auto", 10, "running", "bun test");
  for (let i = 0; i < 4; i++) {
    store.appendEvent(state.run_id, "tool_start", { id: `c${i}`, name: "write_file", args_hash: `h${i}` });
    store.appendEvent(state.run_id, "tool_result", { id: `c${i}`, name: "write_file", ok: true, args_hash: `h${i}` });
  }
  store.appendEvent(state.run_id, "tool_start", { id: "c4", name: "shell", args_hash: "h4" });
  store.appendEvent(state.run_id, "tool_result", { id: "c4", name: "shell", ok: true, args_hash: "h4" });
  store.update(state.run_id, { changed_files: ["src/login.ts"] });
  store.setStatus(state.run_id, "verified");
  return { store, runId: state.run_id };
}

const AGENT_YAML = [
  "version: 1",
  "name: review",
  "description: 只读代码审查员",
  "instructions: 你是代码审查员，只做只读检查。",
  "tools:",
  "  - read_file",
  "  - list_dir",
  "model: deepseek-flash",
  "limits:",
  "  max_turns: 6",
  "  max_cost_usd: 0.5",
  "",
].join("\n");

// ---- 提案校验 ----

test("LearningTest.test_propose_validation", () => {
  const home = tmpHome("nyra-learn-");
  try {
    expect(() => proposeLearning(home, OWNER, {
      kind: "memory", title: "t", summary: "s", source: "src", ref: "memp_000000000000",
      payload: {},
    })).toThrow(/记忆提案须带 content/);
    expect(() => proposeLearning(home, OWNER, {
      kind: "agent", title: "t", summary: "s", source: "src", ref: "review", payload: {},
    })).toThrow(/agent 提案须带声明正文/);
    expect(() => proposeLearning(home, OWNER, {
      kind: "memory", title: "", summary: "s", source: "src", ref: "memp_000000000000",
      payload: { content: "足够长的正文内容" },
    })).toThrow(/标题不能为空/);
    expect(() => proposeLearning(home, OWNER, {
      kind: "memory", title: "t", summary: "s", source: "src", ref: "memp_000000000000",
      evidence: ["x".repeat(301)],
      payload: { content: "足够长的正文内容" },
    })).toThrow(/依据每条最多 300 字/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 扫描 ----

test("LearningTest.test_scan_collects_memory_and_skill_once", () => {
  const home = tmpHome("nyra-learn-");
  try {
    seedMemoryCandidate(home);
    const { store, runId } = makeRun(home);
    const { draft } = draftSkillFromRun(store, runId, { home, config: {} });
    expect(draft).not.toBeNull();
    const first = scanLearning(home, OWNER);
    expect(first.created).toHaveLength(2);
    expect(first.created.map((p) => p.kind).sort()).toEqual(["memory", "skill"]);
    expect(first.created.find((p) => p.kind === "memory")!.ref).toBe(readMemoryProposals(home)[0]!.id);
    expect(first.created.find((p) => p.kind === "skill")!.ref).toBe(draft!.name);
    // 再扫：已收过的不重复。
    const second = scanLearning(home, OWNER);
    expect(second.created).toHaveLength(0);
    expect(listLearning(home, OWNER)).toHaveLength(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 记忆：批准 + 发布全流程 ----

test("LearningTest.test_memory_approve_and_publish", () => {
  const home = tmpHome("nyra-learn-");
  try {
    seedMemoryCandidate(home);
    const [p] = scanLearning(home, OWNER).created;
    const approved = approveLearning(home, OWNER, p!.id);
    expect(approved.ok).toBe(true);
    expect(approved.proposal!.status).toBe("approved");
    // 没批准不能发布：另起一条待定的试。
    const pending = proposeLearning(home, OWNER, {
      kind: "memory", title: "另一条", summary: "摘要", source: "会话 x",
      evidence: ["我喜欢深色界面。"], ref: readMemoryProposals(home)[0]!.id,
      payload: { content: "我喜欢深色界面。", evidenceSource: "我喜欢深色界面。" },
    });
    expect(publishLearning(home, OWNER, pending.id).ok).toBe(false);
    const published = publishLearning(home, OWNER, p!.id);
    expect(published.ok).toBe(true);
    expect(published.proposal!.status).toBe("published");
    expect(published.proposal!.published_ref).toMatch(/^memg_/);
    // 结构化记忆库里真有这条。
    expect(listMemoryGateEntries(home).some((e) => e.id === published.proposal!.published_ref)).toBe(true);
    // 已发布不能再拒绝、不能再删。
    expect(rejectLearning(home, OWNER, p!.id).ok).toBe(false);
    expect(removeLearning(home, OWNER, p!.id).ok).toBe(false);
    // 审计里有 proposed/approved/published 三条（只记 id，不记正文）。
    const audit = readFileSync(join(home, LEARNING_AUDIT_FILE), "utf-8");
    expect(audit).toContain("learning_proposed");
    expect(audit).toContain("learning_approved");
    expect(audit).toContain("learning_published");
    expect(audit).not.toContain("深色界面");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("LearningTest.test_memory_approve_gate_blocks_bad_evidence", () => {
  const home = tmpHome("nyra-learn-");
  try {
    const p = proposeLearning(home, OWNER, {
      kind: "memory", title: "编造的记忆", summary: "摘要", source: "会话 x",
      evidence: ["用户从来没说过这句话。"], ref: "memp_000000000000",
      payload: { content: "用户从来没说过这句话。", evidenceSource: "完全不相干的另一段话。" },
    });
    const result = approveLearning(home, OWNER, p.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("quote-not-verbatim");
    expect(getLearning(home, OWNER, p.id)!.status).toBe("pending");
    expect(getLearning(home, OWNER, p.id)!.decision_reason).toContain("quote-not-verbatim");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 技能：批准 + 发布 ----

test("LearningTest.test_skill_approve_and_publish", () => {
  const home = tmpHome("nyra-learn-");
  try {
    const { store, runId } = makeRun(home);
    const { draft } = draftSkillFromRun(store, runId, { home, config: {} });
    const [p] = scanLearning(home, OWNER).created;
    expect(p!.kind).toBe("skill");
    expect(approveLearning(home, OWNER, p!.id).ok).toBe(true);
    const published = publishLearning(home, OWNER, p!.id);
    expect(published.ok).toBe(true);
    expect(published.proposal!.published_ref).toContain(`${draft!.name}.md`);
    expect(existsSync(join(home, "skills", `${draft!.name}.md`))).toBe(true);
    expect(findDraft(home, draft!.name)!.status).toBe("installed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- agent：批准 + 发布 ----

test("LearningTest.test_agent_approve_and_publish", () => {
  const home = tmpHome("nyra-learn-");
  try {
    const p = proposeLearning(home, OWNER, {
      kind: "agent", title: "只读代码审查员", summary: "帮手声明", source: "review.yaml",
      evidence: [], ref: "review", payload: { text: AGENT_YAML },
    });
    expect(approveLearning(home, OWNER, p.id).ok).toBe(true);
    const published = publishLearning(home, OWNER, p.id);
    expect(published.ok).toBe(true);
    expect(existsSync(join(home, ".nyra", "agents", "review.yaml"))).toBe(true);
    // 坏声明：批准就拦。
    const bad = proposeLearning(home, OWNER, {
      kind: "agent", title: "坏声明", summary: "摘要", source: "bad.yaml",
      evidence: [], ref: "bad", payload: { text: "version: 1\nname: Bad Name\ninstructions: x\n" },
    });
    const result = approveLearning(home, OWNER, bad.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("decl-invalid");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 分享与删除 ----

test("LearningTest.test_share_and_remove", () => {
  const home = tmpHome("nyra-learn-");
  try {
    const org = createOrg(home, "研发组", {});
    const p = proposeLearning(home, OWNER, {
      kind: "skill", title: "某技能", summary: "摘要", source: "运行 x",
      evidence: [], ref: "some-skill", payload: {},
    });
    // 没批准不能分享。
    expect(shareLearning(home, OWNER, p.id, org.id).ok).toBe(false);
    // 技能批准会因草稿不存在失败：改走拒绝路径测分享——先用记忆提案。
    seedMemoryCandidate(home);
    const [mem] = scanLearning(home, OWNER).created;
    expect(approveLearning(home, OWNER, mem!.id).ok).toBe(true);
    expect(shareLearning(home, OWNER, mem!.id, "没有这个组织").ok).toBe(false);
    const shared = shareLearning(home, OWNER, mem!.id, "研发组");
    expect(shared.ok).toBe(true);
    expect(shared.proposal!.shared_to).toEqual([org.id]);
    expect(shared.proposal!.status).toBe("approved"); // 分享不改状态
    expect(listLearning(home, OWNER, { shared: true })).toHaveLength(1);
    // 待定的能删，已批准的不能删。
    expect(removeLearning(home, OWNER, p.id).ok).toBe(true);
    expect(getLearning(home, OWNER, p.id)).toBe(null);
    expect(removeLearning(home, OWNER, mem!.id).ok).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- CLI ----

test("LearningTest.test_cli_list_scan_approve_reject", async () => {
  const home = tmpHome("nyra-learn-");
  try {
    expect(await handleLearn(["list", "--owner", "default"], home)).toBe(0);
    seedMemoryCandidate(home);
    expect(await handleLearn(["scan", "--owner", "default"], home)).toBe(0);
    const [p] = listLearning(home, OWNER);
    expect(await handleLearn(["show", p!.id, "--owner", "default"], home)).toBe(0);
    expect(await handleLearn(["approve", p!.id, "--owner", "default"], home)).toBe(0);
    expect(await handleLearn(["publish", p!.id, "--owner", "default"], home)).toBe(2); // 须 --yes
    expect(await handleLearn(["publish", p!.id, "--yes", "--owner", "default"], home)).toBe(0);
    expect(getLearning(home, OWNER, p!.id)!.status).toBe("published");
    expect(await handleLearn(["approve", "lrn_000000000000", "--owner", "default"], home)).toBe(1);
    expect(await handleLearn(["propose", "memory", "--owner", "default"], home)).toBe(2);
    expect(await handleLearn(["nonsense", "--owner", "default"], home)).toBe(2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 网关只读面 ----

test("LearningTest.test_gateway_api_learning", async () => {
  const home = tmpHome("nyra-learn-");
  const workdir = tmpHome("nyra-learn-wd-");
  try {
    seedMemoryCandidate(home);
    scanLearning(home, OWNER);
    const directory = new AccountStore(home);
    const account = await directory.create({ email: "owner@example.com", name: "机主" });
    const session = await new AccountSessionStore(home).issue(account.id);
    const gw = new Gateway({
      home, workdir, host: "127.0.0.1", port: 0, mode: "full",
      config: { mcp_enabled: false, fallback_enabled: false },
    });
    const info = await gw.start();
    try {
      const base = `http://127.0.0.1:${info.port}`;
      const noToken = await fetch(`${base}/api/learning`);
      expect(noToken.status).toBe(403);
      const res = await fetch(`${base}/api/learning`, { headers: { "X-Nyra-Token": session.token } });
      expect(res.status).toBe(200);
      const body = await res.json() as { owner: string; proposals: { id: string; kind: string; status: string }[] };
      expect(body.owner).toBe("default");
      expect(body.proposals).toHaveLength(1);
      expect(body.proposals[0]!.kind).toBe("memory");
      const filtered = await fetch(`${base}/api/learning?status=approved`, { headers: { "X-Nyra-Token": session.token } });
      const filteredBody = await filtered.json() as { proposals: unknown[] };
      expect(filteredBody.proposals).toHaveLength(0);
    } finally {
      await gw.stop();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});
