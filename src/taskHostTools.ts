import { collectOwnerInstructions, submittedReviewInputs, readMrDiscussionInputs, latestInstructionsText, projectOwnerInstructions, DECISION_SYNC_GUIDANCE, type OwnerInstruction } from "./ownerDecisionContext.ts";
import type { WaitingRecord } from "./humanGate.ts";
import { observedPipelineRun, historicalPipelineFeedback, projectPushReceipt, validPushReceipt } from "./pipelineHandoff.ts";
import { remainingCiMission } from "./ciMission.ts";
import { canHandoffReview, REVIEW_MISSION_END } from "./reviewHandoff.ts";
import { scopePipelineArtifacts } from "./pipelineArtifactScope.ts";
import { pushWithFreshBranch, RemoteBranchBusyError } from "./pushRace.ts";
/** Task-scoped host tools. Transport operations are handed off at a turn boundary,
 * so the existing single-writer Git/container contract also covers Agent requests. */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { runSafeWorktreeGit } from "./safeGit.ts";
import { assertTaskReadRoot } from "./taskHostDiagnostics.ts";
import type { TaskSummary } from "./taskService.ts";
import type { Annotation } from "./annotations.ts";
import { deliveryChangeSnapshot } from "./artifacts.ts";
import { FeedbackStore } from "./feedbackStore.ts";
import { listBusinessModules, readBusinessKnowledgeAsset } from "./businessModuleLibrary.ts";
import { getPipelineStatus, triggerPipeline, type PipelineCredential, type PipelineRun } from "./pipelineClient.ts";
import { captureOriginalMr } from "./taskFinalMr.ts";
import { createMergeRequest } from "./mrClient.ts";
import { mrParticipantsMessage, type MrParticipants, type MrParticipantsResult } from "./mrParticipants.ts";
import { controlKernelFeedback, attestKernelHost, type KernelDeliveryHost } from "./kernelDelivery.ts";

const HOST_ACTIONS = ["set_target", "defer_feedback", "push", "create_mr", "retry_verification", "sync_branch", "pull_repo", "trigger_pipeline", "stop_verification", "restart_session"] as const;
export type HostAction = typeof HOST_ACTIONS[number] | "restore_delivery_paths"; // 仅兼容旧的已排队操作
export interface HostRequest {
  action: HostAction;
  reason: string;
  request_id?: string;
  target?: string;
  feedback_id?: string;
  paths?: string[];
  repo?: string;
}
export interface HostOperation {
  id: string;
  input: HostRequest;
  state: "queued" | "running" | "succeeded" | "failed";
  at: string;
  sha?: string;
  branch?: string;
  target_branch?: string;
  result?: string;
  push_confirmed?: boolean;
  /** 待确认卡的展示快照；确认后文件增减不撤销推送决定。 */
  push_paths?: string[];
  push_waiting_id?: string;
  review_handoff?: boolean;
  push_receipt?: NonNullable<NonNullable<TaskSummary["delivery"]>["git_push"]>;
  mr_receipt?: { url: string; id?: string | number; participants?: MrParticipantsResult };
  trigger_started?: boolean;
  pipeline_receipt?: PipelineRun;
}
type Instruction = OwnerInstruction;
interface Ledger { instructions: Instruction[]; operations: HostOperation[] }

/** This ledger is outside the Agent's mounted task directory. It records host
 * execution, not a second workflow or a shadow copy of Kernel feedback status. */
export class TaskHostLedger {
  readonly path: string;
  constructor(summary: Pick<TaskSummary, "workspace" | "id">) {
    const key = createHash("sha256").update(`${summary.workspace}\0${summary.id}`).digest("hex");
    this.path = join(dirname(summary.workspace), ".host-operations", `${key}.json`);
  }
  read(): Ledger {
    if (!existsSync(this.path)) return { instructions: [], operations: [] };
    if (!lstatSync(this.path).isFile() || lstatSync(this.path).isSymbolicLink()) throw new Error("宿主操作记录不是普通文件");
    const data = JSON.parse(readFileSync(this.path, "utf8"));
    if (!Array.isArray(data.instructions) || !Array.isArray(data.operations)) throw new Error("宿主操作记录损坏");
    return data;
  }
  write(data: Ledger): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (lstatSync(dirname(this.path)).isSymbolicLink()) throw new Error("宿主操作记录目录不能是软链接");
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.path);
  }
  pending(): HostOperation | undefined {
    return this.read().operations.find(op => op.state === "queued" || op.state === "running");
  }
  update(operation: HostOperation): void {
    const data = this.read();
    const index = data.operations.findIndex(op => op.id === operation.id);
    if (index < 0) data.operations.push(operation); else data.operations[index] = operation;
    this.write(data);
  }
}

export function recordTaskHostInstruction(summary: TaskSummary, text: string, actor?: string): string | undefined {
  const owner = summary.luban_account ?? "本地用户";
  const isOwner = (actor ?? "本地用户") === owner;
  const ledger = new TaskHostLedger(summary), data = ledger.read();
  const id = randomUUID();
  data.instructions.push({ id, actor: actor ?? "本地用户", text, at: new Date().toISOString(), source: isOwner ? "message" : "collaboration" });
  ledger.write(data);
  return isOwner ? id : undefined; // 协作者原话可读，但不能取得责任人操作授权。
}

/** 恢复“远端收据已落盘、任务投影未落盘”的窗口；完成后的旧操作不能覆盖更新的正常推送。 */
export function recoverHostPushProjection(summary: TaskSummary): boolean {
  if (["completed", "canceled"].includes(summary.status)) return false;
  const ledger = new TaskHostLedger(summary);
  const pending = ledger.pending();
  const receipt = [pending?.push_receipt, summary.delivery?.git_push,
    ...ledger.read().operations.slice().reverse().map(op => op.push_receipt)].find(validPushReceipt);
  if (!receipt) return false;
  scopePipelineArtifacts(join(summary.workspace, "pipeline"), receipt.sha);
  if (summary.delivery?.sha === receipt.sha && summary.delivery.git_push?.sha === receipt.sha) return false;
  projectPushReceipt(summary, receipt);
  return true;
}

