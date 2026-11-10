import { remainingCiMission } from "./ciMission.ts";
import { parsePipelineChecks } from "./pipelineContract.ts";
import type { PipelineRun, PipelineStatus } from "./pipelineClient.ts";
import type { TaskSummary } from "./taskService.ts";
import { CLOSED_MR_WRITE } from "./mergeWatch.ts";

export function validPushReceipt(value: unknown): value is NonNullable<NonNullable<TaskSummary["delivery"]>["git_push"]> {
  const row = value as { sha?: unknown; ref?: unknown; remote?: unknown } | undefined;
  return !!row && typeof row.sha === "string" && /^[a-f0-9]{40,64}$/i.test(row.sha)
    && typeof row.ref === "string" && row.ref.startsWith("refs/heads/") && typeof row.remote === "string" && !!row.remote;
}

/** 两条推送入口共用投影：新 SHA 只代表已推送，不继承旧运行的红绿灯。
 * last_sha 是上次派发修复锚，必须保留；在实际派出下一轮修复时才更新。 */
export function projectPushReceipt(summary: TaskSummary, receipt: NonNullable<NonNullable<TaskSummary["delivery"]>["git_push"]>): void {
  const previous = summary.delivery;
  summary.delivery = { ...previous, git_push: receipt, sha: receipt.sha,
    ...(previous?.git_push?.sha && previous.git_push.sha !== receipt.sha
      ? { last_push_base_sha: previous.git_push.sha } : {}),
    ...(previous?.sha !== receipt.sha ? {
      pipeline: undefined, pipeline_background: undefined, checks: undefined, attested: undefined,
      evidence_gap: undefined, verify_deadline: undefined,
      waiting_on: previous?.mr_state === CLOSED_MR_WRITE.mr_state ? previous.waiting_on : undefined,
    } : {}) };
}

/** A request for a new SHA must not adopt an old run returned by the adapter. */
export function observedPipelineRun(sha: string, result: PipelineRun | PipelineStatus): PipelineRun | undefined {
  const runs = "runs" in result ? result.runs : [result];
  // 同 SHA 的最近一次运行优先；后一次仍在跑或被判无效时，不能回退拿旧绿灯。
  const run = runs.filter(run => !run.sha || run.sha === sha).at(-1);
  return run && run.is_valid !== false ? { ...run, sha } : undefined;
}

export function confirmedPipelineRun(sha: string, result: PipelineRun | PipelineStatus): PipelineRun {
  const run = observedPipelineRun(sha, result);
  if (!run) throw new Error(`尚未查到提交 ${sha} 的有效流水线记录，旧 SHA 结果不能用于本次验证`);
  return run;
}

/** Scheduling projection only: keep the old failure/receipt intact for audit. */
export function historicalPipelineFeedback(summary: TaskSummary, item: {
  source?: unknown; observed_sha?: unknown; source_id?: unknown;
}): boolean {
  const delivery = summary.delivery;
  const sha = delivery?.sha;
  const sourceSha = String(item.observed_sha || String(item.source_id ?? "").split(":")[0]);
  return item.source === "pipeline" && !!sha && !!sourceSha && sourceSha !== sha
    && delivery?.git_push?.sha === sha;
}

/** Project remote facts before handing control to the shared pipeline watcher. */
export function projectPipelineRun(task: { summary: TaskSummary; mission?: string }, sha: string, response: PipelineRun | undefined, background = false): PipelineRun | undefined {
  const run = response ? confirmedPipelineRun(sha, response) : undefined;
  if (task.summary.delivery?.git_push?.sha !== sha) throw new Error("流水线提交与当前已推送提交不一致");
  task.summary.delivery = { ...task.summary.delivery, sha, pipeline: run?.status ?? "not_found", pipeline_background: background,
    checks: run?.checks, ...(background ? {} : { skipped: undefined, stalled: undefined, stall_class: undefined, waiting_on: undefined, evidence_gap: undefined }) };
  if (background) return run; // 提前验证只记远端事实，不接管当前目标或编码状态。
  const loop = task.summary.delivery.loop;
  if (loop?.kind === "ci") {
    loop.state = "verifying";
    // last_sha/failure 保留本轮的原始失败快照，不伪造已修好或已通过。
    task.mission = remainingCiMission(task.mission, task.summary) || undefined;
  }
  task.summary.status = "verifying";
  task.summary.detail = run ? `正在验证提交 ${sha.slice(0, 8)}，旧提交的告警保留为历史记录`
    : `已推送 ${sha.slice(0, 8)}，尚未发现该提交的流水线，正在继续查询`;
  return run;
}

/** 修复会话 → 修复结果验证的唯一状态交接。
 *
 * mission 仍在表示专职修复 Agent 尚未完成，绝不能提前切；没有 mission
 * 且任务仍在活动交付态时，repairing 已经是旧版遗留或刚收口的陈旧值。
 * 返回是否发生转换，由调用方在自己的原子边界持久化。 */
export function enterRepairVerification(task: { summary: TaskSummary; mission?: string }): boolean {
  const loop = task.summary.delivery?.loop;
  if (loop?.state !== "repairing" || task.mission) return false;
  if (!["queued", "running", "pausing", "verifying"]
    .includes(task.summary.status)) return false;
  loop.state = "verifying";
  task.summary.detail = task.summary.delivery?.prepush
    ? "修复会话已完成，正在验证修复后的提交"
    : "修复会话已完成，等待验证修复后的提交";
  return true;
}


/** Normalize the existing inline adapter response before publishing task state. */
export function parseTriggeredPipelineRun(sha: string, raw: Record<string, unknown>): PipelineRun {
  if (!["success", "failed", "running"].includes(String(raw.status))) {
    throw new Error(`流水线返回未知状态: ${String(raw.status ?? "(empty)")}`);
  }
  return confirmedPipelineRun(sha, {
    status: raw.status as PipelineRun["status"], log: String(raw.log ?? ""),
    checks: parsePipelineChecks(raw.checks),
    ...(typeof raw.sha === "string" ? { sha: raw.sha } : {}),
    ...(typeof raw.is_valid === "boolean" ? { is_valid: raw.is_valid } : {}),
  });
}
