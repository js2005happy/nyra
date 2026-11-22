// src/projectMemory.ts — 桌面“项目记忆”卡（设计稿 v8 pc-03）的只读数据：
// 三个文件——项目 AGENTS.md、全局 ~/.nyra/AGENTS.md、全局 MEMORY.md——各自在不在、多大；
// MEMORY.md 最近几条记忆带来源会话 id 与时间（来自 sidecar 索引，代码早已记录，这里只是读出来）。
// 只读：不写、不删、不分“你说的 / Nyra 记下”（代码没记这个区分，界面不编）。
// 读文件一律拒绝符号链接、只认普通文件、最多读 64 KiB。
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listMemoryEntries, resolveNyraHome } from "./memory.ts";

export const PROJECT_MEMORY_MAX_BYTES = 64 * 1024;
export type ProjectMemoryKind = "project" | "global" | "memory";
export const PROJECT_MEMORY_KINDS: readonly ProjectMemoryKind[] = ["project", "global", "memory"];

export interface ProjectMemoryFile {
  kind: ProjectMemoryKind;
  /** 界面上显示的名字（不含用户目录的绝对路径）。 */
  label: string;
  exists: boolean;
  bytes: number;
  /** 只有 memory 有：条目数。 */
  count?: number;
}

export interface ProjectMemoryEntry {
  id: string;
  text: string;
  created_at: string;
  source_session: string | null;
}

export function projectMemoryPath(home: string, workdir: string, kind: ProjectMemoryKind): string {
  if (kind === "project") return join(workdir, "AGENTS.md");
  if (kind === "global") return join(resolveNyraHome(home), "AGENTS.md");
  return join(resolveNyraHome(home), "MEMORY.md");
}

function regularFileSize(path: string): number | null {
  if (!existsSync(path)) return null;
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) return null;
  return st.size;
}

export function projectMemoryView(home: string, workdir: string, recent = 3): { files: ProjectMemoryFile[]; recent: ProjectMemoryEntry[] } {
  const labels: Record<ProjectMemoryKind, string> = { project: "AGENTS.md", global: "~/.nyra/AGENTS.md", memory: "MEMORY.md" };
  const files: ProjectMemoryFile[] = [];
  let entries: ProjectMemoryEntry[] = [];
  for (const kind of PROJECT_MEMORY_KINDS) {
    const path = projectMemoryPath(home, workdir, kind);
    const size = regularFileSize(path);
    const f: ProjectMemoryFile = { kind, label: labels[kind], exists: size !== null, bytes: size ?? 0 };
    if (kind === "memory") {
      let all: ProjectMemoryEntry[] = [];
      if (size !== null) {
        try {
          all = listMemoryEntries(path, home).map((e) => ({ id: e.id, text: e.text, created_at: e.created_at, source_session: e.source_session }));
        } catch { all = []; }
      }
      f.count = all.length;
      // 文件里越靠后的越新（appendMemory 只往后追加）；只回最近几条。
      entries = all.slice(-Math.max(0, recent)).reverse();
    }
    files.push(f);
  }
  return { files, recent: entries };
}

export function projectMemoryFile(home: string, workdir: string, kind: string): { kind: ProjectMemoryKind; content: string; exists: boolean; truncated: boolean } {
  if (!(PROJECT_MEMORY_KINDS as readonly string[]).includes(kind)) throw new Error("文件种类无效");
  const k = kind as ProjectMemoryKind;
  const path = projectMemoryPath(home, workdir, k);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("拒绝读取符号链接");
  const size = regularFileSize(path);
  if (size === null) return { kind: k, content: "", exists: false, truncated: false };
  const buf = readFileSync(path);
  const truncated = buf.length > PROJECT_MEMORY_MAX_BYTES;
  return { kind: k, content: buf.subarray(0, PROJECT_MEMORY_MAX_BYTES).toString("utf-8"), exists: true, truncated };
}
