// tests/node/test-team-pack.test.ts — M3（OpenMausBot 的“一键装一整队”借鉴）：
// 一个 Markdown（YAML frontmatter + 说明正文）装一整队机器人。
// 不建中央目录：每台 Bot 物化成 bot.json + routines.json 后过市场三道门；
// 技能文件从本地已装的技能里拷过来，队伍包不自带、不编内容。
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchTeamPackText,
  installTeamPack,
  loadTeamPacks,
  parseTeamPack,
  parseYamlSubset,
  teamPackTemplate,
  validateTeamPack,
  TeamPackError,
} from "../../src/teamPack.ts";
import { findInstalled, listInstalled } from "../../src/marketplace.ts";
import { GroupStore } from "../../src/groups.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function goodSkillMd(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: 一个干净的测试技能",
    "when: 测试时用",
    "keywords: test",
    "---",
    "",
    "# 做法",
    "",
    "先读文件，再动手。",
    "",
  ].join("\n");
}

function seedSkill(home: string, name: string): void {
  mkdirSync(join(home, "skills"), { recursive: true });
  writeFileSync(join(home, "skills", `${name}.md`), goodSkillMd(name));
}

const PACK = `---
team: support-squad
version: 0.1.0
chief: lead
description: 客服小队
bots:
  - name: lead
    role: 队长：分工与汇总
    instructions: 你是队长。
    skills: [triage]
    mode: readonly
    routines:
      - name: daily-brief
        kind: schedule
        schedule: "0 9 * * *"
        task: 汇总昨日工单
  - name: researcher
    role: 查资料
    instructions: 你是研究员。
    skills: [research]
    mode: readonly
channels:
  - name: support-room
    bots: [lead, researcher]
playbook: |
  队长接单、分工、汇总。
connectors: [gmail]
---

# 客服小队

说明正文，只给人看，不执行。
`;

test("TeamPackTest.test_parse_yaml_subset", () => {
  const out = parseYamlSubset([
    "team: support-squad",
    "version: 0.1.0",
    "enabled: true",
    "count: 3",
    "tags: [a, b]",
    "playbook: |",
    "  第一行",
    "  第二行",
    "bots:",
    "  - name: lead",
    "    skills: [triage]",
    "  - name: researcher",
    "    skills: [research]",
  ].join("\n"));
  expect(out.team).toBe("support-squad");
  expect(out.enabled).toBe(true);
  expect(out.count).toBe(3);
  expect(out.tags).toEqual(["a", "b"]);
  expect(out.playbook).toBe("第一行\n第二行");
  expect((out.bots as { name: string }[]).map((b) => b.name)).toEqual(["lead", "researcher"]);
  expect(() => parseYamlSubset("team: x\n bad line")).toThrow(TeamPackError);
});

test("TeamPackTest.test_parse_team_pack", () => {
  const pack = parseTeamPack(PACK);
  expect(pack.team).toBe("support-squad");
  expect(pack.version).toBe("0.1.0");
  expect(pack.chief).toBe("lead");
  expect(pack.bots.map((b) => b.name)).toEqual(["lead", "researcher"]);
  expect(pack.bots[0]!.routines).toEqual([
    { name: "daily-brief", kind: "schedule", schedule: "0 9 * * *", task: "汇总昨日工单" },
  ]);
  expect(pack.channels).toEqual([{ name: "support-room", bots: ["lead", "researcher"] }]);
  expect(pack.playbook).toBe("队长接单、分工、汇总。");
  expect(pack.connectors).toEqual(["gmail"]);
});

test("TeamPackTest.test_parse_rejects_bad_packs", () => {
  expect(() => parseTeamPack("没有 frontmatter")).toThrow("frontmatter");
  expect(() => parseTeamPack(PACK.replace("chief: lead", "chief: nobody"))).toThrow("chief nobody 不在 bots 里");
  expect(() => parseTeamPack(PACK.replace("team: support-squad", "team: Bad Team"))).toThrow("team 无效");
  expect(() => parseTeamPack(PACK.replace("name: researcher", "name: lead"))).toThrow("名字不能重复");
  expect(() => parseTeamPack(PACK.replace("    skills: [research]", "    skills: [research]\n    hands_off_to:\n      - target: ghost"))).toThrow("不在队伍里");
  expect(() => parseTeamPack(PACK.replace("bots: [lead, researcher]", "bots: [lead, ghost]"))).toThrow("不在队伍里");
  expect(() => parseTeamPack(PACK.replace("    skills: [research]\n    mode: readonly", "    skills: [research]\n    mode: full"))).toThrow("mode 只允许 readonly|auto");
});

