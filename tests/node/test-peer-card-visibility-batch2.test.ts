// tests/node/test-peer-card-visibility-batch2.test.ts — 第 2 批 G-P1-5：
// 名片 per-circle 可见性（配了才限制，没配不限制；脏圈名跳过）。
import { test, expect } from "bun:test";
import { cardVisibleToCircle, peerCardConfig } from "../../src/peerCard.ts";

test("PeerCardVisibilityBatch2.test_unconfigured_visible_to_all", () => {
  expect(cardVisibleToCircle({}, "work")).toBe(true);
  expect(cardVisibleToCircle({}, "family")).toBe(true);
  expect(cardVisibleToCircle({ peer_card: { publish: true } }, "work")).toBe(true);
  expect(peerCardConfig({}).visibleCircles).toBeNull();
});

test("PeerCardVisibilityBatch2.test_configured_restricts_to_listed_circles", () => {
  const config = { peer_card: { publish: true, visible_circles: ["work", "friends"] } };
  expect(cardVisibleToCircle(config, "work")).toBe(true);
  expect(cardVisibleToCircle(config, "friends")).toBe(true);
  expect(cardVisibleToCircle(config, "family")).toBe(false);
  expect(peerCardConfig(config).visibleCircles).toEqual(["work", "friends"]);
});

test("PeerCardVisibilityBatch2.test_invalid_circle_names_skipped", () => {
  const config = { peer_card: { visible_circles: ["work", "bad name!", "", "work"] } };
  expect(peerCardConfig(config).visibleCircles).toEqual(["work"]);
  expect(cardVisibleToCircle(config, "work")).toBe(true);
  expect(cardVisibleToCircle(config, "bad name!")).toBe(false);
});

test("PeerCardVisibilityBatch2.test_empty_list_means_unrestricted", () => {
  const config = { peer_card: { visible_circles: [] } };
  expect(peerCardConfig(config).visibleCircles).toBeNull();
  expect(cardVisibleToCircle(config, "anything")).toBe(true);
});
