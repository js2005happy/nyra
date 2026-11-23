// src/eval/benchmarks.ts — G-P1-30：外部基准集 + 仓内评估探针。
//
//   缺口：20 题固定评测是手工跑的基线，想对外说“Nyra 跑分如何”时，
//   得有“评测当一等公民”的另一半——数据集能管起来（导入、列出、删
//   除）、外部基准集能按统一格式接进来跑、回归探针是仓里的代码而不
//   是文档。本文件只做确定性部分：
//     - 导入格式 nyra-benchmark-v1：任务与内置 EvalTask 一一对应
//       （prompt → description，checks → acceptance，fixture /
//       expected / testBody / browserAction / browserExpected 原样
//       带过去），校验 fail-closed（未知键、重名 id、缺验收、类别
//       不合要求、fixture 路径越界都拒绝）；
//     - 存储：~/.nyra/eval-benchmarks/<name>.json（0600 原子写，
//       损坏先备份再抛错；重名导入拒绝，先删再导）；
//     - 仓内探针：evals/probes/*.json 是同一格式的基准集文件，随仓
//       走，测试钉住“每个探针文件都能通过校验”；
//     - 跑：不调模型，只做格式与映射；真正跑在 scripts/eval.ts
//       （--benchmark / --probe），走同一条 runEvalSuite。
//   不做：外部基准集的自动下载与转换（须人工先转成 nyra-benchmark-v1
//   再导入）；联网拉取任何数据集。
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHome } from "../config.ts";
import { writeEvalJson } from "./runner.ts";
import type { EvalCategory, EvalTask } from "./catalog.ts";

export class BenchmarkError extends Error {}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TASKS = 200;
const MAX_CHECKS = 20;
const MAX_FILE_BYTES = 1024 * 1024;

export function isBenchmarkName(name: string): boolean {
  return SLUG.test(name);
}

/** 一条外部基准集任务：与 EvalTask 一一对应，只换了字段名。 */
export interface BenchmarkCheck {
  id: string;
  description: string;
}

export interface BenchmarkTask {
  id: string;
  category: EvalCategory;
  prompt: string;
  checks: BenchmarkCheck[];
  fixture?: Record<string, string>;
  expected?: unknown;
  testBody?: string;
  browserAction?: string;
  browserExpected?: unknown;
}

export interface BenchmarkSet {
  schemaVersion: 1;
  kind: "benchmark";
  name: string;
  version: string;
  source: string;
  description?: string;
  tasks: BenchmarkTask[];
}

const SET_KEYS = new Set(["schemaVersion", "kind", "name", "version", "source", "description", "tasks"]);
const TASK_KEYS = new Set(["id", "category", "prompt", "checks", "fixture", "expected", "testBody", "browserAction", "browserExpected"]);
const CHECK_KEYS = new Set(["id", "description"]);
const CATEGORIES: readonly string[] = ["code", "browser", "research", "connector"];

function fail(message: string): never {
  throw new BenchmarkError(message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function checkKeys(obj: Record<string, unknown>, allowed: Set<string>, what: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) fail(`${what}里有多余的键：${k}`);
  }
}

function checkFixturePath(name: string): void {
  if (
    !name ||
    name.includes("\\") ||
    name.startsWith("/") ||
    name.split("/").some((p) => p === "" || p === "." || p === "..")
  ) {
    fail(`fixture 路径无效：${name}`);
  }
}

