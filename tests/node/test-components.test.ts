// tests/node/test-components.test.ts — O7：生成式 UI（白名单组件 + render_component）。
// 全部用临时 home，不联网、不调真模型。
import { test, expect} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync} from "node:fs";
import { tmpdir} from "node:os";
import { join} from "node:path";
import {
BUILTIN_COMPONENTS,
ComponentError,
blockComponent,
getComponentSpec,
isComponentBlocked,
listComponentNames,
loadComponentConfig,
renderComponentText,
unblockComponent,
validateRenderRequest,
} from "../../src/components.ts";
import { handleComponents} from "../../src/componentsCli.ts";
import { TOOL_SCHEMAS, executeTool, newToolContext, type ToolContext} from "../../src/tools.ts";
import { createAguiServerEventMapper} from "../../src/aguiServer.ts";

function tmpHome(prefix: string): string {
return mkdtempSync(join(tmpdir(), prefix));
}

function toolCtx(home: string, workdir: string, bot = "default"): ToolContext {
return newToolContext({ workdir, home, mode: "full", interactive: false, soulAgent: bot});
}

// ---- 白名单 ----

test("ComponentsTest.test_builtin_allowlist", () => {
expect(listComponentNames()).toEqual(["table", "card", "list", "code", "chart-bar"]);
expect(BUILTIN_COMPONENTS.every((c) => c.published)).toBe(true);
expect(getComponentSpec("table")!.props.columns.required).toBe(true);
expect(getComponentSpec("nope")).toBe(null);
expect(TOOL_SCHEMAS.map((s) => (s.function as Record<string, unknown>).name)).toContain("render_component");
expect(TOOL_SCHEMAS.length).toBe(51);
});

// ---- 校验 ----

test("ComponentsTest.test_validate_render_request", () => {
const home = tmpHome("nyra-comp-");
try {
expect(() => validateRenderRequest(home, "default", "nope", {})).toThrow(/没有这个组件/);
expect(() => validateRenderRequest(home, "default", "table", { columns: ["任务"]})).toThrow(/缺少必填属性 rows/);
expect(() => validateRenderRequest(home, "default", "table", { columns: "任务", rows: []})).toThrow(/须是 array/);
expect(() => validateRenderRequest(home, "default", "card", { title: "t", nope: 1})).toThrow(/没有 nope 这个属性/);
expect(() => validateRenderRequest(home, "default", "chart-bar", { labels: ["a"], values: [1, 2]})).toThrow(/一一对应/);
expect(() => validateRenderRequest(home, "default", "chart-bar", { labels: ["a"], values: ["x"]})).toThrow(/须全是数字/);
expect(() => validateRenderRequest(home, "default", "table", { columns: [], rows: []})).toThrow(/columns 不能为空/);
expect(() => validateRenderRequest(home, "default", "list", { items: ["a", 1]})).toThrow(/须全是字符串/);
// 非字面数据（原型污染键）直接拒绝。
const evil = JSON.parse('{"__proto__": {"x": 1}}') as Record<string, unknown>;
expect(() => validateRenderRequest(home, "default", "card", { title: "t", fields: evil})).toThrow(/只接受字面数据/);
// 合规的通过。
const ok = validateRenderRequest(home, "default", "table", {
columns: ["任务", "状态"], rows: [["修登录", "已完成"], { 任务: "写文档", 状态: "进行中"}],
});
expect(ok.spec.name).toBe("table");
} finally {
rmSync(home, { recursive: true, force: true});
}
});

// ---- 文本渲染 ----

test("ComponentsTest.test_render_component_text", () => {
const table = renderComponentText("table", {
title: "本周任务", columns: ["任务", "状态"],
rows: [["修登录", "已完成"], { 任务: "写文档", 状态: "进行中"}],
});
expect(table).toBe("本周任务\n| 任务 | 状态 |\n| --- | --- |\n| 修登录 | 已完成 |\n| 写文档 | 进行中 |");
expect(renderComponentText("card", { title: "小明", body: "负责人", fields: { 任务: "修登录"}}))
.toBe("\n负责人\n任务：修登录");
expect(renderComponentText("list", { items: ["a", "b"]})).toBe("- a\n- b");
expect(renderComponentText("code", { language: "typescript", code: "const x = 1;"}))
.toBe("```typescript\nconst x = 1;\n```");
const chart = renderComponentText("chart-bar", { labels: ["甲", "乙"], values: [10, 5]});
const lines = chart.split("\n");
expect(lines[0]).toBe("甲 " + "█".repeat(20) + " 10");
expect(lines[1]).toBe("乙 " + "█".repeat(10) + "░".repeat(10) + " 5");
expect(() => renderComponentText("nope", {})).toThrow(ComponentError);
});

