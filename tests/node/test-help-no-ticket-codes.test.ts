// tests/node/test-help-no-ticket-codes.test.ts — `nyra --help` 不带内部工单编号。
// 帮助是用户最先看到的界面；“缺口 29”“G-P1-40”“GROK-6”“batch 2”这类开发期编号不该出现在里面。
import { test, expect } from "bun:test";
import { USAGE, USAGE_EN } from "../../src/cli.ts";

const TICKET = /缺口\s*\d|\bgap \d|\bG-P\d|\bG-\d|GROK-\d|\bbatch \d|第[一二三四五六七八九十\d]+批|\bphase \d|第 ?\d+ ?阶段/i;

for (const [name, text] of [["zh", USAGE], ["en", USAGE_EN]] as const) {
  test(`--help（${name}）不含内部工单编号`, () => {
    const bad = text.split("\n").filter((l) => TICKET.test(l));
    expect(bad).toEqual([]);
  });
}
