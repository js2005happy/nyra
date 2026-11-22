// src/merge.ts — H-5：合并成一份交付物（consolidated merge，缺口 13 深化）。
//
// Hermes 默认就是一条 consolidated 消息；Nyra 以前是文本汇总 + review queue，
// 缺“合成一份文件”这一步，本批补上。流程：批跑完后加一个合并步——
// 各子代理按 H-4 的 output_schema 契约交结构化摘要 → 编排者（一个合成子 agent，
// 只读工具白名单，只做合成）合成为一份交付物（计划 / 报告 / 文件）→
// 本模块的确定性检查 → review queue 人批。
//
// 合并步也可能引入幻觉与遗漏：确定性检查 + 人批是兜底，不要拿“合并了”当“对了”。
// 确定性检查只做文本层面的核对（线程有没有被提到、失败有没有被如实列出、
// 契约未通过有没有被标出来、改动文件有没有超出各线程证据的并集），
// 不替合并子 agent 判断内容对错——内容对错由人批复。
// 检查是启发式文本判定，只核说法不验语义；合并文本里没出现“线程 N”标记时
// 对应检查直接判未通过（合并子 agent 的任务文本里明确要求写这个标记）。

import { extractJsonCandidate } from "./outputSchema.ts";
import type { ParallelDelegateResult, ParallelThreadResult } from "./parallelDelegate.ts";

/** 合并交付物的形态：只改合成子 agent 的任务措辞，不改流程。 */
export type MergeFormat = "plan" | "report" | "file";

export const MERGE_FORMAT_LABELS: Record<MergeFormat, string> = {
  plan: "计划",
  report: "报告",
  file: "文件",
};

export interface MergeCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

/** 合并确定性检查清单（公开，文档与测试共用同一份）。 */
export const MERGE_CHECKLIST: { id: string; label: string; what: string }[] = [
  { id: "not-empty", label: "交付物非空", what: "合并文本非空（不少于 20 字）" },
  { id: "threads-covered", label: "成功线程都被提到", what: "每个成功线程在合并文本里有对应小节（“线程 N”标记或任务标题）" },
  { id: "failed-listed", label: "失败线程如实列出", what: "每个失败/超时/被拒的线程在合并文本里被提到，不静默丢掉" },
  { id: "schema-flags-kept", label: "契约未通过有标注", what: "契约校验未通过的线程，在其小节附近标了契约未通过" },
  { id: "files-consistent", label: "改动文件不超出证据", what: "合并文本“改动文件”清单里的每个文件都在各线程证据的并集里" },
];

/** 合并后的交付物（agent.ts 的 mergeParallelResults 拼出来）。 */
export interface MergedDeliverable {
  ok: boolean;
  title: string;
  /** 合并子 agent 的回答原文；合并步失败时为空。 */
  text: string;
  /** 合并步失败的原因；成功时为 null。 */
  error: string | null;
  /** 确定性检查是否全过。 */
  verified: boolean;
  checks: MergeCheck[];
  /** 进审阅队列后的项 id；入队失败或未入队时为 null。 */
  reviewItemId: string | null;
  /** 入队失败的原因；未要求入队或入队成功时为 null。 */
  reviewEnqueueError: string | null;
  /** 合并子 agent 花的美元；未计价时为 null，不编数字。 */
  mergeSpentUsd: number | null;
  /** 合并子 agent 实际用的模型。 */
  mergeModel: string | null;
  /** 完整版落盘位置（相对 ~/.nyra，如 merged/mg_xxxx.md）；未落盘时为 null。 */
  file: string | null;
}

export function mergeThreadMarker(index: number): string {
  return `线程 ${index + 1}`;
}

function threadMentioned(text: string, thread: ParallelThreadResult): boolean {
  if (text.includes(mergeThreadMarker(thread.index))) return true;
  const head = thread.task.trim().slice(0, 20);
  return head.length > 0 && text.includes(head);
}

/** 标记附近（默认 300 字内）有没有出现关键词。 */
function mentionsNear(text: string, marker: string, keyword: string, window = 300): boolean {
  const at = text.indexOf(marker);
  if (at < 0) return false;
  return text.slice(at, at + window).includes(keyword);
}

const FILE_LINE_RE = /^\s*[-•·*]\s+((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10})\s*$/gm;

