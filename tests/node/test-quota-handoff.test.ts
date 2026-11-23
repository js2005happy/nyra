// tests/node/test-quota-handoff.test.ts — Kooyu 429 接力（限流识别 + 接力摘要 +
// 接力记录），升级备用模型切换通知。半自动到此为止：只生成摘要 + 记录 +
// 通知引用，不自动开新会话续跑、不自动重试已失败的调用。
// 假 provider / 临时 home 上验证（真 API 未跑通，见 CHANGELOG 诚实边界）。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderError, FallbackProvider, KeyRotatingProvider,
  classifyHttpError, type ChatMessage, type ProviderLike,
} from "../../src/providers.ts";
import {
  isRateLimitErrorText, isQuotaErrorText, buildQuotaHandoff,
  recordQuotaHandoff, readQuotaHandoffs, getQuotaHandoff,
  summarizeQuotaHandoffs, QUOTA_HANDOFF_FILE, scrubHandoffText,
  type QuotaHandoff,
} from "../../src/quotaHandoff.ts";
import {
  recordModelSwitch, readModelSwitchAudit, formatModelSwitchNotice,
  type ModelSwitchAuditEntry,
} from "../../src/modelSwitch.ts";
import { handleModels } from "../../src/modelsCli.ts";

function tmpRoot(prefix: string): string {
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

/** 指定次数失败、之后回固定文本的假 provider（failTimes 很大 = 一直失败）。 */
function failProvider(name: string, failTimes: number, err: ProviderError): ProviderLike & { calls: number } {
  let calls = 0;
  const provider = {
    name,
    model: `${name}-model`,
    baseUrl: `https://${name}.example.com/v1`,
    calls: 0,
    hasCredentials: () => true,
    async chat(): Promise<Record<string, unknown>> {
      calls += 1;
      provider.calls = calls;
      if (calls <= failTimes) throw err;
      return { choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    },
    async listModels(): Promise<string[]> { return [provider.model]; },
    redact: (t: string) => t,
  };
  return provider;
}

const MSGS: ChatMessage[] = [
  { role: "user", content: "帮我把登录页的按钮改成深紫色" },
  {
    role: "assistant",
    content: "已改好按钮颜色，正在改 hover 态。",
    tool_calls: [
      { id: "1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/login.ts", content: "x" }) } },
      { id: "2", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/login.ts", content: "x" }) } },
      { id: "3", type: "function", function: { name: "edit_file", arguments: JSON.stringify({ path: "src/theme.css", old: "a", new: "b" }) } },
    ],
  },
  { role: "user", content: "再把 hover 态也改一下" },
];

// ---- 限流识别 -----------------------------------------------------------

test("限流识别：Kooyu 正则的中英文写法都认", () => {
  for (const text of [
    "HTTP 429 Too Many Requests",
    "rate limit exceeded, please retry later",
    "quota exceeded for this month",
    "usage limit reached",
    "capacity exhausted, try again",
    "The model is overloaded",
    "insufficient_quota: you exceeded your current quota",
    "credit balance is not enough",
    "请求过于频繁，请稍后再试",
    "触发限流，请等一分钟",
    "配额不足，请充值",
    "额度耗尽了",
  ]) {
    expect(isRateLimitErrorText(text)).toBe(true);
  }
});

test("限流识别：非限流报错不认", () => {
  for (const text of [
    "Internal server error",
    "401 Unauthorized: invalid API key",
    "model not found: gpt-99",
    "connection reset by peer",
    "",
  ]) {
    expect(isRateLimitErrorText(text)).toBe(false);
  }
});

test("配额识别：只认用量没了的子集，单纯限流不算配额", () => {
  expect(isQuotaErrorText("quota exceeded")).toBe(true);
  expect(isQuotaErrorText("insufficient_quota")).toBe(true);
  expect(isQuotaErrorText("credit balance is not enough")).toBe(true);
  expect(isQuotaErrorText("配额不足")).toBe(true);
  expect(isQuotaErrorText("too many requests")).toBe(false);
  expect(isQuotaErrorText("rate limit exceeded")).toBe(false);
  expect(isQuotaErrorText("capacity exhausted")).toBe(false);
  expect(isQuotaErrorText("Internal server error")).toBe(false);
});

