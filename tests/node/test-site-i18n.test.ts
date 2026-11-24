// tests/node/test-site-i18n.test.ts — 官网首页中英双语不回退：每段中文文案都有英文对应，
// 带中文的 alt / aria-label 都有英文版，默认按浏览器语言、可手动切换并记住。
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const html = readFileSync(join(ROOT, "docs", "index.html"), "utf-8");
const js = readFileSync(join(ROOT, "docs", "main.js"), "utf-8");
const CJK = /[\u4e00-\u9fff]/;

test("每个中文文案块都有对应的英文块", () => {
  const zh = html.split('<span class="zh">').length - 1;
  const en = html.split('<span class="en" lang="en">').length - 1;
  expect(zh).toBeGreaterThan(100);
  expect(en).toBe(zh);
});

test("正文里不在中文块里的可见文字不含中文（语言切换按钮“中”除外）", () => {
  const body = html.slice(html.indexOf("<body")).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
  const VOID = new Set(["br", "img", "meta", "link", "input", "source", "path", "rect", "circle", "hr"]);
  const stack: boolean[] = []; // 每层是否处在 class="zh" 里
  const left: string[] = [];
  let last = 0;
  for (const m of body.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>/g)) {
    const between = body.slice(last, m.index);
    last = m.index! + m[0].length;
    const inZh = stack.length > 0 && stack[stack.length - 1]!;
    if (!inZh && CJK.test(between) && between.trim() !== "中") left.push(between.trim().slice(0, 30));
    const [, close, name, attrs, self] = m;
    const tag = name!.toLowerCase();
    if (close) { stack.pop(); continue; }
    if (self || VOID.has(tag)) continue;
    stack.push(inZh || /\bclass="zh"/.test(attrs!));
  }
  expect(left).toEqual([]);
});

test("带中文的 alt / aria-label 都有英文版（data-alt-en / data-aria-en）", () => {
  const bad: string[] = [];
  for (const m of html.matchAll(/<\w+[^>]*>/g)) {
    const tag = m[0];
    for (const a of tag.matchAll(/\s(alt|aria-label)="([^"]*)"/g)) {
      if (!CJK.test(a[2]!)) continue;
      if (/[A-Za-z]{3,}/.test(a[2]!) && a[2]!.includes("/")) continue; // 已是「English / 中文」双语
      const twin = a[1] === "alt" ? "data-alt-en=" : "data-aria-en=";
      if (!tag.includes(twin)) bad.push(`${a[1]}="${a[2]!.slice(0, 30)}"`);
    }
  }
  expect(bad).toEqual([]);
});

test("默认按浏览器语言，?lang= 与本地记忆优先，可手动切换并记住；标题与描述有英文版", () => {
  expect(html).toMatch(/localStorage\.getItem\('nyra-lang'\)/);
  expect(html).toMatch(/navigator\.languages/);
  expect(html).toContain('data-l="zh"');
  expect(html).toContain('data-l="en"');
  expect(js).toContain("localStorage.setItem('nyra-lang'");
  expect(html).toMatch(/data-title-en="[^"]+"/);
  expect(html).toMatch(/data-desc-en="[^"]+"/);
});
