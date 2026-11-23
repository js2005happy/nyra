// tests/node/test-memory-gate.test.ts — Kooyu 记忆证据门（防记忆污染）。
// 证据逐字校验、秘密拦截、结构化条目 + 修订历史、拒绝留痕、CLI。
// 只在临时 home 上跑，不碰真记忆。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  verifyEvidenceQuotes, detectSecretKind, rememberMemoryEntry, updateMemoryEntry,
  listMemoryGateEntries, getMemoryGateEntry, recordGateRejection, listGateRejections,
  MemoryGateError, MEMORY_GATE_ENTRIES_FILE, MEMORY_GATE_REJECTIONS_FILE,
} from "../../src/memoryGate.ts";
import { handleMemoryGate } from "../../src/memoryGateCli.ts";

const USER_TEXT = "请记住，我是铜陵职业技术学院工业机器人技术专业的学生，指导老师是梅小龙";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function captureOutput(): { out: string; err: string; restore: () => void } {
  let out = "";
  let err = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => { err += s; return true; };
  return { get out() { return out; }, get err() { return err; }, restore: () => { (process.stdout as unknown as { write: unknown }).write = origOut; (process.stderr as unknown as { write: unknown }).write = origErr; } };
}

// ---- 证据校验 -----------------------------------------------------------

test("证据校验：逐字原话通过，转述/缺依据/超量/过短都拒绝", () => {
  expect(verifyEvidenceQuotes(USER_TEXT, ["铜陵职业技术学院", "指导老师是梅小龙"]).ok).toBe(true);
  // 转述（不是逐字原话）拒绝。
  const paraphrase = verifyEvidenceQuotes(USER_TEXT, ["我是铜陵职院的学生"]);
  expect(paraphrase.ok).toBe(false);
  if (!paraphrase.ok) expect(paraphrase.reason).toMatch(/^quote-not-verbatim/);
  // 缺依据拒绝。
  expect(verifyEvidenceQuotes(USER_TEXT, []).ok).toBe(false);
  expect(verifyEvidenceQuotes(USER_TEXT, undefined).ok).toBe(false);
  // 没有当前用户回合拒绝。
  expect(verifyEvidenceQuotes(null, ["铜陵职业技术学院"]).ok).toBe(false);
  expect(verifyEvidenceQuotes("  ", ["铜陵职业技术学院"]).ok).toBe(false);
  // 9 条引用拒绝（上限 8 条）。
  expect(verifyEvidenceQuotes(USER_TEXT, Array(9).fill("铜陵职业技术学院")).ok).toBe(false);
  // 1 个字的引用拒绝（太容易误命中）。
  expect(verifyEvidenceQuotes(USER_TEXT, ["我"]).ok).toBe(false);
  // 500 字以上的引用拒绝。
  expect(verifyEvidenceQuotes(USER_TEXT, ["铜".repeat(501)]).ok).toBe(false);
});

test("秘密拦截：sk- / 私钥 / Bearer 命中种类，干净文本放行", () => {
  expect(detectSecretKind("key 是 sk-abcdefgh12345678")).toBe("sk-key");
  expect(detectSecretKind("-----BEGIN RSA PRIVATE KEY-----")).toBe("private-key");
  expect(detectSecretKind("Authorization: Bearer abcdefgh12345678")).toBe("bearer-token");
  expect(detectSecretKind("指导老师是梅小龙")).toBeNull();
  expect(detectSecretKind("")).toBeNull();
});

// ---- 结构化条目 + 修订历史 ----------------------------------------------

test("结构化条目：记住、改版、查历史、删后终态", () => {
  const home = tmpHome("nyra-memgate-");
  try {
    const entry = rememberMemoryEntry(home, {
      scope: "user", subject: "学籍", content: "铜陵职业技术学院工业机器人技术专业，指导老师梅小龙",
      sourceRefs: ["MEMORY.md"], status: "confirmed", evidenceQuotes: ["铜陵职业技术学院", "指导老师是梅小龙"],
    }, USER_TEXT, { actor: "cli" });
    expect(entry.id.startsWith("memg_")).toBe(true);
    expect(entry.revision).toBe(1);
    expect(entry.status).toBe("confirmed");
    expect(entry.evidenceQuotes).toEqual(["铜陵职业技术学院", "指导老师是梅小龙"]);
    // 账本 0600。
    expectPerms(join(home, MEMORY_GATE_ENTRIES_FILE), 0o600);
    // 改一版：revision+1，上一版正文记进历史。
    const updated = updateMemoryEntry(home, entry.id, {
      content: "铜陵职业技术学院工业机器人技术专业，指导老师梅小龙，2025 年 9 月入学",
      evidenceQuotes: ["铜陵职业技术学院"],
    }, USER_TEXT, { actor: "cli" });
    expect(updated.revision).toBe(2);
    expect(updated.content).toContain("2025 年 9 月入学");
    const found = getMemoryGateEntry(home, entry.id)!;
    expect(found.history.length).toBe(2);
    expect(found.history[0].prevContent).toBeNull();
    expect(found.history[1].prevContent).toBe("铜陵职业技术学院工业机器人技术专业，指导老师梅小龙");
    expect(found.history[1].evidenceQuotes).toEqual(["铜陵职业技术学院"]);
    // 删掉：列表默认不再出现；删了的是终态，再改拒绝。
    const deleted = updateMemoryEntry(home, entry.id, {
      status: "deleted", evidenceQuotes: ["指导老师是梅小龙"],
    }, USER_TEXT, { actor: "cli" });
    expect(deleted.status).toBe("deleted");
    expect(listMemoryGateEntries(home).length).toBe(0);
    expect(listMemoryGateEntries(home, { includeDeleted: true }).length).toBe(1);
    expect(() => updateMemoryEntry(home, entry.id, { content: "再改", evidenceQuotes: ["铜陵职业技术学院"] }, USER_TEXT)).toThrow("终态");
  } finally {
    cleanup(home);
  }
});