test("错误分类：状态码不是 429、但文案明说限流时也认成 rate_limit", () => {
  expect(classifyHttpError(503, "capacity exhausted")).toBe("rate_limit");
  expect(classifyHttpError(500, "The model is overloaded")).toBe("rate_limit");
  expect(classifyHttpError(500, "触发限流")).toBe("rate_limit");
  // 配额文案优先于限流：429 + 配额文案仍是 quota（终结，不重试同一家）。
  expect(classifyHttpError(429, "quota exceeded")).toBe("quota");
  expect(classifyHttpError(429, "配额不足")).toBe("quota");
  // 其余口径不动：429  plain 是 rate_limit，500 plain 是 server，402 是 quota。
  expect(classifyHttpError(429, "Too Many Requests")).toBe("rate_limit");
  expect(classifyHttpError(500, "Internal server error")).toBe("server");
  expect(classifyHttpError(402, "Payment Required")).toBe("quota");
});

// ---- 接力摘要 -----------------------------------------------------------

test("接力摘要：限流触发才配，非限流不配", () => {
  const h = buildQuotaHandoff({
    from: "deepseek", to: "xai", error: "请求过于频繁 (HTTP 429)",
    trigger: "rate_limit", messages: MSGS, runId: "run_1",
    at: new Date("2026-11-23T13:40:00+08:00"), id: "qh_test000001",
  });
  expect(h).not.toBeNull();
  expect(h!.id).toBe("qh_test000001");
  expect(h!.from).toBe("deepseek");
  expect(h!.to).toBe("xai");
  expect(h!.run_id).toBe("run_1");
  expect(h!.lastRequest).toBe("再把 hover 态也改一下");
  expect(h!.lastReply).toBe("已改好按钮颜色，正在改 hover 态。");
  // 已做修改去重：同一文件写两次只记一次。
  expect(h!.changes).toEqual(["write_file src/login.ts", "edit_file src/theme.css"]);
  expect(h!.summary).toContain("限流接力摘要（deepseek → xai");
  expect(h!.summary).toContain("最近任务：再把 hover 态也改一下");
  expect(h!.summary).toContain("最近进展：已改好按钮颜色，正在改 hover 态。");
  expect(h!.summary).toContain("- write_file src/login.ts");
  expect(h!.summary).toContain("勿重复已完成修改");
  expect(h!.summary).toContain("不要重发已失败的调用");

  expect(buildQuotaHandoff({
    from: "deepseek", to: "xai", error: "Internal server error",
    trigger: "server", messages: MSGS,
  })).toBeNull();
  expect(buildQuotaHandoff({
    from: "deepseek", to: "xai", error: "timeout",
    trigger: "timeout", messages: MSGS,
  })).toBeNull();
});

test("接力摘要：没有工具写操作时明说没有，不编修改清单", () => {
  const h = buildQuotaHandoff({
    from: "deepseek", to: "xai", error: "429", trigger: "rate_limit",
    messages: [{ role: "user", content: "讲个笑话" }],
  });
  expect(h).not.toBeNull();
  expect(h!.changes).toEqual([]);
  expect(h!.summary).toContain("（本次对话里没有工具写操作）");
  expect(h!.lastRequest).toBe("讲个笑话");
  expect(h!.lastReply).toBe("");
});

test("接力摘要脱敏：密钥样字符串与 home 目录不进摘要", () => {
  const home = tmpRoot("nyra-handoff-scrub-");
  try {
    const dirty = `open ${home}/config.json failed: key sk-test1234567890abcdef and token ${"y".repeat(40)}`;
    const h = buildQuotaHandoff({
      from: "deepseek", to: "xai", error: dirty, trigger: "quota",
      messages: [{ role: "user", content: dirty }],
      home, id: "qh_scrub000001",
    });
    expect(h).not.toBeNull();
    expect(h!.error).not.toContain(home);
    expect(h!.error).toContain("[home]");
    expect(h!.error).not.toContain("sk-test1234567890abcdef");
    expect(h!.error).not.toContain("y".repeat(40));
    expect(h!.error).toContain("<redacted>");
    expect(h!.lastRequest).not.toContain("sk-test1234567890abcdef");
    expect(h!.summary).not.toContain("y".repeat(40));
  } finally {
    cleanup(home);
  }
});

test("接力摘要截断：超长任务与回复各截到 500 字", () => {
  const long = "任".repeat(600);
  const h = buildQuotaHandoff({
    from: "deepseek", to: "xai", error: "429", trigger: "rate_limit",
    messages: [
      { role: "user", content: long },
      { role: "assistant", content: long },
    ],
    id: "qh_trunc00001",
  });
  expect(h).not.toBeNull();
  expect(h!.lastRequest.length).toBeLessThanOrEqual(500);
  expect(h!.lastRequest.endsWith("…")).toBe(true);
  expect(h!.lastReply.length).toBeLessThanOrEqual(500);
});