// ---- 屏蔽表 ----

test("ComponentsTest.test_blocklist_roundtrip", () => {
const home = tmpHome("nyra-comp-");
try {
expect(isComponentBlocked(home, "helper", "chart-bar")).toBe(false);
expect(blockComponent(home, "helper", "chart-bar")).toBe(true);
expect(blockComponent(home, "helper", "chart-bar")).toBe(false);
expect(isComponentBlocked(home, "helper", "chart-bar")).toBe(true);
expect(isComponentBlocked(home, "other", "chart-bar")).toBe(false);
expect(() => validateRenderRequest(home, "helper", "chart-bar", { labels: ["a"], values: [1]})).toThrow(/已屏蔽组件/);
expect(loadComponentConfig(home).blocked).toEqual({ helper: ["chart-bar"]});
expect(unblockComponent(home, "helper", "chart-bar")).toBe(true);
expect(unblockComponent(home, "helper", "chart-bar")).toBe(false);
expect(loadComponentConfig(home).blocked).toEqual({});
expect(() => blockComponent(home, "helper", "nope")).toThrow(/没有这个组件/);
// 损坏的配置先备份再抛错。
writeFileSync(join(home, "components.json"), "{bad json");
expect(() => loadComponentConfig(home)).toThrow(/已损坏/);
} finally {
rmSync(home, { recursive: true, force: true});
}
});

// ---- 模型工具 ----

test("ComponentsTest.test_render_component_tool", async () => {
const home = tmpHome("nyra-comp-");
const workdir = tmpHome("nyra-comp-wd-");
try {
const events: { kind: string; data: Record<string, unknown>}[] = [];
const ctx = toolCtx(home, workdir);
ctx.onEvent = (kind, data) => { events.push({ kind, data});};
const text = await executeTool("render_component", {
component: "list",
props: { title: "待办", items: ["修登录", "写文档"]},
}, ctx);
expect(text).toBe("待办\n- 修登录\n- 写文档");
expect(events.some((e) => e.kind === "component_rendered" && e.data.component === "list")).toBe(true);
// 校验失败时返回错误文本，不抛错、不发事件。
const bad = await executeTool("render_component", { component: "nope", props: {}}, ctx);
expect(bad).toContain("错误：没有这个组件");
expect(events.filter((e) => e.kind === "component_rendered")).toHaveLength(1);
// 被屏蔽的 Bot 调了也被拒。
blockComponent(home, "helper", "table");
const blocked = await executeTool("render_component", {
component: "table", props: { columns: ["任务"], rows: []},
}, toolCtx(home, workdir, "helper"));
expect(blocked).toContain("错误：Bot helper 已屏蔽组件 table");
} finally {
rmSync(home, { recursive: true, force: true});
rmSync(workdir, { recursive: true, force: true});
}
});

// ---- CLI 与 AG-UI 映射 ----

test("ComponentsTest.test_cli_block_unblock", () => {
const home = tmpHome("nyra-comp-");
try {
expect(handleComponents(["list"], home)).toBe(0);
expect(handleComponents(["block", "helper", "chart-bar"], home)).toBe(0);
expect(handleComponents(["block", "helper", "chart-bar"], home)).toBe(0);
expect(handleComponents(["block", "helper", "nope"], home)).toBe(1);
expect(handleComponents(["list", "--bot", "helper"], home)).toBe(0);
expect(handleComponents(["unblock", "helper", "chart-bar"], home)).toBe(0);
expect(handleComponents(["block"], home)).toBe(2);
expect(handleComponents(["nonsense"], home)).toBe(2);
} finally {
rmSync(home, { recursive: true, force: true});
}
});

test("ComponentsTest.test_agui_maps_component_rendered_to_custom", () => {
const home = tmpHome("nyra-comp-");
try {
const seen: Record<string, unknown>[] = [];
const mapper = createAguiServerEventMapper(home, {
threadId: "thread-1", runId: "run-1", sink: (e) => { seen.push(e);},
});
mapper.onEvent("component_rendered", {
component: "table",
bot: "helper",
props: { columns: ["任务"], rows: [["修登录"]]},
});
expect(seen).toHaveLength(1);
expect(seen[0]!.type).toBe("CUSTOM");
expect(seen[0]!.name).toBe("component_rendered");
expect(seen[0]!.value).toEqual({
component: "table",
props: { columns: ["任务"], rows: [["修登录"]]},
});
// 没给组件名时不发事件。
mapper.onEvent("component_rendered", { bot: "helper"});
expect(seen).toHaveLength(1);
} finally {
rmSync(home, { recursive: true, force: true});
}
});