/** 从合并文本里抽“改动文件”清单行（去掉 ``` 代码块后再扫，避免把示例当清单）。 */
export function extractListedFiles(text: string): string[] {
  const stripped = text.replace(/```[\s\S]*?```/g, "");
  const found = new Set<string>();
  for (const m of stripped.matchAll(FILE_LINE_RE)) found.add(m[1]);
  return [...found];
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function threadStatusLabel(status: ParallelThreadResult["status"]): string {
  return status === "ok" ? "成功" : status === "failed" ? "失败" : status === "timeout" ? "超时" : "被拒";
}

/** 合并子 agent 的任务文本：各线程的结构化摘要 + 合成要求。 */
export function buildMergeTask(result: ParallelDelegateResult, title: string, format: MergeFormat): string {
  const lines: string[] = [];
  lines.push(
    `你是一次并行委派的合并者（合并步）。下面是 ${result.results.length} 个子任务的执行结果。` +
    `你的任务是把它们合成为一份交付物（${MERGE_FORMAT_LABELS[format]}），只写这一份，不要罗列五段摘要拼盘。`,
    "",
    "要求：",
    "1. 交付物正文里每个线程单独一节，标题写成“线程 N：<任务一句话>”，N 从 1 开始按下面给的顺序编号；成功、失败、超时、被拒的线程都要列，失败的写清原因，绝不要把没跑完的线程写成已完成。",
    "2. 另起一段写“改动文件”清单，只列下面各线程证据里出现的文件，不编造、不补全；没有改动的线程写“无文件改动”。",
    "3. 有 output_schema 契约的线程：下面给出的是校验后抽出的结构化 JSON，直接用它做依据；标了“契约未通过”的线程要在对应小节里写一句“契约未通过（schema_valid: false），原文保留待人核”。",
    "4. 不编造数字、结论与验证结果；不确定的写“未验证”或“未知”，不要写成已验证。",
    "5. 末尾另起一段写“合并说明”：哪几个线程成功、哪几个失败/超时/被拒。",
    "6. 只做合成：不要改文件、不要跑命令、不要调其他工具，回答就是交付物正文。",
    "",
    `交付物标题：${title}`,
    "",
  );
  for (const r of result.results) {
    const schemaNote = r.schemaValid === null
      ? "无契约"
      : r.schemaValid ? "契约通过" : "契约未通过（schema_valid: false）";
    let body = "";
    if (r.status === "ok" && r.summary) {
      if (r.schemaValid !== null) {
        const extracted = extractJsonCandidate(r.summary);
        body = extracted.found
          ? JSON.stringify(extracted.value, null, 2).slice(0, 2000)
          : `（契约线程但没抽到 JSON，摘要原文：${trunc(r.summary, 500)}）`;
      } else {
        body = trunc(r.summary, 2000);
      }
    }
    lines.push(
      "---",
      `${mergeThreadMarker(r.index)}（状态：${threadStatusLabel(r.status)}；模型：${r.model ?? "未知"}；` +
      `花费：${r.evidence.spentUsd === null ? "未知（未计价）" : "$" + r.evidence.spentUsd.toFixed(4)}；` +
      `验收：${r.evidence.verification.status === "verified" ? "通过" : r.evidence.verification.status === "failed" ? "未通过" : "未验收"}；契约：${schemaNote}）`,
      `任务：${r.task}`,
      body ? `摘要/结构化结果：\n${body}` : "摘要：无",
      `改动文件：${r.evidence.changedFiles.length ? r.evidence.changedFiles.join("、") : "无"}`,
      r.evidence.diffStat ? `diff 摘要：\n${trunc(r.evidence.diffStat, 2000)}` : "diff 摘要：无",
      r.error ? `失败原因：${r.error}` : "失败原因：无",
      "",
    );
  }
  return lines.join("\n");
}

/** 对合并文本做确定性检查：只核说法，不验语义。 */
export function verifyMergedDeliverable(mergedText: string, result: ParallelDelegateResult): MergeCheck[] {
  const text = typeof mergedText === "string" ? mergedText : "";
  const checks: MergeCheck[] = [];
  checks.push({
    id: "not-empty",
    label: "交付物非空",
    passed: text.trim().length >= 20,
    detail: text.trim().length >= 20 ? `合并文本 ${text.trim().length} 字` : "合并文本为空或过短（少于 20 字）",
  });
  const okThreads = result.results.filter((r) => r.status === "ok");
  const missingOk = okThreads.filter((r) => !threadMentioned(text, r));
  checks.push({
    id: "threads-covered",
    label: "成功线程都被提到",
    passed: okThreads.length > 0 && missingOk.length === 0,
    detail: okThreads.length === 0
      ? "没有成功线程可合并"
      : missingOk.length === 0
        ? `${okThreads.length} 个成功线程都提到了`
        : `没提到的成功线程：${missingOk.map((r) => mergeThreadMarker(r.index)).join("、")}`,
  });
  const badThreads = result.results.filter((r) => r.status !== "ok");
  const missingBad = badThreads.filter((r) => !threadMentioned(text, r));
  checks.push({
    id: "failed-listed",
    label: "失败线程如实列出",
    passed: missingBad.length === 0,
    detail: badThreads.length === 0
      ? "没有失败/超时/被拒的线程"
      : missingBad.length === 0
        ? `${badThreads.length} 个失败/超时/被拒的线程都列出了`
        : `被丢掉的失败线程：${missingBad.map((r) => `${mergeThreadMarker(r.index)}（${threadStatusLabel(r.status)}）`).join("、")}`,
  });
  const schemaFailed = result.results.filter((r) => r.schemaValid === false);
  const unflagged = schemaFailed.filter((r) => {
    const marker = mergeThreadMarker(r.index);
    return !mentionsNear(text, marker, "契约") && !mentionsNear(text, marker, "schema_valid");
  });
  checks.push({
    id: "schema-flags-kept",
    label: "契约未通过有标注",
    passed: unflagged.length === 0,
    detail: schemaFailed.length === 0
      ? "没有契约未通过的线程"
      : unflagged.length === 0
        ? `${schemaFailed.length} 个契约未通过的线程都标了`
        : `没标契约未通过的线程：${unflagged.map((r) => mergeThreadMarker(r.index)).join("、")}`,
  });
  const union = new Set(result.results.flatMap((r) => r.evidence.changedFiles));
  const listed = extractListedFiles(text);
  const invented = listed.filter((f) => !union.has(f));
  checks.push({
    id: "files-consistent",
    label: "改动文件不超出证据",
    passed: invented.length === 0,
    detail: listed.length === 0
      ? "合并文本未列改动文件清单"
      : invented.length === 0
        ? `清单 ${listed.length} 个文件都在各线程证据里`
        : `清单里有各线程证据之外的文件：${invented.join("、")}`,
  });
  return checks;
}

/** 从 delegateDetailed 的交回文本里剥掉任务头与验收尾，只留合并子 agent 的回答原文。 */
export function extractMergedText(delegateText: string): string {
  let text = typeof delegateText === "string" ? delegateText : "";
  text = text.replace(/^\[子任务 [^\]]+ 已完成\]\n(?:（[^\n]*）\n)?/, "");
  const cut = text.indexOf("\n\n验收：");
  if (cut >= 0) text = text.slice(0, cut);
  return text.trim();
}

