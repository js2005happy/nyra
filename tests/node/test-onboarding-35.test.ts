// tests/node/test-onboarding-35.test.ts — 缺口 35：对话式入职 + 一键角色模板。
// 全部用临时 home 与随仓 skills/ 目录，不连真实渠道、不花真实 token、不调模型。
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectPerms } from "./fsPerms.ts";
import {
  ONBOARDING_FILE,
  ROLE_TEMPLATES,
  buildInitPlan,
  checkSkillsAvailable,
  deliverReadyBriefing,
  exportRoleTemplate,
  findRoleTemplate,
  formatPlanChecklist,
  formatReadyBriefing,
  handleInit,
  handleTemplates,
  handleWake,
  installRoleSkills,
  listCustomTemplates,
  listRoleTemplates,
  loadCustomTemplate,
  loadOnboarding,
  onboardingExists,
  planFromTemplate,
  saveCustomTemplate,
  validateRoleTemplatePack,
  applyInitPlan,
  type RoleTemplate,
} from "../../src/onboarding.ts";
import { loadSoul, soulExists } from "../../src/soul.ts";
import { loadInbox } from "../../src/tasks.ts";
import { RunStore } from "../../src/runs.ts";
import { buildTimeline, formatTimelineText } from "../../src/timeline.ts";

const REPO_SKILLS = join(import.meta.dir, "..", "..", "skills");

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
}

test("内置角色模板三件齐全，技能名都是随仓有的", () => {
  expect(listRoleTemplates().length).toBe(3);
  expect(ROLE_TEMPLATES.map((t) => t.id)).toEqual(["researcher", "assistant", "shopkeeper"]);
  for (const t of ROLE_TEMPLATES) {
    expect(t.persona.length).toBeGreaterThan(0);
    expect(t.goal.length).toBeGreaterThan(0);
    expect(t.skills.length).toBeGreaterThan(0);
    expect(t.tenets.length).toBeGreaterThan(0);
    for (const s of t.skills) expect(existsSync(join(REPO_SKILLS, `${s}.md`))).toBe(true);
    for (const tenet of t.tenets) {
      if (tenet.kind === "prior") expect(tenet.deny).toEqual([]);
    }
  }
  expect(findRoleTemplate("researcher")?.name).toBe("研究员");
  expect(findRoleTemplate("nope")).toBeNull();
});

test("buildInitPlan 研究员模板取模板值，红线追加一条偏好", () => {
  const plan = buildInitPlan({ name: "阿研", role: "researcher", redline: "不对外发消息" });
  expect(plan.agent).toBe("default");
  expect(plan.name).toBe("阿研");
  expect(plan.role).toBe("researcher");
  expect(plan.roleName).toBe("研究员");
  expect(plan.skills).toEqual(["web-research", "verify-research", "deep-thinking"]);
  expect(plan.tenets.some((t) => t.text === "红线：不对外发消息" && t.kind === "prior")).toBe(true);
  expect(plan.tenets.some((t) => t.kind === "invariant" && t.deny.includes("shell(rm *)"))).toBe(true);
});

test("buildInitPlan 自定义角色须给活或风格，未知角色直接拒绝", () => {
  expect(() => buildInitPlan({})).toThrow("干什么活");
  expect(() => buildInitPlan({ role: "wizard" })).toThrow("没有这个角色");
  const plan = buildInitPlan({ role: "custom", work: "每天早上帮我看一眼店铺订单", persona: "说话客气" });
  expect(plan.role).toBe("custom");
  expect(plan.goal).toBe("每天早上帮我看一眼店铺订单");
  expect(plan.skills).toEqual([]);
});

test("配置清单与就绪简报列出名字角色技能红线与 0 token", () => {
  const plan = buildInitPlan({ name: "阿研", role: "assistant", redline: "不花钱" });
  const checklist = formatPlanChecklist(plan);
  expect(checklist).toContain("阿研");
  expect(checklist).toContain("助理");
  expect(checklist).toContain("file-organizer");
  expect(checklist).toContain("红线：不花钱");
  const briefing = formatReadyBriefing(plan);
  expect(briefing).toContain("我是 阿研（助理），已就绪");
  expect(briefing).toContain("0 token");
});

