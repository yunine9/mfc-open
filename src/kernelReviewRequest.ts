import type { HumanGate, WaitingRecord } from "./humanGate.ts";

const retiredReason = "审批内容指纹校验已取消，沿用已记录的用户意见继续";

/** 升级时撤下旧内核自动生成的二次确认，不代替用户回答真正的问题。
 * waiting.json 先落盘；中断后允许同一条撤卡记录再次完成任务恢复。 */
export function retireKernelReviewRequest(gate: HumanGate, waiting: WaitingRecord | undefined): boolean {
  if (!waiting || !/^kernel-review-[a-z_]+-[a-f0-9]{16}$/.test(waiting.call_id)) return false;
  if (waiting.status === "superseded") return waiting.notes === retiredReason;
  if (waiting.status !== "waiting") return false;
  gate.supersede(waiting.waiting_id, { stateVersion: waiting.state_version, notes: retiredReason });
  return true;
}
