// src/fullModeRequests.ts — 手机开完全模式（full）的电脑确认门。
//
// 以前的口径：手机设置页自己点两次确认后，把 confirm: "full" 发给网关，
// 网关就信了——确认是手机自己断言的，手机丢了 / 被别人拿到，full 就直接开了。
// 现在的口径：非机主请求 full 时，网关只记一笔待确认请求（202 返回），
// 模式不动；机主必须在电脑上显式确认一次（`nyra gw mode-confirm <id>`），
// 请求才生效；拒绝、过期（10 分钟，与审批卡同限）都按不通过处理。
// 请求只放内存：网关重启就清掉，没确认的请求不会隔夜生效。
import { randomBytes } from "node:crypto";

export const FULL_MODE_REQUEST_TTL_SECONDS = 600;

export interface FullModeRequest {
  id: string;
  /** 请求方设备名（配对时登记的名字；没登记时是 "手机"）。 */
  device: string;
  createdAt: number;
  expiresAt: number;
}

export class FullModeRequests {
  private ttlSeconds: number;
  private clock: () => number;
  private requests = new Map<string, FullModeRequest>();

  constructor(opts?: { ttlSeconds?: number; clock?: () => number }) {
    this.ttlSeconds = opts?.ttlSeconds ?? FULL_MODE_REQUEST_TTL_SECONDS;
    this.clock = opts?.clock ?? (() => Date.now() / 1000);
  }

  request(device: string): FullModeRequest {
    const now = this.clock();
    const id = randomBytes(8).toString("hex");
    const req: FullModeRequest = {
      id,
      device: device || "手机",
      createdAt: now,
      expiresAt: now + this.ttlSeconds,
    };
    this.requests.set(id, req);
    return req;
  }

  list(): FullModeRequest[] {
    this.sweepExpired();
    return [...this.requests.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 批准返回 true；拒绝返回 false；不存在或已过期返回 null。 */
  decide(id: string, approve: boolean): boolean | null {
    const req = this.requests.get(id);
    if (!req) return null;
    if (this.clock() >= req.expiresAt) {
      this.requests.delete(id);
      return null;
    }
    this.requests.delete(id);
    return approve;
  }

  /** 清掉过期请求，返回清掉的条数。 */
  sweepExpired(): number {
    const now = this.clock();
    let n = 0;
    for (const [id, req] of this.requests) {
      if (now >= req.expiresAt) {
        this.requests.delete(id);
        n++;
      }
    }
    return n;
  }
}