test("技能包预检与安装：装进 home skills，第二次跳过不覆盖，缺文件整体拒绝", () => {
  const home = tmpHome("nyra-onb-35-");
  try {
    expect(checkSkillsAvailable(["web-research", "deep-thinking"], { skillsSrcDir: REPO_SKILLS })).toEqual([]);
    expect(checkSkillsAvailable(["no-such-skill"], { skillsSrcDir: REPO_SKILLS })).toEqual(["no-such-skill"]);
    const first = installRoleSkills(home, ["web-research", "deep-thinking"], { skillsSrcDir: REPO_SKILLS });
    expect(first.installed).toEqual(["web-research", "deep-thinking"]);
    expect(first.missing).toEqual([]);
    expect(existsSync(join(home, "skills", "web-research.md"))).toBe(true);
    expectPerms(join(home, "skills", "web-research.md"), 0o600);
    const second = installRoleSkills(home, ["web-research"], { skillsSrcDir: REPO_SKILLS });
    expect(second.installed).toEqual([]);
    expect(second.skipped).toEqual(["web-research"]);
    const bad = installRoleSkills(home, ["debugging", "no-such-skill"], { skillsSrcDir: REPO_SKILLS });
    expect(bad.missing).toEqual(["no-such-skill"]);
    expect(bad.installed).toEqual([]);
    expect(existsSync(join(home, "skills", "debugging.md"))).toBe(false);
  } finally {
    cleanup(home);
  }
});

test("applyInitPlan 写 Soul 与账本，技能缺文件时什么都不写", () => {
  const home = tmpHome("nyra-onb-35-");
  try {
    const plan = buildInitPlan({ name: "阿研", role: "researcher" });
    const { installed } = applyInitPlan(home, plan, { skillsSrcDir: REPO_SKILLS });
    expect(installed).toEqual(["web-research", "verify-research", "deep-thinking"]);
    expect(soulExists(home, "default")).toBe(true);
    const soul = loadSoul(home, "default");
    expect(soul.identity.name).toBe("阿研");
    expect(soul.tenets.length).toBe(2);
    expect(onboardingExists(home)).toBe(true);
    const record = loadOnboarding(home);
    expect(record?.role).toBe("researcher");
    expect(record?.briefing_pending).toBe(true);
    expectPerms(join(home, ONBOARDING_FILE), 0o600);
    // 缺文件：Soul 与账本都不写。
    const home2 = tmpHome("nyra-onb-35-");
    try {
      const badPlan = buildInitPlan({ name: "阿研", role: "researcher" });
      badPlan.skills = ["no-such-skill"];
      expect(() => applyInitPlan(home2, badPlan, { skillsSrcDir: REPO_SKILLS })).toThrow("缺文件");
      expect(soulExists(home2, "default")).toBe(false);
      expect(onboardingExists(home2)).toBe(false);
    } finally {
      cleanup(home2);
    }
  } finally {
    cleanup(home);
  }
});

test("就绪简报进收件箱与账本，事件已注册且时间线能渲染", () => {
  const home = tmpHome("nyra-onb-35-");
  try {
    const plan = buildInitPlan({ name: "阿研", role: "shopkeeper" });
    applyInitPlan(home, plan, { skillsSrcDir: REPO_SKILLS });
    const { text } = deliverReadyBriefing(home, plan);
    expect(text).toContain("店小二");
    const inbox = loadInbox(home);
    expect(inbox.length).toBe(1);
    expect(String(inbox[0].status)).toBe("ready");
    const record = loadOnboarding(home);
    expect(record?.briefing_pending).toBe(false);
    expect(record?.last_briefing).toContain("店小二");
    // 三个新事件已注册进 EVENT_FIELDS（行为断言：appendEvent 不抛错）。
    const store = new RunStore(join(home, "runs"));
    const state = store.create("入职事件注册检查", "onboarding", process.cwd(), "readonly", 1, "running");
    store.appendEvent(state.run_id, "onboarding_completed", { agent: "default", role: "shopkeeper", template: "shopkeeper" });
    store.appendEvent(state.run_id, "onboarding_template_applied", { agent: "default", template: "shopkeeper" });
    store.appendEvent(state.run_id, "onboarding_ready_briefing", { agent: "default", channel: "terminal+inbox" });
    store.setStatus(state.run_id, "completed_unverified");
    const rendered = formatTimelineText(buildTimeline(store, state.run_id));
    expect(rendered).toContain("入职完成");
    expect(rendered).toContain("就绪简报已发");
  } finally {
    cleanup(home);
  }
});

