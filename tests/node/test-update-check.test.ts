// tests/node/test-update-check.test.ts — 更新检查是默认关闭的 opt-in。
//
// 隐私政策承诺不联网回报：开关没开时 checkForUpdates 绝不调 fetch
// （注入的 fetch 会抛错，调了就露馅）；开了才查 GitHub Releases latest。
import { test, expect } from "bun:test";
import {
  checkForUpdates,
  compareVersions,
  isUpdateCheckEnabled,
  parseVersion,
  UPDATE_CHECK_CONFIG_KEY,
  UPDATE_CHECK_RELEASES_URL,
} from "../../src/updateCheck.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { explainAll } from "../../src/configExplain.ts";

test("默认关闭：config 默认值与 explain 都是关", () => {
  expect(DEFAULT_CONFIG[UPDATE_CHECK_CONFIG_KEY]).toBe(false);
  expect(isUpdateCheckEnabled(DEFAULT_CONFIG)).toBe(false);
  expect(isUpdateCheckEnabled({})).toBe(false);
  expect(isUpdateCheckEnabled(null)).toBe(false);
  expect(isUpdateCheckEnabled({ [UPDATE_CHECK_CONFIG_KEY]: true })).toBe(true);
  expect(isUpdateCheckEnabled({ [UPDATE_CHECK_CONFIG_KEY]: "true" })).toBe(false);
  const cap = explainAll({ config: {} }).find((c) => c.capability === "update_check");
  expect(cap).toBeTruthy();
  expect(cap!.keys).toContain("update_check_enabled");
  expect(cap!.effective).toContain("关");
});

test("开关关着时绝不联网：注入的 fetch 调了就抛错", async () => {
  const boom = () => { throw new Error("must not fetch while disabled"); };
  const r = await checkForUpdates({ enabled: false, currentVersion: "0.5.12", fetchRelease: boom as never });
  expect(r.checked).toBe(false);
  expect(r.updateAvailable).toBe(false);
  expect(r.reason).toBe("disabled");
  expect(r.latestVersion).toBeNull();
});

test("开关开着：有新版报有新版，同版报已是最新", async () => {
  const newer = await checkForUpdates({
    enabled: true, currentVersion: "0.5.12",
    fetchRelease: async (url) => {
      expect(url).toBe(UPDATE_CHECK_RELEASES_URL);
      return { tag_name: "v0.5.13", html_url: "https://github.com/js2005happy/nyra/releases/tag/v0.5.13" };
    },
  });
  expect(newer.checked).toBe(true);
  expect(newer.updateAvailable).toBe(true);
  expect(newer.latestVersion).toBe("v0.5.13");
  const same = await checkForUpdates({
    enabled: true, currentVersion: "0.5.12",
    fetchRelease: async () => ({ tag_name: "v0.5.12" }),
  });
  expect(same.updateAvailable).toBe(false);
  expect(same.latestVersion).toBe("v0.5.12");
});

test("开关开着但查不到：报失败不抛错", async () => {
  const r = await checkForUpdates({
    enabled: true, currentVersion: "0.5.12",
    fetchRelease: async () => { throw new Error("GitHub Releases 返回 500"); },
  });
  expect(r.checked).toBe(true);
  expect(r.updateAvailable).toBe(false);
  expect(r.latestVersion).toBeNull();
  expect(r.reason).toContain("500");
});

test("版本号比较：v 前缀与 -dev 后缀不影响", () => {
  expect(parseVersion("v0.5.12")).toEqual([0, 5, 12]);
  expect(parseVersion("0.5.12-dev")).toEqual([0, 5, 12]);
  expect(parseVersion("nope")).toBeNull();
  expect(compareVersions("v0.5.13", "0.5.12")).toBeGreaterThan(0);
  expect(compareVersions("0.5.12", "0.5.12")).toBe(0);
  expect(compareVersions("0.5.11", "0.5.12")).toBeLessThan(0);
  expect(compareVersions("nope", "0.5.12")).toBeNull();
});