/** 严格校验一份外部基准集（fail-closed；返回原样结构化数据）。 */
export function validateBenchmarkSet(value: unknown): BenchmarkSet {
  if (!isRecord(value)) fail("基准集不是一个对象");
  checkKeys(value, SET_KEYS, "基准集");
  if (value.schemaVersion !== 1) fail("基准集 schemaVersion 须为 1");
  if (value.kind !== "benchmark") fail("基准集 kind 须为 benchmark");
  if (typeof value.name !== "string" || !isBenchmarkName(value.name)) {
    fail("基准集 name 须是 1–64 字的 slug（小写字母、数字、短横线）");
  }
  if (typeof value.version !== "string" || !value.version.trim() || value.version.length > 32) {
    fail("基准集 version 须是 1–32 字的字符串");
  }
  if (typeof value.source !== "string" || !value.source.trim() || value.source.length > 200) {
    fail("基准集 source 须是 1–200 字的字符串（来源 URL 或说明）");
  }
  if (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 500)) {
    fail("基准集 description 须是 500 字以内的字符串");
  }
  if (!Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > MAX_TASKS) {
    fail(`基准集 tasks 须是 1–${MAX_TASKS} 条的数组`);
  }
  const ids = new Set<string>();
  const tasks: BenchmarkTask[] = value.tasks.map((raw, i) => {
    const what = `第 ${i + 1} 个任务`;
    if (!isRecord(raw)) fail(`${what}不是一个对象`);
    checkKeys(raw, TASK_KEYS, what);
    if (typeof raw.id !== "string" || !SLUG.test(raw.id)) fail(`${what}的 id 须是 slug`);
    if (ids.has(raw.id)) fail(`任务 id 重复：${raw.id}`);
    ids.add(raw.id);
    if (typeof raw.category !== "string" || !CATEGORIES.includes(raw.category)) {
      fail(`${what}（${raw.id}）的 category 须是 code/browser/research/connector 之一`);
    }
    const category = raw.category as EvalCategory;
    if (typeof raw.prompt !== "string" || !raw.prompt.trim() || raw.prompt.length > 4000) {
      fail(`${what}（${raw.id}）的 prompt 须是 1–4000 字的字符串`);
    }
    if (!Array.isArray(raw.checks) || raw.checks.length < 1 || raw.checks.length > MAX_CHECKS) {
      fail(`${what}（${raw.id}）的 checks 须是 1–${MAX_CHECKS} 条的数组`);
    }
    const checkIds = new Set<string>();
    const checks: BenchmarkCheck[] = raw.checks.map((c, j) => {
      if (!isRecord(c)) fail(`${what}（${raw.id}）第 ${j + 1} 个验收项不是对象`);
      checkKeys(c, CHECK_KEYS, `${what}（${raw.id}）第 ${j + 1} 个验收项`);
      if (typeof c.id !== "string" || !SLUG.test(c.id)) fail(`${what}（${raw.id}）验收项 id 须是 slug`);
      if (checkIds.has(c.id)) fail(`${what}（${raw.id}）验收项 id 重复：${c.id}`);
      checkIds.add(c.id);
      if (typeof c.description !== "string" || !c.description.trim() || c.description.length > 200) {
        fail(`${what}（${raw.id}）验收项 ${c.id} 的 description 须是 1–200 字的字符串`);
      }
      return { id: c.id, description: c.description };
    });
    let fixture: Record<string, string> | undefined;
    if (raw.fixture !== undefined) {
      if (!isRecord(raw.fixture)) fail(`${what}（${raw.id}）的 fixture 须是对象`);
      const entries = Object.entries(raw.fixture);
      if (entries.length > 50) fail(`${what}（${raw.id}）的 fixture 最多 50 个文件`);
      fixture = {};
      for (const [name, content] of entries) {
        checkFixturePath(name);
        if (typeof content !== "string" || content.length > 100_000) {
          fail(`${what}（${raw.id}）的 fixture 文件 ${name} 须是 10 万字以内的字符串`);
        }
        fixture[name] = content;
      }
    }
    // 按类别补齐跑起来必需的字段（与 live.ts 的验收口径一一对应）。
    if (category === "code") {
      if (typeof raw.testBody !== "string" || !raw.testBody.trim()) {
        fail(`code 任务 ${raw.id} 须带 testBody（冻结断言）`);
      }
      if (!fixture?.["module.mjs"]) fail(`code 任务 ${raw.id} 的 fixture 须带 module.mjs`);
    }
    if (category === "research" || category === "connector") {
      if (!("expected" in raw)) fail(`${category} 任务 ${raw.id} 须带 expected`);
    }
    if (category === "browser") {
      if (typeof raw.browserAction !== "string" || !raw.browserAction.trim()) {
        fail(`browser 任务 ${raw.id} 须带 browserAction`);
      }
      if (!("browserExpected" in raw)) fail(`browser 任务 ${raw.id} 须带 browserExpected`);
      if (!fixture?.["page.html"]) fail(`browser 任务 ${raw.id} 的 fixture 须带 page.html`);
    }
    if (raw.testBody !== undefined && typeof raw.testBody !== "string") fail(`${what}（${raw.id}）的 testBody 须是字符串`);
    if (raw.browserAction !== undefined && typeof raw.browserAction !== "string") fail(`${what}（${raw.id}）的 browserAction 须是字符串`);
    return {
      id: raw.id,
      category,
      prompt: raw.prompt,
      checks,
      ...(fixture !== undefined ? { fixture } : {}),
      ...("expected" in raw ? { expected: raw.expected } : {}),
      ...(typeof raw.testBody === "string" ? { testBody: raw.testBody } : {}),
      ...(typeof raw.browserAction === "string" ? { browserAction: raw.browserAction } : {}),
      ...("browserExpected" in raw ? { browserExpected: raw.browserExpected } : {}),
    };
  });
  return {
    schemaVersion: 1,
    kind: "benchmark",
    name: value.name as string,
    version: value.version as string,
    source: value.source as string,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    tasks,
  };
}

