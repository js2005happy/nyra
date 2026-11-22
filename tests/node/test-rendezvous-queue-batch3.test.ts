// tests/node/test-rendezvous-queue-batch3.test.ts — 第 3 批 G-P1-13：
// Rendezvous（HRW 路由）+ 队列驱动底座（幂等、租约、纪元）。
// 全部用临时 home，不起真服务器、不联网。
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerNode,
  listNodes,
  routeKey,
  setNodeStatus,
  removeNode,
  rendezvousEpoch,
  hrwWeight,
  isLocalEndpoint,
} from "../../src/rendezvous.ts";
import {
  enqueueTask,
  getTask,
  listTasks,
  claimTask,
  completeTask,
  failTask,
} from "../../src/workQueue.ts";

function tmpHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function twoNodes(home: string): void {
  registerNode(home, "node-a", "http://127.0.0.1:18001");
  registerNode(home, "node-b", "http://127.0.0.1:18002");
}

test("RendezvousQueueBatch3.test_hrw_is_deterministic_and_weighted", () => {
  expect(hrwWeight("task-1", "node-a", 1)).toBe(hrwWeight("task-1", "node-a", 1));
  expect(hrwWeight("task-1", "node-a", 2)).toBe(hrwWeight("task-1", "node-a", 1) * 2);
  expect(hrwWeight("task-1", "node-a", 1)).not.toBe(hrwWeight("task-1", "node-b", 1));
  expect(hrwWeight("task-1", "node-a", 1)).not.toBe(hrwWeight("task-2", "node-a", 1));
});

test("RendezvousQueueBatch3.test_local_endpoint_only", () => {
  expect(isLocalEndpoint("http://127.0.0.1:18001")).toBe(true);
  expect(isLocalEndpoint("http://localhost:8080")).toBe(true);
  expect(isLocalEndpoint("http://192.168.1.10:8080")).toBe(true);
  expect(isLocalEndpoint("http://10.0.0.5:8080")).toBe(true);
  expect(isLocalEndpoint("https://example.com")).toBe(false);
  expect(isLocalEndpoint("http://8.8.8.8")).toBe(false);
  expect(isLocalEndpoint("not-a-url")).toBe(false);
});