test("TeamPackTest.test_validate_rejects_unknown_model_and_missing_skill", () => {
  const home = tmpHome("nyra-team-");
  try {
    seedSkill(home, "triage");
    seedSkill(home, "research");
    const pack = parseTeamPack(PACK);
    expect(() => validateTeamPack(home, { ...pack, bots: pack.bots.map((b, i) => (i === 0 ? { ...b, model: "no-such-model" } : b)) }, PACK)).toThrow("不是已配置的模型");
    // researcher 的技能没装时直接报清楚。
    const home2 = tmpHome("nyra-team-");
    try {
      seedSkill(home2, "triage");
      expect(() => validateTeamPack(home2, pack, PACK)).toThrow("技能 research 还没装在本地");
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("TeamPackTest.test_install_team_end_to_end", async () => {
  const home = tmpHome("nyra-team-");
  try {
    seedSkill(home, "triage");
    seedSkill(home, "research");
    const pack = parseTeamPack(PACK);
    validateTeamPack(home, pack, PACK);
    const result = await installTeamPack(home, pack, { config: {}, sourceLabel: "test-pack.md" });
    expect(result.team).toBe("support-squad");
    expect(result.installed.map((b) => b.name)).toEqual(["lead", "researcher"]);
    expect(result.channels).toEqual([{ name: "support-room", created: true }]);
    expect(listInstalled(home).map((e) => e.item_name).sort()).toEqual(["lead", "researcher"]);
    expect(findInstalled(home, "lead")?.version).toBe("0.1.0");
    // routine 跟着机器人装进插件目录（到达即暂停，不自动执行）。
    expect(existsSync(join(home, "plugins", "lead", "routines.json"))).toBe(true);
    const routines = JSON.parse(readFileSync(join(home, "plugins", "lead", "routines.json"), "utf-8")) as { name: string }[];
    expect(routines.map((r) => r.name)).toEqual(["daily-brief"]);
    // 队伍账本只记队伍，不改 InstalledEntry 形状。
    const records = loadTeamPacks(home);
    expect(records.length).toBe(1);
    expect(records[0]!.team).toBe("support-squad");
    expect(records[0]!.chief).toBe("lead");
    expect(records[0]!.bots).toEqual(["lead", "researcher"]);
    expect(records[0]!.channels).toEqual(["support-room"]);
    // 频道建成群聊房。
    const store = new GroupStore(join(home, "groups"), { home });
    expect(store.get("support-room").bots.map((b) => b.id)).toEqual(["lead", "researcher"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("TeamPackTest.test_install_rolls_back_on_second_bot_failure", async () => {
  const home = tmpHome("nyra-team-");
  try {
    seedSkill(home, "triage");
    seedSkill(home, "research");
    const bad = parseTeamPack(PACK.replace("    skills: [research]", "    skills: [research]\n    tools: [no_such_tool]"));
    await expect(installTeamPack(home, bad, { config: {}, sourceLabel: "test-pack.md" })).rejects.toThrow("researcher");
    // 回滚：第一台已卸掉（findInstalled 按 status 过滤，卸掉的查不到），队伍账本没记。
    // listInstalled 不过滤状态：账本里仍留着 lead 的 uninstalled 记录（墓碑），这是有意的。
    expect(findInstalled(home, "lead")).toBeNull();
    expect(listInstalled(home).filter((e) => e.status === "installed").length).toBe(0);
    expect(loadTeamPacks(home).length).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("TeamPackTest.test_fetch_team_pack_text", async () => {
  const home = tmpHome("nyra-team-");
  try {
    const file = join(home, "pack.md");
    writeFileSync(file, PACK);
    const local = await fetchTeamPackText(file);
    expect(local.text).toBe(PACK);
    await expect(fetchTeamPackText(join(home, "missing.md"))).rejects.toThrow("读不到队伍包文件");
    await expect(fetchTeamPackText("http://example.com/pack.md")).rejects.toThrow("只接 https");
    await expect(fetchTeamPackText("https://example.com/pack.txt")).rejects.toThrow(".md 文件");
    await expect(fetchTeamPackText("https://github.com/x/y.git")).rejects.toThrow(".md 文件");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("TeamPackTest.test_template_parses", () => {
  expect(parseTeamPack(teamPackTemplate()).team).toBe("support-squad");
});