export interface TaskHostRuntime {
  summary: TaskSummary;
  cwd?: string;
  dataDir: string;
  kernel?: KernelDeliveryHost;
  platformUrl?: string;
  credential?: PipelineCredential;
  mrParticipants?(): MrParticipants | undefined;
  assertActive(): void;
  annotations(): Annotation[];
  decisions?(): WaitingRecord[];
  related(): unknown;
  gates(): Promise<unknown>;
  /** 纯 CI 使命已发布修复版本时直接交给宿主验证，保留其他人工目标。 */
  resumePipelineAfterPush?: (sha: string) => boolean;
  recordPublishedPush?: (receipt: NonNullable<NonNullable<TaskSummary["delivery"]>["git_push"]>) => void;
  reviews?(): Promise<unknown>;
  reply(id: string, revision: number, outcome: "fixed" | "not_fixed" | "needs_clarification", summary: string, evidence: string[]): void;
  release(action?: HostAction): Promise<void>;
  persist(): void;
  resume(message: string, target?: string, operation?: HostOperation): void;
  fail?(message: string): void;
  stopVerification?(): Promise<void>;
  diagnostics?(): Promise<string>;
  document?(taskId: string, artifact: string): Promise<string | undefined>;
  activeFeedback?(): { batchId: string; items: any[]; path: string } | undefined;
  allowPush(): Promise<boolean>;
  confirmPush?(operation: HostOperation): Promise<boolean>;
  preparePush?(operation: HostOperation): Promise<void>;
  finishReviewAfterPush?(operation: HostOperation): Promise<boolean>;
  /** 缺少已确认 AR 描述时举起现有填写卡，返回 undefined 暂停本操作。 */
  mrTitle?(operation: HostOperation): string | undefined;
  push(branch: string, sha: string): Promise<NonNullable<NonNullable<TaskSummary["delivery"]>["git_push"]>>;
  verify(): Promise<unknown>;
  watch(createdMr?: boolean): void;
  /** 已到交付等待点且尚无 MR 时，true 表示宿主接续创建 MR，不再唤醒 Agent。 */
  watchPush?(): boolean | void;
  /** false 表示仅记录提前验证，调用者继续原目标；true/旧接口 void 表示交付接管。 */
  acceptPipeline(sha: string, run?: PipelineRun): Promise<boolean | void>;
  syncFeedback(): void;
  syncBranch?(branch: string, target: string): Promise<string>;
  cloneReference?(url: string): Promise<string>;
  collaborate?(text: string): Promise<unknown>;
  deferAnnotation?(id: string, revision: number, actor: string, reason: string): void;
}