/** 基准集任务 → 内置评测任务（prompt 当描述，checks 拼成 acceptance）。 */
export function benchmarkTaskToEvalTask(task: BenchmarkTask): EvalTask {
  return {
    id: task.id,
    category: task.category,
    description: task.prompt,
    acceptance: task.checks.map((c) => `${c.id}: ${c.description}`).join("；"),
    fixture: task.fixture ?? {},
    ...(task.expected !== undefined || "expected" in task ? { expected: task.expected } : {}),
    ...(task.testBody !== undefined ? { testBody: task.testBody } : {}),
    ...(task.browserAction !== undefined ? { browserAction: task.browserAction } : {}),
    ...(task.browserExpected !== undefined || "browserExpected" in task
      ? { browserExpected: task.browserExpected }
      : {}),
  };
}

function benchmarksDir(home: string): string {
  return join(resolveHome(home), "eval-benchmarks");
}

function benchmarkPath(home: string, name: string): string {
  return join(benchmarksDir(home), `${name}.json`);
}

function backupCorrupt(path: string): void {
  try {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    copyFileSync(path, `${path}.corrupt-${stamp}`);
  } catch { /* ignore */ }
}

function readBenchmarkFile(path: string, backup = true): BenchmarkSet {
  if (lstatSync(path).isSymbolicLink()) throw new BenchmarkError("基准集文件不能是符号链接");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    if (backup) backupCorrupt(path);
    throw new BenchmarkError(`基准集文件损坏${backup ? "，已备份" : ""}：${path}`);
  }
  try {
    return validateBenchmarkSet(parsed);
  } catch (e) {
    if (e instanceof BenchmarkError) {
      if (backup) backupCorrupt(path);
      throw new BenchmarkError(`基准集文件格式无效${backup ? "，已备份" : ""}：${e.message}`);
    }
    throw e;
  }
}