// ---- 接力记录落盘 -------------------------------------------------------

test("接力记录：存取往返、坏行跳过、同 id 不重复追加", () => {
  const home = tmpRoot("nyra-handoff-store-");
  try {
    expect(readQuotaHandoffs(home)).toEqual([]);
    const h = buildQuotaHandoff({
      from: "deepseek", to: "xai", error: "429", trigger: "rate_limit",
      messages: MSGS, at: new Date(), id: "qh_store00001",
    })!;
    expect(recordQuotaHandoff(home, h)).not.toBeNull();
    expect(existsSync(join(home, QUOTA_HANDOFF_FILE))).toBe(true);
    expect((statSync(join(home, QUOTA_HANDOFF_FILE)).mode & 0o777)).toBe(0o600);
    expect(readQuotaHandoffs(home).map((x) => x.id)).toEqual(["qh_store00001"]);
    expect(getQuotaHandoff(home, "qh_store00001")?.to).toBe("xai");
    expect(getQuotaHandoff(home, "qh_nope")).toBeNull();
    // 同 id 再存一次不重复追加。
    expect(recordQuotaHandoff(home, h)).not.toBeNull();
    expect(readQuotaHandoffs(home).length).toBe(1);
    // 坏行跳过，不拖垮读取。
    appendFileSync(join(home, QUOTA_HANDOFF_FILE), "这行不是 JSON\n{\"id\": 1}\n");
    expect(readQuotaHandoffs(home).length).toBe(1);
    // 本月聚合：当月 1 次。
    const s = summarizeQuotaHandoffs(home);
    expect(s.count).toBe(1);
    expect(s.last?.id).toBe("qh_store00001");
  } finally {
    cleanup(home);
  }
});

// ---- 切换时配接力 -------------------------------------------------------

test("兜底切换：429 限流切走时配接力摘要，500 服务端错误切换时不配", async () => {
  const rateErr = new ProviderError("请求过于频繁 (HTTP 429)：请稍后再试", { status: 429, kind: "rate_limit" });
  const serverErr = new ProviderError("Internal server error", { status: 500, kind: "server" });
  const seen: { from: string; to: string; trigger: string; hasHandoff: boolean }[] = [];
  const fb = new FallbackProvider(
    [failProvider("deepseek", 99, rateErr), failProvider("xai", 0, rateErr)],
    (r) => { seen.push({ from: r.from, to: r.to, trigger: r.trigger, hasHandoff: !!r.handoff }); },
    { retryDelaysMs: [0, 0], sleep: async () => {} },
  );
  await fb.chat([{ role: "user", content: "把按钮改紫" }]);
  expect(seen.length).toBe(1);
  expect(seen[0]).toEqual({ from: "deepseek", to: "xai", trigger: "rate_limit", hasHandoff: true });
  expect(fb.switches[0]!.handoff?.from).toBe("deepseek");
  expect(fb.switches[0]!.handoff?.to).toBe("xai");
  expect(fb.switches[0]!.handoff?.lastRequest).toBe("把按钮改紫");
  expect(fb.switches[0]!.handoff?.summary).toContain("勿重复已完成修改");

  const seen2: { trigger: string; hasHandoff: boolean }[] = [];
  const fb2 = new FallbackProvider(
    [failProvider("deepseek", 99, serverErr), failProvider("xai", 0, serverErr)],
    (r) => { seen2.push({ trigger: r.trigger, hasHandoff: !!r.handoff }); },
    { retryDelaysMs: [0, 0], sleep: async () => {} },
  );
  await fb2.chat([{ role: "user", content: "把按钮改紫" }]);
  expect(seen2).toEqual([{ trigger: "server", hasHandoff: false }]);
  expect(fb2.switches[0]!.handoff).toBeUndefined();
});