test("handleInit 交互三问走完、确认后落盘；拒绝确认时什么都不写", async () => {
  const home = tmpHome("nyra-onb-35-");
  try {
    const answers = ["阿研", "1", "说话直接；不对外发消息"];
    let i = 0;
    const code = await handleInit([], home, {
      ask: async () => answers[i++] ?? "",
      confirm: async () => true,
    });
    expect(code).toBe(0);
    expect(loadSoul(home, "default").identity.name).toBe("阿研");
    expect(loadOnboarding(home)?.role).toBe("researcher");
    // 拒绝确认：什么都不写。
    const home2 = tmpHome("nyra-onb-35-");
    try {
      const code2 = await handleInit(["--name", "阿助", "--role", "assistant"], home2, {
        confirm: async () => false,
      });
      expect(code2).toBe(0);
      expect(soulExists(home2, "default")).toBe(false);
      expect(onboardingExists(home2)).toBe(false);
    } finally {
      cleanup(home2);
    }
  } finally {
    cleanup(home);
  }
});

test("handleInit 已有 Soul 时默认不覆盖，--force 才覆盖", async () => {
  const home = tmpHome("nyra-onb-35-");
  try {
    expect(await handleInit(["--name", "阿研", "--role", "researcher", "--yes"], home)).toBe(0);
    expect(loadSoul(home, "default").identity.name).toBe("阿研");
    expect(await handleInit(["--name", "阿助", "--role", "assistant", "--yes"], home)).toBe(0);
    expect(loadSoul(home, "default").identity.name).toBe("阿研");
    expect(await handleInit(["--name", "阿助", "--role", "assistant", "--yes", "--force"], home)).toBe(0);
    expect(loadSoul(home, "default").identity.name).toBe("阿助");
  } finally {
    cleanup(home);
  }
});

test("handleTemplates list/show/apply 全部走通", async () => {
  const home = tmpHome("nyra-onb-35-");
  try {
    expect(await handleTemplates(["list"], home)).toBe(0);
    expect(await handleTemplates(["show", "assistant"], home)).toBe(0);
    expect(await handleTemplates(["show", "nope"], home)).toBe(1);
    expect(await handleTemplates(["apply", "shopkeeper", "--name", "小二", "--yes"], home)).toBe(0);
    expect(loadSoul(home, "default").identity.name).toBe("小二");
    expect(loadOnboarding(home)?.source).toBe("templates");
    expect(loadOnboarding(home)?.template_id).toBe("shopkeeper");
  } finally {
    cleanup(home);
  }
});

test("模板包导出导入往返：内置导出后改 id 再导入，校验不过的一个都不装", async () => {
  const home = tmpHome("nyra-onb-35-");
  try {
    const out = join(home, "researcher-pack.json");
    expect(await handleTemplates(["export", "researcher", out], home)).toBe(0);
    const pack = JSON.parse(readFileSync(out, "utf-8")) as Record<string, unknown>;
    expect(pack.kind).toBe("nyra-role-template");
    // 改成自定义 id 再导入。
    pack.id = "scout";
    pack.name = "侦察员";
    writeFileSync(out, JSON.stringify(pack, null, 2) + "\n");
    expect(await handleTemplates(["import", out, "--yes"], home)).toBe(0);
    expect(listCustomTemplates(home).map((c) => c.id)).toContain("scout");
    expect(loadCustomTemplate(home, "scout")?.name).toBe("侦察员");
    expect(loadOnboarding(home)?.role).toBe("scout");
    // 坏包：技能名不认 + deny 解析不出，校验不过。
    const bad = { ...pack, id: "badpack", skills: ["no-such-skill"], tenets: [{ kind: "prior", text: "x", deny: ["not a rule ((("] }] };
    const badFile = join(home, "bad-pack.json");
    writeFileSync(badFile, JSON.stringify(bad, null, 2) + "\n");
    expect(validateRoleTemplatePack(bad).length).toBeGreaterThan(0);
    expect(await handleTemplates(["import", badFile, "--yes"], home)).toBe(1);
    expect(loadCustomTemplate(home, "badpack")).toBeNull();
    // 内置 id 不能顶替。
    const shadow = { ...pack, id: "researcher" };
    expect(validateRoleTemplatePack(shadow).some((e) => e.includes("不能顶替"))).toBe(true);
  } finally {
    cleanup(home);
  }
});