/** 最终回填/返回给模型与用户的合并文本：交付物 + 核验结论 + 各线程状态 + 成本与审阅去向。 */
export function formatMergedDeliverable(merged: MergedDeliverable, result: ParallelDelegateResult): string {
  const lines: string[] = [];
  lines.push(`合并交付物：${merged.title}`);
  if (merged.ok) {
    lines.push(merged.text);
  } else {
    lines.push(`合并步失败：${merged.error ?? "未知原因"}（各线程原文汇总见上，合并交付物未生成）。`);
  }
  const passed = merged.checks.filter((c) => c.passed).length;
  const failed = merged.checks.filter((c) => !c.passed);
  lines.push(
    merged.ok
      ? `合并核验：确定性检查 ${passed} 通过 / ${failed.length} 未通过（merge-deterministic）` +
        (merged.verified ? "；可进审阅。" : `；未通过（${failed.map((c) => c.label).join("、")}），须人批复后再用，不要把合并结果当已验证。`)
      : "合并核验：合并步失败，未做确定性检查。",
  );
  lines.push(
    `各线程：${result.results.map((r) => `${mergeThreadMarker(r.index)}${threadStatusLabel(r.status)}${r.schemaValid === false ? "（契约未通过）" : ""}`).join("；")}。`,
  );
  const total = result.totalSpentUsd;
  lines.push(
    `花费：合并步 ${merged.mergeSpentUsd === null ? "未知（未计价）" : "$" + merged.mergeSpentUsd.toFixed(4)}；` +
    `整批已计价 ${total === null ? "未知（未计价）" : "$" + total.toFixed(4)}` +
    (result.pendingAfterTimeout > 0 ? `（${result.pendingAfterTimeout} 个线程宽限期内未确认停下、仍在停止中，上值只是下限）` : "") +
    "。",
  );
  if (merged.file) lines.push(`完整版文件：${merged.file}（~/.nyra 下）。`);
  lines.push(
    merged.reviewItemId
      ? `审阅队列：${merged.reviewItemId}（nyra review show ${merged.reviewItemId} 查看并批复）。`
      : `审阅队列：未入队${merged.reviewEnqueueError ? `（${merged.reviewEnqueueError}）` : ""}。`,
  );
  return lines.join("\n\n");
}