test("Key 轮换：429 限流换 Key 时同样配接力摘要", async () => {
  const rateErr = new ProviderError("Too Many Requests", { status: 429, kind: "rate_limit" });
  const seen: { hasHandoff: boolean; from: string; to: string }[] = [];
  const kr = new KeyRotatingProvider(
    [failProvider("deepseek", 99, rateErr), failProvider("deepseek", 0, rateErr)],
    (r) => { seen.push({ hasHandoff: !!r.handoff, from: r.from, to: r.to }); },
    { retryDelaysMs: [0, 0], sleep: async () => {} },
  );
  await kr.chat([{ role: "user", content: "继续" }]);
  expect(seen.length).toBe(1);
  expect(seen[0]!.hasHandoff).toBe(true);
  expect(kr.switches[0]!.handoff?.trigger).toBe("rate_limit");
});

// ---- 通知引用 + 审计 ---------------------------------------------------

test("切换通知：有接力摘要时引用 id，没摘要时原样不动", () => {
  const withHandoff = buildQuotaHandoff({
    from: "deepseek", to: "xai", error: "429", trigger: "rate_limit",
    messages: MSGS, id: "qh_notice0001",
  })!;
  const notice = formatModelSwitchNotice({
    from: "deepseek", to: "xai", error: "请求过于频繁 (HTTP 429)",
    kind: "rate_limit", trigger: "rate_limit", status: 429, handoff: withHandoff,
  });
  expect(notice).toContain("qh_notice0001");
  expect(notice).toContain("nyra models handoff qh_notice0001");
  expect(notice).not.toContain("最近任务：");

  const plain = formatModelSwitchNotice({
    from: "deepseek", to: "xai", error: "Internal server error",
    kind: "server", trigger: "server", status: 500,
  });
  expect(plain).not.toContain("接力摘要");
  expect(plain).not.toContain("qh_");
});

test("切换审计：有接力时记 handoff_id 并落盘接力记录，没接力时不带该字段", () => {
  const home = tmpRoot("nyra-handoff-audit-");
  try {
    const withHandoff = buildQuotaHandoff({
      from: "deepseek", to: "xai", error: "429", trigger: "rate_limit",
      messages: MSGS, id: "qh_audit00001",
    })!;
    const entry = recordModelSwitch(home, {
      from: "deepseek", to: "xai", error: "429", kind: "rate_limit",
      trigger: "rate_limit", status: 429, handoff: withHandoff,
    });
    expect(entry).not.toBeNull();
    expect(entry!.handoff_id).toBe("qh_audit00001");
    expect(getQuotaHandoff(home, "qh_audit00001")?.summary).toContain("勿重复已完成修改");
    const rows: ModelSwitchAuditEntry[] = readModelSwitchAudit(home);
    expect(rows.length).toBe(1);
    expect(rows[0]!.handoff_id).toBe("qh_audit00001");

    const plain = recordModelSwitch(home, {
      from: "deepseek", to: "xai", error: "500", kind: "server",
      trigger: "server", status: 500,
    });
    expect(plain).not.toBeNull();
    expect(plain!.handoff_id).toBeUndefined();
    expect("handoff_id" in plain!).toBe(false);
  } finally {
    cleanup(home);
  }
});

// ---- nyra models handoff ------------------------------------------------

test("models handoff：列最近摘要、看一条全文、未知 id 报错、空账本提示", async () => {
  const home = tmpRoot("nyra-handoff-cli-");
  try {
    const cap = captureOutput();
    try {
      expect(await handleModels(["handoff"], home)).toBe(0);
      expect(cap.out).toContain("还没有限流接力摘要");
    } finally {
      cap.restore();
    }
    const h = buildQuotaHandoff({
      from: "deepseek", to: "xai", error: "429", trigger: "rate_limit",
      messages: MSGS, id: "qh_cli0000001",
    })!;
    expect(recordQuotaHandoff(home, h)).not.toBeNull();
    const cap2 = captureOutput();
    try {
      expect(await handleModels(["handoff"], home)).toBe(0);
      expect(cap2.out).toContain("qh_cli0000001");
      expect(cap2.out).toContain("再把 hover 态也改一下".slice(0, 40));
    } finally {
      cap2.restore();
    }
    const cap3 = captureOutput();
    try {
      expect(await handleModels(["handoff", "qh_cli0000001"], home)).toBe(0);
      expect(cap3.out).toContain("限流接力摘要（deepseek → xai");
      expect(cap3.out).toContain("勿重复已完成修改");
    } finally {
      cap3.restore();
    }
    const cap4 = captureOutput();
    try {
      expect(await handleModels(["handoff", "qh_nope"], home)).toBe(1);
      expect(cap4.err).toContain("没有这条接力摘要");
    } finally {
      cap4.restore();
    }
  } finally {
    cleanup(home);
  }
});
