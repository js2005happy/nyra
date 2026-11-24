// Windows 桌面应用侧栏：项目名只显示文件夹名（悬停看完整路径），单行省略，
// 不再整串显示 C:\Users\...\Nyra 并换行压到「还没有对话」上。
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway, projectBaseName } from "../../src/gateway.ts";
import { saveSession } from "../../src/memory.ts";

const ASSETS = join(import.meta.dir, "..", "..", "src", "assets");

test("projectBaseName handles Windows and POSIX paths", () => {
  expect(projectBaseName("C:\\Users\\runneradmin\\Nyra")).toBe("Nyra");
  expect(projectBaseName("C:\\Users\\runneradmin\\shop-tools\\")).toBe("shop-tools");
  expect(projectBaseName("/home/me/demo/shop-tools")).toBe("shop-tools");
  expect(projectBaseName("D:/work/app")).toBe("app");
});

test("sessions view returns folder names for Windows workdirs", () => {
  const home = mkdtempSync(join(tmpdir(), "nyra-sidebar-"));
  saveSession("20261124-120000-bbbb", [{ role: "user", content: "整理订单" }], home);
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "sessions", "ui-projects.json"), JSON.stringify({ "20261124-120000-bbbb": "C:\\Users\\runneradmin\\shop-tools" }));
  const gw = new Gateway({ home, workdir: "C:\\Users\\runneradmin\\Nyra", port: 0 });
  const view = gw.sessionsView() as { project: { name: string; workdir: string }; sessions: { project: string | null; workdir: string | null }[] };
  expect(view.project.name).toBe("Nyra");
  expect(view.project.workdir).toBe("C:\\Users\\runneradmin\\Nyra");
  expect(view.sessions[0].project).toBe("shop-tools");
  expect(view.sessions[0].workdir).toBe("C:\\Users\\runneradmin\\shop-tools");
});

test("sidebar shows the folder name on one line with the full path on hover", () => {
  const js = readFileSync(join(ASSETS, "desktop-app.js.txt"), "utf-8");
  const css = readFileSync(join(ASSETS, "desktop-app.css.txt"), "utf-8");
  expect(js).toContain("function baseName(p)");
  expect(js).toContain("h.title = fullPath.get(name) || name;");
  expect(js).toContain("el('span', 'pn', name)");
  expect(css).toMatch(/\.pr \.pn\{[^}]*white-space:nowrap[^}]*overflow:hidden[^}]*text-overflow:ellipsis/);
  // 前端 baseName 与后端同口径
  const m = /function baseName\(p\)\{[^\n]*\}/.exec(js);
  expect(m).not.toBeNull();
  const baseName = new Function(`${m![0]}; return baseName;`)() as (p: string) => string;
  expect(baseName("C:\\Users\\runneradmin\\Nyra")).toBe("Nyra");
  expect(baseName("/home/me/x/")).toBe("x");
});