test("RendezvousQueueBatch3.test_register_route_status_epoch", () => {
  const home = tmpHome("nyra-mesh-");
  try {
    expect(() => routeKey(home, "task-1")).toThrow("没有 active 节点");
    expect(() => registerNode(home, "node-x", "https://example.com")).toThrow("只登记本机");
    twoNodes(home);
    expect(listNodes(home)).toHaveLength(2);
    expect(rendezvousEpoch(home)).toBe(3); // 空账本 epoch 1，登记两节点 +2
    const n1 = routeKey(home, "task-1");
    expect(["node-a", "node-b"]).toContain(n1.id);
    expect(routeKey(home, "task-1").id).toBe(n1.id); // 同 key 同节点
    // 节点下线：它的 key 改派到另一台
    const keysOnA = ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8"].filter((k) => routeKey(home, k).id === "node-a");
    expect(keysOnA.length).toBeGreaterThan(0);
    setNodeStatus(home, "node-a", "offline");
    expect(rendezvousEpoch(home)).toBe(4);
    for (const k of keysOnA) expect(routeKey(home, k).id).toBe("node-b");
    expect(removeNode(home, "node-b")).toBe(true);
    expect(() => routeKey(home, "task-1")).toThrow("没有 active 节点");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("RendezvousQueueBatch3.test_queue_idempotent_enqueue", () => {
  const home = tmpHome("nyra-mesh-");
  try {
    twoNodes(home);
    const t1 = enqueueTask(home, "task-1", "do the thing");
    const t2 = enqueueTask(home, "task-1", "do the thing");
    expect(t2.id).toBe(t1.id); // 同一幂等键只进一条
    expect(listTasks(home)).toHaveLength(1);
    const t3 = enqueueTask(home, "task-1", "do the thing", "custom-idem-1");
    expect(t3.id).not.toBe(t1.id); // 显式幂等键不同，是另一条
    expect(t3.idempotency_key).toBe("custom-idem-1");
    expect(t3.payload_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(t3)).not.toContain("do the thing"); // 队列里不留载荷原文
    expect(() => enqueueTask(home, "", "x")).toThrow("路由 key");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("RendezvousQueueBatch3.test_claim_lease_complete_flow", () => {
  const home = tmpHome("nyra-mesh-");
  try {
    twoNodes(home);
    const t = enqueueTask(home, "task-1", "payload");
    const claimed = claimTask(home, t.id);
    expect(claimed.status).toBe("claimed");
    expect(claimed.node).not.toBeNull();
    expect(claimed.lease_token).not.toBeNull();
    expect(claimed.lease_until).not.toBeNull();
    // 租约内别人抢不走
    expect(() => claimTask(home, t.id)).toThrow("租约未过期");
    // 完成须节点 + 租约令牌都对得上
    expect(() => completeTask(home, t.id, claimed.node!, "wrong-token")).toThrow("对不上");
    expect(() => completeTask(home, t.id, "other-node", claimed.lease_token!)).toThrow("对不上");
    const done = completeTask(home, t.id, claimed.node!, claimed.lease_token!);
    expect(done.status).toBe("completed");
    expect(getTask(home, t.id)?.completed_at).not.toBeNull();
    expect(() => claimTask(home, t.id)).toThrow("已完成");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("RendezvousQueueBatch3.test_lease_expiry_reclaim_and_stale_token", () => {
  const home = tmpHome("nyra-mesh-");
  try {
    twoNodes(home);
    const t = enqueueTask(home, "task-1", "payload");
    let nowMs = Date.now();
    const first = claimTask(home, t.id, { leaseMs: 1000, now: () => nowMs });
    const oldToken = first.lease_token!;
    // 租约过期后可重派（换新令牌，旧令牌作废）
    nowMs += 2000;
    const second = claimTask(home, t.id, { leaseMs: 1000, now: () => nowMs });
    expect(second.lease_token).not.toBe(oldToken);
    expect(() => completeTask(home, t.id, second.node!, oldToken)).toThrow("对不上");
    const done = completeTask(home, t.id, second.node!, second.lease_token!);
    expect(done.status).toBe("completed");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("RendezvousQueueBatch3.test_fail_retries_capped_at_three", () => {
  const home = tmpHome("nyra-mesh-");
  try {
    twoNodes(home);
    const t = enqueueTask(home, "task-1", "payload");
    for (let i = 1; i <= 3; i++) {
      const c = claimTask(home, t.id);
      const f = failTask(home, t.id, c.node!, c.lease_token!);
      expect(f.status).toBe("queued");
      expect(f.retries).toBe(i);
    }
    const c = claimTask(home, t.id);
    const f = failTask(home, t.id, c.node!, c.lease_token!);
    expect(f.status).toBe("failed");
    expect(f.retries).toBe(4);
    expect(() => claimTask(home, t.id)).toThrow("重试已用完");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("RendezvousQueueBatch3.test_epoch_change_reroutes_claim", () => {
  const home = tmpHome("nyra-mesh-");
  try {
    twoNodes(home);
    const t = enqueueTask(home, "task-1", "payload");
    expect(t.epoch).toBe(3);
    // 节点账本变更（纪元 +1）后认领：按当前账本重算路由，纪元同步更新
    setNodeStatus(home, "node-b", "drained");
    const claimed = claimTask(home, t.id);
    expect(claimed.epoch).toBe(4);
    expect(claimed.node).toBe("node-a"); // 只剩 node-a 是 active
    // 没节点时认领直接拒绝，不静默本地执行
    setNodeStatus(home, "node-a", "offline");
    const t2 = enqueueTask(home, "task-2", "payload");
    expect(() => claimTask(home, t2.id)).toThrow("没有 active 节点");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