test("结构化条目：字段校验——project 缺 projectId、非法 status、超长正文都拒绝", () => {
  const home = tmpHome("nyra-memgate-");
  try {
    const base = {
      scope: "user" as const, subject: "学籍", content: "铜陵职业技术学院",
      evidenceQuotes: ["铜陵职业技术学院"],
    };
    expect(() => rememberMemoryEntry(home, { ...base, scope: "project" }, USER_TEXT)).toThrow("projectId");
    expect(() => rememberMemoryEntry(home, { ...base, status: "deleted" as never }, USER_TEXT)).toThrow("status");
    expect(() => rememberMemoryEntry(home, { ...base, content: "x".repeat(2001) }, USER_TEXT)).toThrow("最多");
    expect(() => rememberMemoryEntry(home, { ...base, subject: "" }, USER_TEXT)).toThrow("subject");
    // 正文含密钥拒绝，且拒绝记录里不出现密钥原文。
    expect(() => rememberMemoryEntry(home, { ...base, content: "密钥 sk-abcdefgh12345678 别外传" }, USER_TEXT)).toThrow("密钥");
  } finally {
    cleanup(home);
  }
});

test("结构化条目：坏行跳过、查不到返回 null、scope 过滤", () => {
  const home = tmpHome("nyra-memgate-");
  try {
    const a = rememberMemoryEntry(home, {
      scope: "user", subject: "学籍", content: "铜陵职业技术学院",
      evidenceQuotes: ["铜陵职业技术学院"],
    }, USER_TEXT);
    rememberMemoryEntry(home, {
      scope: "project", projectId: "nyra", subject: "项目偏好", content: "中文优先",
      evidenceQuotes: ["铜陵职业技术学院"],
    }, USER_TEXT);
    // 账本里塞坏行，读取不受影响。
    appendFileSync(join(home, MEMORY_GATE_ENTRIES_FILE), "这行不是 JSON\n{\"id\": 1}\n");
    expect(listMemoryGateEntries(home).length).toBe(2);
    expect(listMemoryGateEntries(home, { scope: "project" }).length).toBe(1);
    expect(listMemoryGateEntries(home, { scope: "project" })[0].projectId).toBe("nyra");
    expect(getMemoryGateEntry(home, "memg_000000000000")).toBeNull();
    expect(getMemoryGateEntry(home, a.id)?.entry.subject).toBe("学籍");
  } finally {
    cleanup(home);
  }
});

// ---- 拒绝留痕 ------------------------------------------------------------

test("拒绝留痕：记一条、新的在前、账本 0600", () => {
  const home = tmpHome("nyra-memgate-");
  try {
    expect(listGateRejections(home)).toEqual([]);
    recordGateRejection(home, { action: "memory_append", reason: "no-evidence", detail: "缺依据", subject: "学籍", scope: "user" });
    recordGateRejection(home, { action: "remember", reason: "secret:sk-key", detail: "含疑似密钥", subject: null, scope: null });
    const rows = listGateRejections(home, 10);
    expect(rows.length).toBe(2);
    expect(rows[0].reason).toBe("secret:sk-key");
    expect(existsSync(join(home, MEMORY_GATE_REJECTIONS_FILE))).toBe(true);
    expectPerms(join(home, MEMORY_GATE_REJECTIONS_FILE), 0o600);
  } finally {
    cleanup(home);
  }
});

// ---- CLI -----------------------------------------------------------------

test("CLI：remember/entries/entry/update/rejections 走通，缺引用拒绝并留痕", async () => {
  const home = tmpHome("nyra-memgate-");
  try {
    const cap = captureOutput();
    try {
      const rc1 = await handleMemoryGate([
        "remember", "铜陵职业技术学院工业机器人技术专业", "--quote", "铜陵职业技术学院",
        "--subject", "学籍", "--status", "confirmed",
      ], home);
      expect(rc1).toBe(0);
      expect(cap.out).toContain("已记入结构化记忆");
      const id = (cap.out.match(/\[memg_[0-9a-f]{12}\]/)?.[0] ?? "").slice(1, -1);
      expect(id.startsWith("memg_")).toBe(true);

      const rc2 = await handleMemoryGate(["entries"], home);
      expect(rc2).toBe(0);
      expect(cap.out).toContain("学籍");

      const rc3 = await handleMemoryGate(["entry", id], home);
      expect(rc3).toBe(0);
      expect(cap.out).toContain("铜陵职业技术学院工业机器人技术专业");

      const rc4 = await handleMemoryGate(["update", id, "--content", "铜陵职业技术学院，2025 年 9 月入学", "--quote", "铜陵职业技术学院"], home);
      expect(rc4).toBe(0);
      expect(cap.out).toContain("第 2 版");

      // 缺引用：拒绝，exit 1，拒绝账本里留一条。
      const rc5 = await handleMemoryGate(["remember", "没有依据的内容", "--subject", "测试"], home);
      expect(rc5).toBe(1);
      expect(cap.err).toContain("写不进去");
      expect(listGateRejections(home, 10).length).toBe(1);

      const rc6 = await handleMemoryGate(["rejections"], home);
      expect(rc6).toBe(0);
      expect(cap.out).toContain("no-evidence");
    } finally {
      cap.restore();
    }
  } finally {
    cleanup(home);
  }
});
