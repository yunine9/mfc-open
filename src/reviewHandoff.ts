import type { TaskSummary } from "./taskService.ts";
import { classifyDeliveryFailure } from "./deliveryFailure.ts";

export const REVIEW_MISSION_END = "[本轮 MR 检视修复目标结束]";

/** 只消费完整的系统检视使命；用户后来追加的目标必须继续执行。 */
export function canHandoffReview(mission: string | undefined, summary: TaskSummary, recovering = false): boolean {
  const loop = summary.delivery?.loop;
  return ((recovering && !mission) || (!!mission?.startsWith("MR 上有 ") && mission.trimEnd().endsWith(REVIEW_MISSION_END)))
    && loop?.kind === "review" && loop.review_source === "platform"
    && !loop.workspace_review_pending && !!summary.delivery?.mr_url;
}

export async function handoffReview(host: {
  eligible(): boolean;
  ready(): Promise<boolean>;
  stage(): Promise<{ ok: boolean }>;
  record(): string | undefined;
  canVerify(): boolean;
  assertActive(): void;
  flush(): Promise<boolean>;
  complete(): void;
  wait(healthy: boolean): void;
}): Promise<boolean> {
  if (!host.eligible()) return false;
  const ready = await host.ready();
  host.assertActive();
  if (!ready || !host.eligible()) return false;
  // 必须先登记：stage 会把草稿转入 outbox 并清空文件。
  const failure = host.record();
  if (failure) {
    const classified = classifyDeliveryFailure(failure, "receipt");
    if (["evidence_missing", "evidence_invalid"].includes(classified.stall_class)) return false;
    throw new Error(failure); // 宿主收据错误不能伪装成材料缺失。
  }
  if (!host.canVerify()) return false; // 内核仍有编码步骤时，保留 Agent 续接。
  const staged = await host.stage();
  host.assertActive();
  if (!staged.ok || !host.eligible()) return false;
  const healthy = await host.flush(); // 网络发送由已有 outbox 监控继续，不为此重启模型。
  host.assertActive();
  if (!host.eligible()) return false;
  host.complete(); // 先记接管事实，重启可从同一 push 收据继续。
  host.wait(healthy);
  return true;
}