function kernelState(host: Pick<TaskHostRuntime, "cwd">): Record<string, any> {
  if (!host.cwd) throw new Error("当前任务没有代码现场");
  const path = join(host.cwd, ".mae-flow.json");
  assertTaskReadRoot(host.cwd, path);
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error("内核现场不是普通文件");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Only the authenticated loop is used to suppress scheduling. Missing or
 * unavailable evidence is not equivalent to "everything was deferred". */
export function taskDeferredFeedback(host: Pick<TaskHostRuntime, "cwd" | "kernel">): Record<string, any> {
  if (!host.cwd || !host.kernel) return {};
  const path = join(host.cwd, ".mae-flow.json");
  if (!existsSync(path)) return {};
  const state = kernelState(host);
  if (!state.delivery_loop?.deferred_feedback) return {};
  if (!attestKernelHost({ host: host.kernel, cwd: host.cwd, state, feedbackLoop: true }).feedbackLoop) {
    throw new Error("目标调整的内核记录尚未通过宿主收据核对");
  }
  return state.delivery_loop.deferred_feedback;
}

function ownerInstruction(host: TaskHostRuntime, id?: string): Instruction {
  if (!id) throw new Error("需要提供 task_context 中的责任人指令编号；已有指令无需重复询问");
  const owner = host.summary.luban_account ?? "本地用户";
  const instruction = id === "requirement"
    ? { id, actor: owner, text: host.summary.requirement, at: host.summary.created_at }
    : taskOwnerInstructions(host).find(row => row.id === id);
  if (!instruction || instruction.actor !== owner || ["cross_repository_update", "mr_discussion", "context_unavailable"].includes(instruction.source ?? "")) throw new Error("未找到对应的责任人原始指令");
  return instruction;
}

function safeMessage(host: TaskHostRuntime, value: unknown, limit = 8000): string {
  let text = value instanceof Error ? value.message : String(value);
  if (host.credential?.password) text = text.split(host.credential.password).join("[凭据已隐藏]");
  return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[凭据已隐藏]@").slice(0, limit);
}

export async function queueTaskHostOperation(host: TaskHostRuntime, id: string, input: HostRequest): Promise<HostOperation> {
  host.assertActive();
  if (input.action !== "restore_delivery_paths" && !HOST_ACTIONS.includes(input.action)) throw new Error("未知的宿主操作");
  const ledger = new TaskHostLedger(host.summary);
  const existing = ledger.read().operations.find(op => op.id === id);
  if (existing) {
    if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error("同一次工具调用不能更换操作参数");
    return existing;
  }
  if (!input.reason.trim()) throw new Error("请说明本次操作的目的");
  if (input.action === "stop_verification" && !host.stopVerification) throw new Error("当前部署未提供验证停止接口");
  if (input.action === "sync_branch" && !host.syncBranch) throw new Error("当前部署未提供分支同步能力");
  if (input.action === "pull_repo") {
    if (!host.cloneReference || !input.repo) throw new Error("缺少关联仓地址或当前部署未提供拉仓能力");
    const known = new Set([host.summary.repo_url, ...(host.summary.repositories ?? []),
      ...listBusinessModules(host.dataDir).modules.filter(m => m.status === "active").flatMap(m => m.repositories)]);
    const instruction = input.request_id ? ownerInstruction(host, input.request_id) : undefined;
    if (!known.has(input.repo) && !instruction?.text.includes(input.repo)) throw new Error("该仓尚未关联到本任务；请引用责任人提供此仓地址的原始指令");
  }
  if (["set_target", "defer_feedback"].includes(input.action)) {
    ownerInstruction(host, input.request_id);
    if (!input.target?.trim()) throw new Error("请明确调整后的目标");
    if (!host.kernel || !host.cwd) throw new Error("当前任务尚无可登记目标调整的内核现场");
    if (input.action === "defer_feedback" && !input.feedback_id) throw new Error("请指定一条反馈的完整 ID，不能批量忽略");
  }
  const operation: HostOperation = { id, input, state: "queued", at: new Date().toISOString() };
  if (input.action === "push" || input.action === "create_mr" || input.action === "sync_branch") {
    const state = kernelState(host);
    const branch = String(state.config?.["分支名"] ?? ""), baseline = String(host.summary.delivery?.target_branch ?? host.summary.baseline ?? state.config?.["基线分支"] ?? "");
    const current = String(runSafeWorktreeGit(host.cwd!, ["branch", "--show-current"], { timeoutMs: 10000 }).stdout ?? "").trim();
    const boundBranch = host.summary.delivery?.source_branch
      ?? ledger.read().operations.find(op => op.branch)?.branch;
    const baselines = new Set([baseline, host.summary.baseline, host.summary.delivery?.target_branch].filter(Boolean));
    if (!branch || !baseline || baselines.has(branch) || current !== branch
      || (boundBranch && boundBranch !== branch)) throw new Error("只能发布当前任务已绑定的工作分支");
    const snapshot = await deliveryChangeSnapshot(host.cwd!);
    if (!snapshot) throw new Error("无法确定本次提交 SHA");
    operation.sha = snapshot.head;
    operation.branch = branch;
    operation.target_branch = baseline;
  }
  if (input.action === "trigger_pipeline") {
    operation.sha = host.summary.delivery?.git_push?.sha ?? host.summary.delivery?.sha;
    if (!operation.sha || !host.platformUrl) throw new Error("尚无已推送提交或未配置流水线平台");
  }
  // Snapshot reading yields. Recheck both ownership and the queue before writing.
  host.assertActive();
  if (ledger.pending()) throw new Error("已有宿主操作排队；请结束本轮让它执行，再根据结果继续");
  ledger.update(operation);
  return operation;
}

/** Runs only after the model turn has finished. It never waits for its own tool
 * call, and recovery can replay a running record using its pinned SHA/op ID. */
/** 成功收据只结束旧推送调整指令；其他目标、失败与会话重建仍保留原使命。 */
export function hostResumeMission(mission: string | undefined, message: string, target?: string, operation?: HostOperation, summary?: TaskSummary): string {
  if (!target && summary && canHandoffReview(mission, summary)) {
    // 机械执行结果属于本轮上下文，不是用户追加目标；分次推送后仍可自动交接。
    return `${mission!.slice(0, mission!.lastIndexOf(REVIEW_MISSION_END)).trimEnd()}\n\n${message}\n\n${REVIEW_MISSION_END}`;
  }
  if (summary && operation?.state === "succeeded"
      && ((operation.input.action === "push" && operation.push_receipt) || operation.input.action === "trigger_pipeline"))
    mission = remainingCiMission(mission, summary);
  const completedAdjustment = operation?.input.action === "push" && operation.state === "succeeded"
    && !!operation.push_receipt && mission?.startsWith("用户要求调整推送，请整理后重新发起：");
  return [target ? `[责任人调整后的目标]\n${target}\n不再执行已暂缓事项。`
    : completedAdjustment ? "本次推送已成功，先前的推送调整指令已结束；依据责任人最新要求继续，不要重新询问旧的‘先调整’。" : mission,
    message].filter(Boolean).join("\n\n");
}

export async function finishTaskHostOperation(host: TaskHostRuntime): Promise<boolean> {
  try { return await executeTaskHostOperation(host); }
  catch (error) {
    // The handoff can change controlEpoch. Never return errors to the caller's
    // obsolete epoch, where they would be discarded and leave an orphan task.
    try { host.assertActive(); host.fail?.(`宿主操作未完成：${safeMessage(host, error)}`); } catch { /* Cancellation wins. */ }
    return true;
  }
}

async function executeTaskHostOperation(host: TaskHostRuntime): Promise<boolean> {
  const ledger = new TaskHostLedger(host.summary), operation = ledger.pending();
  if (!operation) {
    const loop = host.summary.delivery?.loop;
    const latest = ledger.read().operations.at(-1);
    if (latest?.input.action === "push" && latest.state === "succeeded" && latest.push_receipt
        && latest.sha === host.summary.delivery?.git_push?.sha && host.platformUrl
        && host.resumePipelineAfterPush?.(latest.sha!)) {
      host.assertActive(); await host.release();
      if (!await verifyPublishedCi(host, latest, ledger)) host.resume("流水线监听已恢复，继续当前目标。", undefined, latest);
      return true;
    }
    if (loop?.kind !== "ci" || loop.state !== "repairing"
        || latest?.input.action !== "trigger_pipeline" || latest.state !== "succeeded"
        || !latest.sha || latest.sha === loop.last_sha
        || latest.sha !== host.summary.delivery?.git_push?.sha
        || (host.resumePipelineAfterPush && !host.resumePipelineAfterPush(latest.sha))) return false;
    host.assertActive();
    await host.release();
    const response = await getPipelineStatus({ platformUrl: host.platformUrl!, sha: latest.sha,
      repo: host.summary.repo_url, mr: host.summary.delivery?.mr_id === undefined ? undefined : String(host.summary.delivery.mr_id), credential: host.credential });
    host.assertActive();
    const handedOff = await host.acceptPipeline(latest.sha, observedPipelineRun(latest.sha, response));
    if (handedOff === false) host.resume("已恢复流水线监听，继续当前目标。", undefined, latest);
    return true;
  }
  host.assertActive();
  try {
    if (operation.input.action === "stop_verification") await host.stopVerification?.();
    await host.release(operation.input.action);
    host.assertActive();
  } catch (error) {
    operation.result = safeMessage(host, error);
    ledger.update(operation);
    try { host.assertActive(); host.fail?.(`宿主交接未完成：${operation.result}`); } catch { /* New owner owns recovery. */ }
    return true;
  }
  operation.state = "running";
  ledger.update(operation);
  let target: string | undefined;
  try {
    const input = operation.input;
    if (input.action === "set_target" || input.action === "defer_feedback") {
      const instruction = ownerInstruction(host, input.request_id);
      const feedback = input.feedback_id ? new FeedbackStore(join(host.summary.workspace, "feedback", "index.jsonl")).list().find(row => row.id === input.feedback_id) : undefined;
      if (feedback?.source === "workspace") {
        const annotation = host.annotations().find(row => row.id === feedback.source_id);
        if (!annotation || (annotation.rework ?? 0) !== feedback.source_revision) throw new Error("意见已换版本，请读取当前反馈后再决定");
      }
      controlKernelFeedback({ host: host.kernel!, cwd: host.cwd!, workspace: host.summary.workspace,
        taskId: host.summary.id, operationId: operation.id, target: input.target!,
        actor: instruction.actor, requestId: instruction.id,
        reason: `${input.reason.slice(0, 1000)}\n责任人原话摘要（完整消息见指令 ${instruction.id}）：${instruction.text.slice(0, 2800)}`,
        ...(input.action === "defer_feedback" ? { feedbackId: input.feedback_id } : {}) });
      target = input.target;
      host.syncFeedback();
      if (feedback?.source === "workspace") host.deferAnnotation?.(feedback.source_id, feedback.source_revision, instruction.actor, input.reason);
      operation.result = `当前目标：${target}。${input.feedback_id ? `已暂缓 ${input.feedback_id} 的自动修复；原失败和意见仍保留。` : "未取消其他反馈。"}`;
    } else if (input.action === "restore_delivery_paths") {
      operation.result = "文件勾选机制已取消，无需恢复清单，可直接继续修复和提交。";
    } else if (input.action === "push") {
      const allowed = async () => {
        if (await host.allowPush()) return true;
        operation.state = "failed";
        operation.result = host.summary.delivery?.waiting_on ?? host.summary.delivery?.stalled
          ?? host.summary.detail ?? "远端交付状态尚未确认，未推送";
        ledger.update(operation);
        // MR 关闭、人工等待或网络恢复已有明确去处，不能再唤醒 Agent 猜原因。
        return false;
      };
      const prepare = async () => {
        if (!await allowed()) return false;
        if (host.preparePush) { await host.preparePush(operation); host.assertActive(); ledger.update(operation); }
        return !host.confirmPush || await host.confirmPush(operation);
      };
      if (!operation.push_receipt && !await prepare()) return true;
      const receipt = operation.push_receipt ?? await pushWithFreshBranch(async () => {
        if (!await allowed()) return undefined;
        host.assertActive(); return host.push(operation.branch!, operation.sha!);
      }, prepare);
      if (!receipt) return true;
      // Save the remote fact before updating the task projection. A retry of a
      // partially persisted result must not repeat a transport operation.
      operation.push_receipt = receipt;
      operation.sha = receipt.sha;
      ledger.update(operation);
      // Persist the transport fact even when cancellation races the response.
      projectPushReceipt(host.summary, receipt);
      host.persist();
      scopePipelineArtifacts(join(host.summary.workspace, "pipeline"), receipt.sha);
      host.recordPublishedPush?.(receipt);
      operation.result = `已确认提交 ${receipt.sha} 已发布到远端 ${receipt.ref}。当前验证目标已同步到本次提交；旧失败保留在历史，不能用于判定新提交，推送本身不表示验证通过或反馈闭环；未提交改动不包含在内。`;
      host.assertActive();
      if (await host.finishReviewAfterPush?.(operation)) {
        const handedOff = await verifyPublishedCi(host, operation, ledger);
        operation.state = "succeeded"; ledger.update(operation);
        if (!handedOff) host.resume("检视修改已推送，流水线继续监听；按新增要求继续。", undefined, operation);
        return true;
      }
      if (host.platformUrl && host.resumePipelineAfterPush?.(receipt.sha)) {
        const handedOff = await verifyPublishedCi(host, operation, ledger);
        operation.state = "succeeded"; ledger.update(operation);
        if (handedOff) return true;
      }
      if (host.watchPush?.()) {
        operation.state = "succeeded"; ledger.update(operation);
        return true;
      }
    } else if (input.action === "create_mr") {
      if (!host.platformUrl) throw new Error("未配置 MR 平台");
      const createdMr = !host.summary.delivery?.mr_url && !operation.mr_receipt;
      if (host.summary.delivery?.mr_url) {
        operation.result = `已存在 MR：${host.summary.delivery.mr_url}。${mrParticipantsMessage(host.summary.delivery.mr_participants)}`;
      } else {
        if (host.summary.delivery?.git_push?.sha !== operation.sha) throw new Error("当前提交尚未取得真实推送收据，请先推送");
        if (!operation.target_branch) throw new Error("旧操作缺少固定的 MR 目标分支，请重新发起创建 MR");
        const title = operation.mr_receipt ? undefined : host.mrTitle?.(operation);
        if (!operation.mr_receipt && !title) {
          if (!host.mrTitle) throw new Error("缺少 AR 描述确认入口，不能以任务标题代替");
          return true;
        }
        const receipt = operation.mr_receipt ?? await createMergeRequest({ platformUrl: host.platformUrl,
          repo: host.summary.repo_url, sourceBranch: operation.branch!, targetBranch: operation.target_branch,
          title: title!, dtsNo: host.summary.ticket, credential: host.credential, participants: host.mrParticipants?.() });
        operation.mr_receipt = { url: receipt.url, id: receipt.id, participants: receipt.participants };
        ledger.update(operation);
        const initial = captureOriginalMr(host.summary, receipt.url, operation.sha!);
        host.assertActive();
        host.summary.delivery = { ...host.summary.delivery, initial_mr: initial, mr_url: receipt.url, mr_id: receipt.id, mr_participants: receipt.participants,
          source_branch: operation.branch, target_branch: operation.target_branch };
        host.persist();
        operation.result = `已创建 MR：${receipt.url}；${mrParticipantsMessage(receipt.participants)}未宣告验证通过或任务完成。`;
      }
      host.watch(createdMr);
    } else if (input.action === "sync_branch") {
      operation.result = await host.syncBranch!(operation.branch!, operation.target_branch!);
    } else if (input.action === "pull_repo") {
      operation.result = `关联仓已就绪：${await host.cloneReference!(input.repo!)}。用于本任务分析，不改变交付仓或分支。`;
    } else if (input.action === "trigger_pipeline") {
      const call = { platformUrl: host.platformUrl!, sha: operation.sha!, repo: host.summary.repo_url, mr: host.summary.delivery?.mr_id === undefined ? undefined : String(host.summary.delivery.mr_id), credential: host.credential };
      if (!operation.pipeline_receipt) {
        const recovering = operation.trigger_started;
        operation.trigger_started = true;
        ledger.update(operation);
        let response;
        try { response = recovering ? await getPipelineStatus(call) : await triggerPipeline(call); }
        catch (error) {
          host.assertActive();
          operation.result = `流水线请求结果尚未核实：${safeMessage(host, error)}。宿主继续查询该 SHA，不重复触发。`;
          operation.state = "failed"; ledger.update(operation);
          const handedOff = await host.acceptPipeline(operation.sha!, undefined);
          host.summary.delivery = { ...host.summary.delivery, pipeline: "查询失败，正在重试" }; host.persist();
          if (handedOff === false) {
            operation.result += EARLY_PIPELINE_CONTINUATION;
            ledger.update(operation);
            host.resume(operation.result, undefined, operation);
          }
          return true;
        }
        host.assertActive();
        operation.pipeline_receipt = observedPipelineRun(operation.sha!, response);
        ledger.update(operation);
      }
      operation.result = `流水线结果（${operation.sha}）：${safeMessage(host, JSON.stringify(operation.pipeline_receipt))}。宿主监听本次提交，旧 SHA 告警仅作历史。`;
      if (!operation.pipeline_receipt) operation.result = `已查询提交 ${operation.sha}，尚未发现有效流水线；宿主将继续监听。推送不保证自动触发，MR 尚未创建时可按需要创建 MR。`;
      const handedOff = await host.acceptPipeline(operation.sha!, operation.pipeline_receipt);
      if (handedOff === false) operation.result += EARLY_PIPELINE_CONTINUATION;
      operation.state = "succeeded";
      ledger.update(operation);
      if (handedOff !== false) return true; // 正式验证接管；提前验证则继续走下方同一目标续接。
    } else if (input.action === "stop_verification") {
      operation.result = "验证已停止；未跳过测试、未推送，按当前要求继续。";
    } else if (input.action === "restart_session") {
      operation.result = "旧会话和容器已释放，使用原仓库、当前目标和历史记录重建会话；未重置代码或重新初始化流程。";
    } else {
      operation.result = `验证执行结果：${JSON.stringify(await host.verify())}`;
    }
    operation.state = "succeeded";
  } catch (error) {
    if (operation.push_receipt || operation.mr_receipt || operation.trigger_started) {
      operation.result = operation.push_receipt || operation.mr_receipt || operation.pipeline_receipt
        ? `远端操作已有收据，本地状态更新未完成：${safeMessage(host, error)}`
        : `流水线触发或状态核对未完成，重试将先查询本次 SHA，不重开旧修复：${safeMessage(host, error)}`;
      ledger.update(operation);
      try { host.assertActive(); host.fail?.(operation.result); } catch { /* Do not revive a canceled task. */ }
      return true;
    }
    operation.state = "failed";
    operation.result = safeMessage(host, error);
    if (error instanceof RemoteBranchBusyError) {
      ledger.update(operation); host.fail?.(operation.result); return true;
    }
  }
  ledger.update(operation);
  // 范围整理已明确停下时保留诊断，不再派 Agent 重试同一次推送。
  if (operation.input.action === "push" && operation.state === "failed"
      && host.summary.status === "failed") return true;
  // A canceled/taken-over task retains receipts but must never resume itself.
  try { host.assertActive(); } catch { return true; }
  try { host.resume(`[宿主操作 ${operation.id} ${operation.state}]\n${operation.result}\n按当前目标继续；失败不代表旧问题已通过。`, target, operation); }
  catch (error) { host.fail?.(`宿主操作已记账，但会话续接失败：${safeMessage(host, error)}`); }
  return true;
}

async function verifyPublishedCi(host: TaskHostRuntime, operation: HostOperation, ledger: TaskHostLedger): Promise<boolean> {
  const sha = operation.push_receipt!.sha;
  const call = { platformUrl: host.platformUrl!, sha, repo: host.summary.repo_url,
    mr: host.summary.delivery?.mr_id === undefined ? undefined : String(host.summary.delivery.mr_id), credential: host.credential };
  host.assertActive();
  // 先查同 SHA，已有运行不重复触发；触发响应丢失时只查询，不重启旧修复。
  let queryError: unknown;
  const observed = await getPipelineStatus(call).catch(error => { queryError = error; return undefined; });
  host.assertActive();
  operation.pipeline_receipt = observed && observedPipelineRun(sha, observed);
  if (observed && !operation.pipeline_receipt && !operation.trigger_started) {
    operation.trigger_started = true; ledger.update(operation);
    const triggered = await triggerPipeline(call).catch(error => { queryError = error; return undefined; });
    operation.pipeline_receipt = triggered && observedPipelineRun(sha, triggered);
  }
  host.assertActive(); ledger.update(operation);
  const handedOff = (await host.acceptPipeline(sha, operation.pipeline_receipt)) !== false;
  if (queryError) {
    host.assertActive();
    operation.result = `${operation.result ?? "推送已核实"} 流水线请求尚未核实：${safeMessage(host, queryError)}，继续查询，不重复推送或触发。`;
    ledger.update(operation);
    host.summary.delivery = { ...host.summary.delivery, pipeline: "查询失败，正在重试" }; host.persist();
  }
  return handedOff;
}

function feedback(host: TaskHostRuntime) {
  const deferred = taskDeferredFeedback(host);
  return { feedback: new FeedbackStore(join(host.summary.workspace, "feedback", "index.jsonl")).list()
    .map(row => ({ ...row, scheduling: row.status === "closed" ? "closed"
      : ["superseded", "superseded_by_merge"].includes(row.status) ? "historical"
      : deferred[row.id] ? "deferred" : historicalPipelineFeedback(host.summary, row) ? "historical" : "active", defer_reason: deferred[row.id]?.reason })),
  annotations: host.annotations() };
}

export function deferredAnnotationIds(host: Pick<TaskHostRuntime, "cwd" | "kernel" | "summary">): Set<string> {
  const deferred = taskDeferredFeedback(host);
  const rows = new FeedbackStore(join(host.summary.workspace, "feedback", "index.jsonl")).list();
  return new Set(rows.filter(row => deferred[row.id] && row.source === "workspace")
    .map(row => `${row.source_id}:r${row.source_revision}`));
}

export function deferredPipeline(host: Pick<TaskHostRuntime, "cwd" | "kernel" | "summary">, sha: string): boolean {
  const deferred = taskDeferredFeedback(host);
  const rows = new FeedbackStore(join(host.summary.workspace, "feedback", "index.jsonl")).list()
    .filter(row => row.source === "pipeline" && row.source_id.startsWith(`${sha}:`));
  return rows.length > 0 && rows.every(row => Boolean(deferred[row.id]));
}

export function deferredSourceVersions(host: Pick<TaskHostRuntime, "cwd" | "kernel" | "summary">, source: string): Set<string> {
  const deferred = taskDeferredFeedback(host);
  return new Set(new FeedbackStore(join(host.summary.workspace, "feedback", "index.jsonl")).list()
    .filter(row => row.source === source && deferred[row.id])
    .map(row => `${row.source_id}:r${row.source_revision}`));
}

export function taskOwnerInstructions(host: TaskHostRuntime): OwnerInstruction[] {
  const owner = host.summary.luban_account ?? "本地用户";
  return [...collectOwnerInstructions(owner,
    [{ id: "requirement", actor: owner, text: host.summary.requirement, at: host.summary.created_at ?? "" },
      ...new TaskHostLedger(host.summary).read().instructions], host.decisions?.() ?? []),
    ...submittedReviewInputs(host.annotations()), ...readMrDiscussionInputs(host.summary.workspace),
    ...(host.summary.cross_repository_updates ?? []).map(update => ({ id: update.id, actor: update.author,
      at: update.created_at, source: "cross_repository_update",
      text: `需求协作通知，来自 ${update.source_task_id}：${update.text}\n按原文判断对本任务的影响，不自动成为本任务责任人的授权。` }))]
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function refreshOwnerInputProjection(host: TaskHostRuntime): string {
  return projectOwnerInstructions(host.cwd, host.summary.id, taskOwnerInstructions(host));
}

export function taskHostGoal(host: TaskHostRuntime): string {
  const recent = new TaskHostLedger(host.summary).read().operations.slice(-5)
    .map(op => `${op.id} (${op.input.action}) ${op.state}: ${op.result ?? "尚无执行结果"}`).join("\n");
  const verification = host.summary.delivery?.loop?.kind === "ci" && host.summary.delivery.loop.state === "verifying"
    ? `当前正在验证提交 ${host.summary.delivery.sha}；旧 SHA 失败只作历史，不能据此重复修复。流水线的新结果由宿主监听，完成其他明确要求后结束本轮。` : "";
  const inputs = taskOwnerInstructions(host);
  const operations = [DECISION_SYNC_GUIDANCE, latestInstructionsText(inputs),
    projectOwnerInstructions(host.cwd, host.summary.id, inputs), verification, recent ? `[最近宿主操作，按记录核对结果]\n${recent}` : ""].filter(Boolean).join("\n");
  if (!host.cwd || !host.kernel || !existsSync(join(host.cwd, ".mae-flow.json"))) return operations;
  const state = kernelState(host);
  const target = state.delivery_loop?.target;
  if (!target) return operations;
  if (!attestKernelHost({ host: host.kernel, cwd: host.cwd, state, feedbackLoop: true }).feedbackLoop) throw new Error("当前目标记录未通过宿主收据核对");
  const source = inputs.findIndex(row => row.id === target.request_id);
  const newer = source < 0 || source < inputs.length - 1;
  return `${operations}\n[${newer ? "先前执行目标，需结合后续答复判断是否仍适用" : "执行目标摘要，不替代需求决定"}] ${target.target}\n来源指令：${target.request_id}；这是 Agent 登记的概括，不能据此重新解释用户原话。无关目标可保留，明确被新答复推翻的内容先同步文档再实施。已暂缓的反馈不自动恢复。`;
}

const GUIDANCE = DECISION_SYNC_GUIDANCE + " 原始答复可用 task_context(view=instructions, keyword=来源编号) 查询。" + "任务内已有授权贯穿宿主操作，不因工作阶段重复确认。先查 task_context 了解真实现场；代码编辑、提交、编译和 UT 继续使用任务容器的文件/Bash 工具。基线预热保留，但最终交付不自动补跑 Build-Fix；过程中可以自主编译和执行 UT，无需等待审批；按改动影响选择验证范围，记录命令、范围、版本和结果。独立 Build-Fix 仅在需要时用 retry_verification 主动请求，预热成功不代表改动验证通过。需要平台能力时直接调用宿主工具。文件勾选机制已取消，旧清单不限制当前任务，不需要恢复路径或扩大范围。责任人改变目标后用 task_control 登记，不能只口头答应；只有明确放弃或延期的条目才 defer_feedback。宿主操作返回 queued 后结束本轮，让平台执行；普通操作完成后沿用原会话，只需处理返回结果和受影响的内容，不要重新熟悉整个任务；queued 不等于成功。不要读取令牌或修改平台控制文件。";

const EARLY_PIPELINE_CONTINUATION = "提前验证由宿主在后台监听，继续按 current 完成当前步骤；build 的实现、自检和提交完成后执行 done，流水线通过不是 build done 的前提。到 current 明确的宿主等待点再结束回合等待。";

export function createTaskHostTools(host: TaskHostRuntime) {
  const reply = (value: unknown, error = false) => ({ content: [{ type: "text" as const,
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details: {}, isError: error });
  const guarded = async (run: () => unknown | Promise<unknown>) => {
    try {
      host.assertActive();
      const value = await run();
      return reply(safeMessage(host, typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "暂无记录", 128000));
    }
    catch (error) { return reply(safeMessage(host, error), true); }
  };
  return [
    defineTool({ name: "task_context", label: "任务现场", description: "随时查询任务、反馈、平台、关联任务、知识和宿主操作；不受阶段限制。", promptGuidelines: [GUIDANCE],
      parameters: Type.Object({ view: Type.Union(["overview", "instructions", "feedback", "platform", "related", "knowledge", "operations", "reviews"].map(value => Type.Literal(value))), keyword: Type.Optional(Type.String()) }),
      execute: async (_id: string, input: { view: string; keyword?: string }) => guarded(async () => {
        const ledger = new TaskHostLedger(host.summary).read();
        if (input.view === "instructions") return taskOwnerInstructions(host).filter(row => !input.keyword || `${row.id} ${row.text}`.includes(input.keyword));
        if (input.view === "feedback") return feedback(host);
        if (input.view === "platform") return host.gates();
        if (input.view === "reviews") return host.reviews ? host.reviews() : { unavailable: "未配置 MR 讨论读取接口" };
        if (input.view === "related") return host.related();
        if (input.view === "operations") return ledger.operations.slice(-30);
        if (input.view === "knowledge") return listBusinessModules(host.dataDir).modules
          .filter(module => module.status === "active" && (!input.keyword || `${module.name} ${module.description}`.toLowerCase().includes(input.keyword.toLowerCase())))
          .map(module => ({ id: module.id, name: module.name, description: module.description, repositories: module.repositories, assets: module.assets.filter(a => a.status === "published") }));
        if (input.view !== "overview") throw new Error("未知任务视图");
        return { task: host.summary.id, status: host.summary.status, detail: host.summary.detail,
          owner: host.summary.luban_account, delivery: { sha: host.summary.delivery?.sha, push: host.summary.delivery?.git_push,
            mr: host.summary.delivery?.mr_url, pipeline: host.summary.delivery?.pipeline, prepush: host.summary.delivery?.prepush?.state },
          instructions: taskOwnerInstructions(host).slice(-15),
          target: taskHostGoal(host), operations: ledger.operations.slice(-5),
          capabilities: { read: ["task_context", "task_pipeline", "task_knowledge", ...(host.document ? ["task_document"] : []), ...(host.diagnostics ? ["task_diagnostics"] : [])], control: HOST_ACTIONS,
            code_and_ut: "通过任务容器的文件/Bash 工具执行；Story、Spec、架构图均可按授权修订", feedback: ["task_feedback_reply", ...(host.activeFeedback ? ["task_feedback_result"] : [])],
            collaboration: host.collaborate ? "task_collaborate" : "未配置", acceptance: "责任人最终验收不由 Agent 代签",
            kernel_configured: Boolean(host.kernel), platform_configured: Boolean(host.platformUrl) } };
      }) }),
    defineTool({ name: "task_control", label: "任务宿主操作", description: GUIDANCE + " 每次 push 前（包括首次交付、检视意见修复和流水线修复后）都先提交本次有意交付的修改，再用 sync_branch 拉取并合并最新远端任务分支与目标分支，结束本轮等待宿主结果。有冲突时读取双方上下文、解决并提交，不要直接选 ours/theirs。同步后执行受影响的编译与 UT，再走原 push/MR 流程。按与最新目标分支的共同祖先核对 MR 净改动，不把从 master 等目标分支合入的代码算成本任务新增。编译前后对照 git status，区分源码和生成产物，按明确路径暂存，不用 git add . 夹带产物；不要删除或覆盖原有未提交修改，无法确认文件用途时向责任人说明并请求处理意见。MR 已报告冲突时主动按此处理，不等待流水线出现或失败。pull_repo 只克隆关联仓。",
      parameters: Type.Object({ action: Type.Union(HOST_ACTIONS.map(value => Type.Literal(value))),
        reason: Type.String(), request_id: Type.Optional(Type.String({ description: "目标变更所依据的责任人指令编号，来自 task_context" })),
        target: Type.Optional(Type.String()), repo: Type.Optional(Type.String({ description: "pull_repo 仅克隆关联仓供分析，不更新当前 MR 分支；当前分支用 sync_branch 同步。地址须来自任务或责任人指令" })), feedback_id: Type.Optional(Type.String({ description: "暂缓时指定一条完整反馈 ID，原样复制" })) }),
      execute: async (id: string, input: HostRequest) => guarded(async () => ({ ...await queueTaskHostOperation(host, id, input),
        next: "立即结束本轮，平台执行后会带结果继续。不要在 queued 时报告成功。" })) }),
    defineTool({ name: "task_pipeline", label: "流水线查询与触发", description: "查询本任务已推送提交的流水线状态和日志，或在已有交付授权下触发验证；不改变工作目标。" + EARLY_PIPELINE_CONTINUATION + "尚无运行记录不等于验证失败，不要反复触发或修复旧 SHA 告警。",
      parameters: Type.Object({ action: Type.Union([Type.Literal("status"), Type.Literal("trigger")]) }),
      execute: async (id: string, input: { action: string }) => guarded(async () => {
        const sha = host.summary.delivery?.git_push?.sha ?? host.summary.delivery?.sha;
        if (!sha || !host.platformUrl) throw new Error("尚无已推送提交或未配置流水线平台");
        const call = { platformUrl: host.platformUrl, sha, repo: host.summary.repo_url, mr: host.summary.delivery?.mr_id === undefined ? undefined : String(host.summary.delivery.mr_id), credential: host.credential };
        if (input.action === "status") {
          const run = observedPipelineRun(sha, await getPipelineStatus(call));
          return run ? { ...run, message: EARLY_PIPELINE_CONTINUATION }
            : { sha, status: "not_found", message: "尚未发现本次提交的有效流水线；不代表运行中或失败。" + EARLY_PIPELINE_CONTINUATION };
        }
        if (input.action !== "trigger") throw new Error("未知流水线操作");
        return { ...await queueTaskHostOperation(host, id, { action: "trigger_pipeline", reason: "触发当前已推送提交的流水线" }), next: "立即结束本轮，由宿主执行并带回结果；queued 不等于成功。" };
      }) }),
    defineTool({ name: "task_feedback_reply", label: "逐条反馈回执", description: "提交一条工作台意见的处理结果；填写原始 ID 与当前 revision，平台写结构化回执。fixed 表示 Agent 已修复，最终验收仍由责任人决定。",
      parameters: Type.Object({ annotation_id: Type.String(), revision: Type.Integer({ minimum: 0 }),
        outcome: Type.Union([Type.Literal("fixed"), Type.Literal("not_fixed"), Type.Literal("needs_clarification")]),
        summary: Type.String(), evidence: Type.Array(Type.String()) }),
      execute: async (_id: string, input: { annotation_id: string; revision: number; outcome: "fixed" | "not_fixed" | "needs_clarification"; summary: string; evidence: string[] }) => guarded(() => {
        host.reply(input.annotation_id, input.revision, input.outcome, input.summary, input.evidence);
        return "已记录这一条 Agent 处理结果，未代替责任人验收。";
      }) }),
    ...(host.document ? [defineTool({ name: "task_document", label: "读取任务设计材料",
      description: "读取当前或关联模块任务的 Story、Spec、设计和测试材料。返回行号，便于讨论职责与接口；不会改动其他任务。",
      parameters: Type.Object({ task_id: Type.Optional(Type.String()), artifact: Type.String(), start_line: Type.Optional(Type.Integer({ minimum: 1 })) }),
      execute: async (_id: string, input: { task_id?: string; artifact: string; start_line?: number }) => guarded(async () => {
        const body = await host.document!(input.task_id ?? host.summary.id, input.artifact);
        if (body === undefined) throw new Error("未找到该设计材料，可先查 task_context related 或使用 story.md、spec.md");
        const lines = body.split("\n"), start = input.start_line ?? 1;
        return { total_lines: lines.length, start_line: start, content: safeMessage(host, lines.slice(start - 1, start + 159).map((line, i) => `${start + i}: ${line}`).join("\n"), 24000) };
      }) })] : []),
    defineTool({ name: "task_knowledge", label: "读取模块知识",
      description: "读取 task_context knowledge 中发布的模块知识正文及版本，不要求重新圈选技能或退回分析阶段。",
      parameters: Type.Object({ module_id: Type.String(), asset_id: Type.String(), start_line: Type.Optional(Type.Integer({ minimum: 1 })) }),
      execute: async (_id: string, input: { module_id: string; asset_id: string; start_line?: number }) => guarded(() => {
        const module = listBusinessModules(host.dataDir).modules.find(m => m.id === input.module_id && m.status === "active");
        if (!module?.assets.some(a => a.id === input.asset_id && a.status === "published")) throw new Error("知识未发布或已归档");
        const doc = readBusinessKnowledgeAsset(host.dataDir, input.module_id, input.asset_id);
        const lines = doc.content.split("\n"), start = input.start_line ?? 1;
        return { module: doc.module_name, asset: doc.asset, total_lines: lines.length, start_line: start, content: lines.slice(start - 1, start + 159).join("\n") };
      }) }),
    ...(host.diagnostics ? [defineTool({ name: "task_diagnostics", label: "任务诊断",
      description: "采集当前任务的 Git、内核、容器及事件日志，供排查执行故障。只读取本任务，按字符分页；不开放任意宿主 Shell。",
      parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
      execute: async (_id: string, input: { offset?: number }) => guarded(async () => {
        const content = safeMessage(host, await host.diagnostics!(), 512000), offset = input.offset ?? 0;
        return { offset, total: content.length, content: content.slice(offset, offset + 20000) };
      }) })] : []),
    ...(host.activeFeedback ? [defineTool({ name: "task_feedback_result", label: "记录一条验证反馈的处理结果",
      description: "提交当前批次一条流水线、Build-Fix 等反馈的处理结果。ID 原样使用 task_context feedback 返回值，平台生成准确的回执文件，保留其他条目；这是处理结果，不宣告质量通过。工作台批注用 task_feedback_reply。",
      parameters: Type.Object({ feedback_id: Type.String(), status: Type.Union(["fixed", "explained", "needs_human", "not_applicable"].map(value => Type.Literal(value))), summary: Type.String(), evidence: Type.Optional(Type.String()) }),
      execute: async (_id: string, input: { feedback_id: string; status: string; summary: string; evidence?: string }) => guarded(() => writeTaskFeedbackResult(host, input)) })] : []),
    ...(host.collaborate ? [defineTool({ name: "task_collaborate", label: "同步模块协作信息",
      description: "根据责任人已有的协作要求，将接口约定或设计变更同步给关联模块任务；使用同一任务的协作通道，不修改别人的分工或替其确认。",
      parameters: Type.Object({ text: Type.String(), request_id: Type.String() }),
      execute: async (_id: string, input: { text: string; request_id: string }) => guarded(async () => {
        ownerInstruction(host, input.request_id);
        if (!input.text.trim()) throw new Error("协作消息不能为空");
        return host.collaborate!(input.text);
      }) })] : []),
  ];
}


/** Pure task-family check, shared by summary discovery and document access. */
export function relatedHostTask(task: TaskSummary, other: TaskSummary): boolean {
  return other.id === task.id || other.id === task.parent_task_id || other.parent_task_id === task.id
    || Boolean(task.parent_task_id && other.parent_task_id === task.parent_task_id);
}

export async function settleVerificationStop(active: Promise<unknown>, abort: () => void): Promise<void> {
  const closed = active.then(() => true, () => true), deadline = Date.now() + 60000;
  for (;;) {
    abort();
    if (await Promise.race([closed, new Promise<false>(resolve => setTimeout(() => resolve(false), 200))])) return;
    if (Date.now() >= deadline) throw new Error("验证执行未在 60 秒内确认停止；保留现场，请诊断后重试");
  }
}

export function writeTaskFeedbackResult(host: TaskHostRuntime, input: { feedback_id: string; status: string; summary: string; evidence?: string }): string {
  const active = host.activeFeedback?.(), item = active?.items.find(item => item.id === input.feedback_id);
  if (!active || !item) throw new Error("反馈不属于当前活动批次，请读取 task_context feedback 后使用完整 ID");
  if (item.source === "workspace" || item.source === "mr_discussion") throw new Error("工作台批注使用 task_feedback_reply；MR 意见按任务给出的 review_replies.md 逐条准备回复");
  if (!["fixed", "explained", "needs_human", "not_applicable"].includes(input.status) || !input.summary.trim() || input.summary.length > 4000) throw new Error("请填写有效处理状态和 1～4000 字的说明");
  let results: any[] = [];
  if (existsSync(active.path)) {
    if (lstatSync(active.path).isSymbolicLink() || !lstatSync(active.path).isFile()) throw new Error("当前回执不是普通文件");
    const raw = readFileSync(active.path, "utf8").trim();
    const existing = raw ? JSON.parse(raw) : { schema: "mae-flow-feedback-results/1", batch_id: active.batchId, results: [] };
    if (existing.schema !== "mae-flow-feedback-results/1" || existing.batch_id !== active.batchId || !Array.isArray(existing.results)) throw new Error("已有回执格式异常，请先修正，避免覆盖其他条目");
    results = existing.results;
  }
  results = results.filter(row => row.id !== item.id);
  results.push({ id: item.id, status: input.status, summary: input.summary, ...(input.evidence ? { evidence: input.evidence } : {}) });
  mkdirSync(dirname(active.path), { recursive: true });
  if (lstatSync(dirname(active.path)).isSymbolicLink()) throw new Error("回执目录不能是软链接");
  // This file may be bind-mounted individually into the coding container.
  // Keep its inode: rename would leave the Agent reading the obsolete mount.
  writeFileSync(active.path, JSON.stringify({ schema: "mae-flow-feedback-results/1", batch_id: active.batchId, results }, null, 2));
  return `已记录 ${item.id}；${results.length}/${active.items.length} 条已有处理结果。回合结束时沿原链路登记，未代替核验。`;
}