test("planFromTemplate 与 saveCustomTemplate 往返", () => {
  const home = tmpHome("nyra-onb-35-");
  try {
    const template = findRoleTemplate("assistant") as RoleTemplate;
    const plan = planFromTemplate(template, "default", "阿助");
    expect(plan.roleName).toBe("助理");
    expect(plan.skills).toContain("file-organizer");
    const custom: RoleTemplate = { ...template, id: "helper2", name: "帮手二号" };
    saveCustomTemplate(home, custom);
    expect(listCustomTemplates(home).map((c) => c.id)).toContain("helper2");
    expect(() => saveCustomTemplate(home, custom)).toThrow("已存在");
    saveCustomTemplate(home, custom, { force: true });
    expect(loadCustomTemplate(home, "helper2")?.name).toBe("帮手二号");
    expect(loadCustomTemplate(home, "nope")).toBeNull();
  } finally {
    cleanup(home);
  }
});

test("handleWake 没入职报 1，入职后重发简报", async () => {
  const home = tmpHome("nyra-onb-35-");
  try {
    expect(await handleWake([], home)).toBe(1);
    expect(await handleInit(["--name", "阿研", "--role", "researcher", "--yes"], home)).toBe(0);
    expect(loadOnboarding(home)?.briefing_pending).toBe(false);
    expect(await handleWake([], home)).toBe(0);
    expect(loadInbox(home).length).toBe(2);
  } finally {
    cleanup(home);
  }
});

test("入职账本损坏先备份再抛错", () => {
  const home = tmpHome("nyra-onb-35-");
  try {
    const plan = buildInitPlan({ name: "阿研", role: "researcher" });
    applyInitPlan(home, plan, { skillsSrcDir: REPO_SKILLS });
    writeFileSync(join(home, ONBOARDING_FILE), "{ broken json");
    expect(() => loadOnboarding(home)).toThrow("损坏");
    const backups = readdirSync(home).filter((f) => f.startsWith(`${ONBOARDING_FILE}.corrupt-`));
    expect(backups.length).toBe(1);
    expect(loadOnboarding(home)).toBeNull();
  } finally {
    cleanup(home);
  }
});

test("exportRoleTemplate 拒绝覆盖已存在的文件", () => {
  const home = tmpHome("nyra-onb-35-");
  try {
    const out = join(home, "pack.json");
    writeFileSync(out, "old\n");
    expect(() => exportRoleTemplate(home, "researcher", out)).toThrow("已存在");
    expect(readFileSync(out, "utf-8")).toBe("old\n");
    const target = exportRoleTemplate(home, "researcher", out, { force: true });
    expect(target).toBe(out);
    expect(JSON.parse(readFileSync(out, "utf-8")).id).toBe("researcher");
  } finally {
    cleanup(home);
  }
});

test("真 CLI 管道喂答案：三问 + 确认四行一次到齐也能走完（readline 管道回归）", () => {
  // 回归：node:readline 的 rl.question 在管道 stdin 下，接口在 EOF 时自动
  // close 并丢掉挂起的提问回调——第一个问题能读到，第二个就永远等不到，
  // 进程静默退出。提问器改成自带行缓冲队列后，四行一次到齐也能走完。
  const home = tmpHome("nyra-onb-35-");
  try {
    const root = join(import.meta.dir, "..", "..");
    const result = spawnSync("bun", [join(root, "src", "cli.ts"), "init"], {
      input: "阿研\n1\n说话直接；不对外发消息\ny\n",
      encoding: "utf-8",
      cwd: root,
      env: { ...process.env, NYRA_HOME: home },
      timeout: 30000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(soulExists(home, "default")).toBe(true);
    expect(loadSoul(home, "default").identity.name).toBe("阿研");
    expect(loadOnboarding(home)?.role).toBe("researcher");
    expect(String(result.stdout)).toContain("入职完成");
  } finally {
    cleanup(home);
  }
});
