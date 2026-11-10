import { captureLocalCodeSnapshot } from "./finalMrLocalSnapshot.ts";
import { spawnSync } from "node:child_process";
import { interruptWarmupReceipt } from "./auxiliarySessions.ts";
import { interruptDeveloperAssistant } from "./developerAssistant.ts";
import { TaskControlError } from "./errors.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";
import { validPushReceipt } from "./pipelineHandoff.ts";
import type { DeliveryMr } from "./mrImportTypes.ts";
import { finalMrRecord, originalMr, type FinalDeliveryMr } from "./taskFinalMr.ts";
import { TaskHostLedger } from "./taskHostTools.ts";
import type { TaskState, TaskSummary } from "./taskService.ts";

/** 建初版 MR 前已推送过时，从本轮宿主推送记录恢复工作分支。 */
function publishedWorkBranch(summary: TaskSummary, final: FinalDeliveryMr): string | undefined {
  const receipt = summary.delivery?.git_push;
  if (!validPushReceipt(receipt) || receipt.remote !== "origin" || ![40, 64].includes(receipt.sha.length)) return;
  if (receipt.url !== undefined && (typeof receipt.url !== "string" || repositoryIdentity(receipt.url) !== repositoryIdentity(final.repo))) return;
  const branch = receipt.ref.slice("refs/heads/".length);
  const target = summary.delivery?.target_branch ?? summary.baseline;
  if (!target || branch === target || branch === final.target_branch || !branch || branch.includes("\0") || branch.includes("@{")) return;
  return spawnSync("git", ["check-ref-format", "--branch", branch], { stdio: "ignore" }).status === 0 ? branch : undefined;
}

export function applyFinalMrLink(task: TaskState, mr: DeliveryMr): FinalDeliveryMr {
  const initial = originalMr(task.summary);
  if (initial && !initial.head) {
    // 使用任务工具创建的历史 MR 还可能留有当时的创建收据。
    try {
      const creation = new TaskHostLedger(task.summary).read().operations.find(op =>
        op.input.action === "create_mr" && op.mr_receipt?.url === initial.url && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(op.sha ?? ""));
      if (creation) initial.head = creation.sha;
    } catch { /* 只有原 MR 链接也能关联，代码分析会标出缺少的版本。 */ }
  }
  const final = finalMrRecord(mr);
  captureLocalCodeSnapshot(task.summary, task.cwd, final.url);
  const waiting = task.summary.waiting && task.humanGate.get(task.summary.waiting.waiting_id);
  if (waiting?.status === "waiting") task.humanGate.supersede(waiting.waiting_id,
    { stateVersion: waiting.state_version, notes: "已关联最终 MR" });
  const d = task.summary.delivery ??= {};
  if (initial) d.initial_mr = initial;
  if (!d.source_branch) {
    const branch = publishedWorkBranch(task.summary, final);
    if (branch) d.source_branch = branch;
  }
  d.final_mr = final;
  d.merged_sha = undefined;
  d.stalled = undefined;
  d.stall_class = undefined;
  d.verify_deadline = undefined;
  task.assistantEpoch = (task.assistantEpoch ?? 0) + 1;
  task.pendingAssistantHandoff = undefined;
  task.pendingResume = undefined;
  task.mission = undefined;
  task.summary.status = "await_merge";
  task.summary.waiting = undefined;
  interruptDeveloperAssistant(task.summary.workspace, "已关联最终 MR，开发助手停止");
  interruptWarmupReceipt(task.summary.baseline_build);
  if (d.loop) { d.loop.state = "halted"; d.loop.diagnosis = "云端已停止修复，跟踪最终 MR"; }
  setFinalMrWaiting(task, final);
  return final;
}

function setFinalMrWaiting(task: TaskState, final: FinalDeliveryMr): void {
  const d = task.summary.delivery!;
  const closed = final.state === "closed";
  d.mr_state = closed ? "已关闭" : final.state === "merged" ? "已合入（内核终态待对账）" : "等待合入";
  d.waiting_on = closed ? "最终 MR 已关闭，未确认交付；可关联其他 MR"
    : final.state === "merged" ? "最终 MR 已合入，正在登记完成" : "等待最终 MR 合入";
  task.summary.detail = d.waiting_on;
}

interface FinalMrTrackingHost {
  read(url: string): Promise<DeliveryMr>;
  current(): boolean;
  stop(): Promise<string[]>;
  settle(final: FinalDeliveryMr): Promise<void>;
  persist(): void;
  log?(message: string): void;
}

export async function refreshLinkedFinalMr(task: TaskState, linked: FinalDeliveryMr, host: FinalMrTrackingHost): Promise<void> {
  if (task.mergeSettlement || ["completed", "canceled"].includes(task.summary.status)) return;
  if (linked.state === "merged" && (linked.head || linked.merge_commit_sha) && task.summary.delivery?.final_mr === linked) {
    await host.settle(linked);
    return;
  }
  const mr = await host.read(linked.url);
  if (!host.current() || task.mergeSettlement
      || task.summary.delivery?.final_mr !== linked || ["completed", "canceled"].includes(task.summary.status)) return;
  const d = task.summary.delivery;
  const final = finalMrRecord(mr);
  if (String(final.id) !== String(linked.id)) throw new TaskControlError("最终 MR 标识已变化，请重新核对链接");
  if (linked.state === "merged") {
    // 已经观察到的合入事实不能被平台的旧响应撤销。这里只补同一次合入缺失的版本。
    if (final.state !== "merged") {
      host.log?.(`任务 ${task.summary.id} 已记录最终 MR 合入，本次查询返回 ${final.state}，将继续查询缺失的版本`);
      return;
    }
    final.source_branch = linked.source_branch || final.source_branch;
    final.target_branch = linked.target_branch || final.target_branch;
    final.merged_at = linked.merged_at ?? final.merged_at;
    final.base = linked.base ?? final.base;
  }
  const wasStalled = !!d.stalled;
  if (wasStalled && final.state !== "merged") {
    const failures = await host.stop();
    if (failures.length || task.summary.delivery?.final_mr !== linked || ["completed", "canceled"].includes(task.summary.status)) return;
    d.stalled = undefined; d.stall_class = undefined;
    task.summary.status = "await_merge";
  }
  if (final.state === "merged") {
    if (d.stall_class === "evidence_missing" && !final.head && !final.merge_commit_sha && linked.state === "merged" && !linked.head && !linked.merge_commit_sha) return;
    d.final_mr = final;
    await host.settle(final);
  } else if (wasStalled || JSON.stringify(final) !== JSON.stringify(linked) || task.summary.status !== "await_merge" || d.waiting_on !== task.summary.detail) {
    d.final_mr = final;
    setFinalMrWaiting(task, final);
    host.persist();
  }
}
