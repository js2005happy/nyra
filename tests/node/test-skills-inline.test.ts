// tests/node/test-skills-inline.test.ts — S3：技能 frontmatter 扩展 + `!`cmd`` 动态注入。
// 覆盖四类容易回归的事：
//   1) allowed-tools / model 能被解析（旧技能没写这两个字段时不受影响）
//   2) 默认不执行内联命令（contextUsage 也调 renderSkill，凭空执行会产生副作用）
//   3) 信任模型：只有 trustedRoots 下的技能自动执行；项目/插件技能只留占位
//   4) 危险命令（Unix + Windows）被拦截、失败命令降级为说明
import { test, expect } from "bun:test";
import { join } from "node:path";
import {
  parseSkillText, renderSkill, expandInlineCommands, isTrustedSkillPath, skillRenderOptionsFor,
} from "../../src/skills.ts";

const SAMPLE = `---
name: pr-summary
description: 汇总 PR 改动
when: 需要总结 PR 时
keywords: pr, summary
allowed-tools: Read, Grep, Bash(git *)
model: deepseek-v4-flash
paths: src/**/*.ts
---
## PR 上下文
- 分支: !\`echo feature-branch\`
请汇总。
`;

const TRUSTED = ["/home/u/.nyra/skills"];

function sample(path: string) {
  return parseSkillText(SAMPLE, path);
}

test("解析 allowed-tools / model / paths", () => {
  const skill = sample("/home/u/.nyra/skills/pr-summary.md");
  expect(skill.name).toBe("pr-summary");
  expect(skill.allowedTools).toEqual(["Read", "Grep", "Bash(git *)"]);
  expect(skill.model).toBe("deepseek-v4-flash");
  expect(skill.paths).toEqual(["src/**/*.ts"]);
});

test("旧技能没有新字段时仍是合法技能", () => {
  const skill = parseSkillText(`---\nname: plain\ndescription: 老技能\n---\n正文`, "/tmp/plain.md");
  expect(skill.allowedTools).toBeUndefined();
  expect(skill.model).toBeUndefined();
  expect(skill.paths).toBeUndefined();
  expect(skill.instructions).toBe("正文");
});

test("默认不执行内联命令，保留占位", () => {
  const out = renderSkill(sample("/home/u/.nyra/skills/pr-summary.md"));
  expect(out).toContain("未执行");
  expect(out).toContain("未执行：echo feature-branch");
  expect(out).not.toContain("feature-branch\n");
});

test("受信任目录下的技能：显式开启后注入真实命令输出", () => {
  const out = renderSkill(sample("/home/u/.nyra/skills/pr-summary.md"), { execute: true, trustedRoots: TRUSTED });
  expect(out).toContain("feature-branch\n");
  expect(out).not.toContain("未执行");
});

test("项目技能默认不执行（克隆带恶意技能的仓库不会被自动跑命令）", () => {
  const projectSkill = sample("/repo/skills/pr-summary.md");
  const out = renderSkill(projectSkill, { execute: true, trustedRoots: TRUSTED });
  expect(out).toContain("项目/插件技能默认不自动执行");
  expect(out).not.toContain("feature-branch\n");
});

test("isTrustedSkillPath：前缀比较、分隔符归一、大小写不敏感", () => {
  expect(isTrustedSkillPath("/home/u/.nyra/skills/a.md", TRUSTED)).toBe(true);
  expect(isTrustedSkillPath("/home/u/.nyra/skills/nested/b.md", TRUSTED)).toBe(true);
  expect(isTrustedSkillPath("C:\\Users\\U\\.nyra\\skills\\a.md", ["c:/users/u/.nyra/skills"])).toBe(true);
  expect(isTrustedSkillPath("/home/u/.nyra/skills-other/a.md", TRUSTED)).toBe(false);
  expect(isTrustedSkillPath("/repo/skills/a.md", TRUSTED)).toBe(false);
  expect(isTrustedSkillPath("/home/u/.nyra/skills/a.md", [])).toBe(false);
  // 同款 `..` 逃逸：只归一分隔符不折叠 `..` 时会被当成在受信根里
  expect(isTrustedSkillPath("/home/u/.nyra/skills/../etc/a.md", TRUSTED)).toBe(false);
  expect(isTrustedSkillPath("/home/u/.nyra/skills/sub/../../etc/a.md", TRUSTED)).toBe(false);
  expect(isTrustedSkillPath("/home/u/.nyra/skills/sub/./a.md", TRUSTED)).toBe(true);
});

test("NYRA_ALLOW_UNTRUSTED_SKILL_COMMANDS=1 可放开项目技能（显式自担风险）", () => {
  const prev = process.env.NYRA_ALLOW_UNTRUSTED_SKILL_COMMANDS;
  process.env.NYRA_ALLOW_UNTRUSTED_SKILL_COMMANDS = "1";
  try {
    const out = renderSkill(sample("/repo/skills/pr-summary.md"), { execute: true, trustedRoots: TRUSTED });
    expect(out).toContain("feature-branch\n");
  } finally {
    if (prev === undefined) delete process.env.NYRA_ALLOW_UNTRUSTED_SKILL_COMMANDS;
    else process.env.NYRA_ALLOW_UNTRUSTED_SKILL_COMMANDS = prev;
  }
});

test("渲染头部带上声明的工具与建议模型", () => {
  const out = renderSkill(sample("/home/u/.nyra/skills/pr-summary.md"));
  expect(out).toContain("本技能声明的可用工具");
  expect(out).toContain("Bash(git *)");
  expect(out).toContain("建议模型：deepseek-v4-flash");
});

test("危险命令被拦截：Unix 与 Windows 都要挡", () => {
  const cases = [
    "sudo rm -rf /",
    "rm -rf /tmp/x",
    "del /s /q C:\\",
    "rd /s /q C:\\Windows",
    "format C: /q",
    "Remove-Item -Recurse -Force C:\\Users",
    "vssadmin delete shadows /all /quiet",
    "bcdedit /set safeboot minimal",
    "Stop-Computer -Force",
  ];
  for (const cmd of cases) {
    const out = expandInlineCommands("!\`" + cmd + "\`", "x", { execute: true, trustedRoots: ["/r"] }, "/r/s.md");
    expect(out).toContain("已拒绝执行");
  }
});

test("命令失败降级为说明，不抛异常", () => {
  const out = expandInlineCommands("!\`command-that-does-not-exist-xyz\`", "x",
    { execute: true, trustedRoots: ["/r"] }, "/r/s.md");
  expect(out).toContain("命令失败");
});

test("输出过长会截断", () => {
  const long = "a".repeat(6000);
  const out = expandInlineCommands("!\`echo " + long + "\`", "x",
    { execute: true, trustedRoots: ["/r"], maxOutputChars: 100 }, "/r/s.md");
  expect(out).toContain("输出已截断");
  expect(out.length).toBeLessThan(400);
});

test("skillRenderOptionsFor：计划模式不执行，且信任根只含用户技能目录", () => {
  const plan = skillRenderOptionsFor({ mode: "plan", workdir: "/w", home: "/h" });
  expect(plan.execute).toBe(false);
  expect(plan.workdir).toBe("/w");
  // trustedRoots 用的是 path.join，Windows 上是反斜杠，不能写死 "/h/skills"。
  expect(plan.trustedRoots).toEqual([join("/h", "skills")]);

  const auto = skillRenderOptionsFor({ mode: "auto", workdir: "/w", home: "/h" });
  expect(auto.execute).toBe(true);
  expect(skillRenderOptionsFor({ mode: "creator", workdir: "/w", home: "/h" }).execute).toBe(true);
});