/** 导入一份外部基准集文件（重名拒绝，先删再导；不联网、不下载）。 */
export function importBenchmark(home: string, filePath: string, nameOverride?: string): BenchmarkSet {
  if (!filePath || !existsSync(filePath) || !lstatSync(filePath).isFile()) {
    throw new BenchmarkError(`基准集文件不存在或不是文件：${filePath}`);
  }
  if (statSync(filePath).size > MAX_FILE_BYTES) throw new BenchmarkError("基准集文件超过 1MB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    throw new BenchmarkError(`基准集文件不是有效 JSON：${filePath}`);
  }
  const set = validateBenchmarkSet(parsed);
  const name = nameOverride ?? set.name;
  if (!isBenchmarkName(name)) throw new BenchmarkError(`--name 须是 slug：${name}`);
  const path = benchmarkPath(home, name);
  if (existsSync(path)) throw new BenchmarkError(`基准集已存在：${name}（先 nyra eval remove ${name} --yes 再导）`);
  mkdirSync(benchmarksDir(home), { recursive: true, mode: 0o700 });
  writeEvalJson(path, { ...set, name }, benchmarksDir(home));
  return { ...set, name };
}

export interface BenchmarkListItem {
  name: string;
  version: string | null;
  source: string | null;
  tasks: number | null;
  valid: boolean;
  error?: string;
}

/** 列出已导入的基准集（坏文件也列出来、标 valid:false，不直接抛错）。 */
export function listBenchmarks(home: string): BenchmarkListItem[] {
  const dir = benchmarksDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const name = basename(f, ".json");
      try {
        const set = readBenchmarkFile(join(dir, f));
        return { name: set.name, version: set.version, source: set.source, tasks: set.tasks.length, valid: true };
      } catch (e) {
        return { name, version: null, source: null, tasks: null, valid: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
}

export function loadBenchmark(home: string, name: string): BenchmarkSet {
  if (!isBenchmarkName(name)) throw new BenchmarkError(`基准集名须是 slug：${name}`);
  const path = benchmarkPath(home, name);
  if (!existsSync(path)) throw new BenchmarkError(`没有这个基准集：${name}（先 nyra eval import <文件>）`);
  return readBenchmarkFile(path);
}

export function removeBenchmark(home: string, name: string): void {
  if (!isBenchmarkName(name)) throw new BenchmarkError(`基准集名须是 slug：${name}`);
  const path = benchmarkPath(home, name);
  if (!existsSync(path)) throw new BenchmarkError(`没有这个基准集：${name}`);
  if (lstatSync(path).isSymbolicLink()) throw new BenchmarkError("基准集文件不能是符号链接");
  unlinkSync(path);
}

// ---------------------------------------------------------------------------
// 仓内探针：evals/probes/*.json（同一格式，随仓走；回归探针是代码不是文档）。
// ---------------------------------------------------------------------------

export function defaultProbesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "evals", "probes");
}

export interface RepoProbeItem {
  name: string;
  file: string;
  version: string | null;
  source: string | null;
  tasks: number | null;
  valid: boolean;
  error?: string;
}

export function listRepoProbes(dir: string = defaultProbesDir()): { dir: string; available: boolean; probes: RepoProbeItem[] } {
  if (!existsSync(dir)) return { dir, available: false, probes: [] };
  const probes = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const path = join(dir, f);
      try {
        const set = readBenchmarkFile(path, false);
        if (basename(f, ".json") !== set.name) {
          return { name: basename(f, ".json"), file: f, version: set.version, source: set.source, tasks: set.tasks.length, valid: false, error: "文件名须与基准集 name 一致" };
        }
        return { name: set.name, file: f, version: set.version, source: set.source, tasks: set.tasks.length, valid: true };
      } catch (e) {
        return { name: basename(f, ".json"), file: f, version: null, source: null, tasks: null, valid: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  return { dir, available: true, probes };
}

/** 读一个仓内探针（文件名须与集名一致）。 */
export function loadRepoProbe(name: string, dir: string = defaultProbesDir()): BenchmarkSet {
  if (!isBenchmarkName(name)) throw new BenchmarkError(`探针名须是 slug：${name}`);
  const path = join(dir, `${name}.json`);
  if (!existsSync(path)) throw new BenchmarkError(`没有这个仓内探针：${name}`);
  const set = readBenchmarkFile(path, false);
  if (set.name !== name) throw new BenchmarkError(`探针文件 ${name}.json 里的 name 是 ${set.name}，须一致`);
  return set;
}
