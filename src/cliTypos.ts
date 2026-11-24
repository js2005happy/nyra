// src/cliTypos.ts — 命令行打错字的拦截（不调模型、不花钱）。
//
// 1. `nyra doctr`：单个词、和已知子命令只差一两个字母时，提示“你是不是想要 doctor？”
//    并以非零退出码结束；不会把它当成任务发给模型。正常的任务文本（多个词、
//    中文、和任何子命令都不像的单词）不受影响。
// 2. `nyra ui --prot 9000`：子命令后面的未知 --选项直接报错（以前静默忽略）。

/** 编辑距离（Damerau：相邻两字母对调算 1 步，doctro → doctor）。 */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/** 允许的距离：4 个字母及以下只容 1 处错，更长的容 2 处。 */
function maxDistance(word: string): number {
  return word.length <= 4 ? 1 : 2;
}

/**
 * 任务文本像不像打错的子命令：只看单个小写英文词（可含 - 和数字），长度 ≥ 3，
 * 本身不是子命令，且和某个子命令的距离在阈值内。返回最接近的子命令，否则 null。
 */
export function suggestSubcommand(task: string, subcommands: Iterable<string>): string | null {
  const word = task.trim();
  if (word !== task || !/^[a-z][a-z0-9-]{2,}$/.test(word)) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const cmd of subcommands) {
    if (cmd === word) return null;
    if (Math.abs(cmd.length - word.length) > 2) continue;
    const dist = editDistance(word, cmd);
    if (dist < bestDist) { best = cmd; bestDist = dist; }
  }
  return best !== null && bestDist <= maxDistance(word) && bestDist <= maxDistance(best) ? best : null;
}

/**
 * 子命令参数里第一个不认识的 --选项。valueFlags 后面跟的值跳过；不以 - 开头的位置参数
 * 不管（各子命令自己处理）。这些子命令只认 `--flag value`，`--flag=value` 以前会被静默
 * 忽略，所以也算错误，并提示正确写法。
 */
export function findUnknownFlag(
  argv: string[],
  valueFlags: readonly string[],
  boolFlags: readonly string[],
): { flag: string; suggestion: string | null } | null {
  const known = [...valueFlags, ...boolFlags];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    if (!a.startsWith("-") || a === "-") continue;
    const eq = a.indexOf("=");
    const name = eq >= 0 ? a.slice(0, eq) : a;
    if (eq < 0 && valueFlags.includes(name)) { i++; continue; }
    if (eq < 0 && boolFlags.includes(name)) continue;
    if (eq >= 0 && valueFlags.includes(name)) return { flag: a, suggestion: `${name} ${a.slice(eq + 1)}` };
    let suggestion: string | null = null;
    let bestDist = Infinity;
    for (const k of known) {
      const dist = editDistance(name, k);
      if (dist < bestDist) { bestDist = dist; suggestion = k; }
    }
    return { flag: a, suggestion: bestDist <= 2 ? suggestion : null };
  }
  return null;
}

/** 几个高频子命令认识的选项（--provider/--model 由顶层预扫描使用，--lang 在入口已取走）。 */
export const SUBCOMMAND_FLAGS: Record<string, { value: readonly string[]; bool: readonly string[] }> = {
  ui: {
    value: ["--host", "--port", "--mode", "--provider", "--model", "--profile", "--workdir", "--lang"],
    bool: ["--print-url-json", "--exit-on-stdin-close", "--pair", "--verbose", "--open"],
  },
  doctor: { value: ["--provider", "--model", "--lang"], bool: [] },
  setup: { value: ["--provider", "--model", "--lang"], bool: [] },
};
