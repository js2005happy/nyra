// tests/node/budget-race-child.ts — 预算跨进程竞态测试的子进程：
// 对同一账本做一次预留，成功打印 ok，拒绝打印 rejected。
import { BudgetLedger } from "../../src/budget.ts";
const [home, amountRaw, limitRaw] = process.argv.slice(2);
const amount = Number(amountRaw);
const limit = Number(limitRaw);
const ledger = new BudgetLedger(home);
const opts = { limits: [{ scope: "run", limitUsd: limit, spentUsd: 0 }], reason: "manual" as const };
const res = ledger.reserve(`race-${process.pid}`, amount, opts);
process.stdout.write(res.ok ? "ok" : "rejected");
