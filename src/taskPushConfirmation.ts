import { deliveryChangeSnapshot } from "./artifacts.ts";
import { deliveryFileList, type PushFileList } from "./deliveryFileList.ts";
import { TaskHostLedger, type HostOperation } from "./taskHostTools.ts";
import { normalizedDeliveryPaths, pushReviewCallId, hasPushApproval, latestPushDecision, samePaths } from "./pushReviewPolicy.ts";
import type { TaskSummary } from "./taskService.ts";
import type { HumanGate } from "./humanGate.ts";

export const HOST_PUSH_CHOICE_EFFECTS = [
  { key: "confirm", answers: ["确认推送"], allowsSourceEdit: false, handlesFeedback: false, closesFeedback: false },
  { key: "adjust", answers: ["先调整"], allowsSourceEdit: true, handlesFeedback: true, closesFeedback: false },
];
export const HOST_PUSH_CONFIRM_STEP = "host_push_confirm";
export const PUSH_SCOPE_GUIDANCE = "文件勾选机制已取消，当前提交可直接交付。后续修复不受历史文件清单限制；明确的调整意见仍交给 Agent 处理。";
interface PushConfirmationHost {
  summary: TaskSummary;
  cwd?: string;
  humanGate: HumanGate;
  accountDefault(): boolean | undefined;
  contribution(snapshot: NonNullable<Awaited<ReturnType<typeof deliveryChangeSnapshot>>>): Promise<{ paths: string[]; base_sha?: string }>;
  pushFiles(branch: string, head: string): Promise<PushFileList>;
  persist(): void;
  notifyWaiting(): void;
}

/** 两种推送入口复用同一个推送决定；实际发布 SHA 由准备和传输层取证。
 * 提前推送不代替逐条检视意见闭环，也不伪造流水线通过。 */
export async function confirmHostPush(host: PushConfirmationHost, operation: HostOperation, assertActive: () => void): Promise<boolean> {
  const required = host.summary.push_confirmation ?? host.accountDefault() ?? false;
  if (!required) return true;
  const snapshot = host.cwd ? await deliveryChangeSnapshot(host.cwd) : undefined;
  if (!snapshot || snapshot.head !== operation.sha) throw new Error("推送准备期间提交发生变化，请刷新待执行操作后继续");
  const contribution = snapshot.baseline ? await host.contribution(snapshot) : undefined;
  const paths = contribution ? normalizedDeliveryPaths(contribution.paths) : undefined;
  assertActive();
  const ledger = new TaskHostLedger(host.summary);
  const selection = host.summary.delivery_selection;
  const ownApproval = operation.push_confirmed;
  const decisions = host.humanGate.resolved();
  const sharedApproval = hasPushApproval(selection, decisions);
  // 更早版本仅在操作记录中保存确认；无更新的人工决定时兼容读取。
  const legacyApproval = !selection && !latestPushDecision(decisions) && ledger.read().operations.some(item =>
    item.push_confirmed && item.sha === operation.sha && item.branch === operation.branch
    && item.target_branch === operation.target_branch);
  if (ownApproval || sharedApproval || legacyApproval) {
    operation.push_confirmed = true;
    if (paths) operation.push_paths = paths;
    ledger.update(operation);
    const waiting = host.summary.waiting;
    if (waiting?.step === HOST_PUSH_CONFIRM_STEP
        && (waiting.call_id === operation.id || waiting.waiting_id === operation.push_waiting_id)) {
      if (waiting.status === "waiting") host.humanGate.supersede(waiting.waiting_id, {
        stateVersion: waiting.state_version, notes: "已有推送确认，沿用决定继续推送" });
      host.summary.waiting = undefined;
      host.summary.status = "running";
      host.summary.detail = "沿用推送确认，正在推送";
    }
    host.persist();
    return true;
  }
  operation.push_confirmed = false;
  const waiting = host.summary.waiting;
  const samePending = waiting?.step === HOST_PUSH_CONFIRM_STEP
    && (waiting.call_id === operation.id || waiting.waiting_id === operation.push_waiting_id)
    && waiting.status === "waiting";
  if (samePending && (!operation.push_paths || (paths && samePaths(operation.push_paths, paths)))) {
    host.summary.status = "waiting_for_human";
    host.summary.detail = "等待确认本次推送";
    host.persist();
    return false;
  }
  if (samePending) host.humanGate.supersede(waiting.waiting_id, {
    stateVersion: waiting.state_version, notes: "交付文件范围发生变化，展示更新后的范围" });
  const revision = host.humanGate.all().filter(row => row.call_id.startsWith(`${operation.id}:`)).length;
  const callId = paths ? `${operation.id}:${pushReviewCallId({ head: snapshot.head, paths })}:${revision}` : operation.id;
  const manifest = await host.pushFiles(operation.branch!, snapshot.head);
  const files = manifest.files;
  const fileList = files ? deliveryFileList(files)
    : manifest.unavailable_reason ?? "本次推送清单暂不可读";
  assertActive();
  operation.push_paths = paths;
  operation.push_waiting_id = `${host.summary.id}:${callId}`;
  ledger.update(operation);
  host.summary.waiting = host.humanGate.createWaiting({
    taskId: host.summary.id, step: HOST_PUSH_CONFIRM_STEP, callId,
    questionInput: { questions: [{ question: `推送到 ${operation.branch}？`, options: ["确认推送", "先调整"] }],
      push_file_list: manifest, ...(files ? { delivery_files: files } : {}) },
    context: [operation.input.reason.slice(0, 500),
      `提交分支：${operation.branch} → ${operation.target_branch ?? "目标分支"}`,
      fileList,
      "推送当前已提交的改动。需要 Agent 修改代码时请选择「先调整」。未处理的意见保持原状。",
      PUSH_SCOPE_GUIDANCE].join("\n\n"),
  });
  host.summary.status = "waiting_for_human";
  host.summary.detail = "等待确认本次推送";
  host.persist(); host.notifyWaiting();
  return false;
}
