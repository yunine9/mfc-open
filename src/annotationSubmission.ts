import { failPrePushEnvironment, type PrePushVerificationState } from "./prePushVerification.ts";
import { pendingReviewAnnotation } from "./annotationPending.ts";
import { OVERALL_STORY_ARTIFACT } from "./overallStoryStore.ts";
import { AnnotationStore, AnnotationPermissionError, renderAnnotations, type Annotation, TASK_REQUIREMENT_ARTIFACT } from "./annotations.ts";
import { NotFoundError, TaskControlError } from "./errors.ts";

/** 记下即为团队意见。旧 route、作者身份和管理员身份均不代替当前责任人。 */
export function assertAnnotationOwnerAccess(actor: string, owner: string, status: string): void {
  if (actor !== owner) throw new AnnotationPermissionError(`只有当前任务责任人 ${owner} 可以处理检视意见`);
  if (status === "canceled") throw new TaskControlError("任务已停止，检视记录保留，不再处置");
}

/** 计算提交权限与第一份稳定快照。allowForeign 只是调用意图，不能越过责任人身份。 */
export function annotationSubmissionPlan(input: {
  items: Annotation[]; ids?: string[]; sender: string; owner: string;
  allowForeign: boolean; requirementReview: boolean;
}): { selected: Annotation[]; maySendForeign: boolean } {
  assertAnnotationOwnerAccess(input.sender, input.owner, "active");
  const maySendForeign = !!input.ids?.length;
  return { maySendForeign, selected: pickAnnotationSubmission(
    input.items, input.ids, input.sender, maySendForeign, input.requirementReview) };
}

/** 需求修订在 Agent 收轮前就持久化回执。重复请求直接复用回执，
 * 同次提交中的新意见仍经过发送锁；首个长请求不会把重试或新意见锁死。
 * 输入须经过 annotationSubmissionPlan 的权限、版本与回执筛选。 */
export async function submitAnnotationWithReceipts(
  store: AnnotationStore, selected: Annotation[], sender: string, context: string,
  deliver: (snapshot: Annotation[]) => Promise<{ sent: string[]; text: string }>,
  options: { requirementReview: boolean; ticket: string },
): Promise<{ sent: string[]; text: string }> {
  const accepted = new Set(options.requirementReview ? selected.filter(item =>
    item.artifact === TASK_REQUIREMENT_ARTIFACT && item.status !== "draft").map(item => item.id) : []);
  const pending = selected.filter(item => !accepted.has(item.id));
  // 新一轮意见会恢复 draft；已送出时的新增说明不能被幂等处理静默吞掉。
  if (context.trim() && accepted.size) throw new TaskControlError("意见已经送出，请等答复后重新处理再补充说明");
  const delivered = pending.length
    ? await submitAnnotationSnapshot(store, pending, sender, context, deliver)
    : { sent: [], text: renderAnnotations(selected, options.ticket) };
  return { ...delivered, sent: selected.filter(item =>
    accepted.has(item.id) || delivered.sent.includes(item.id)).map(item => item.id) };
}

// TaskService 每次读取会新建 Store，锁按同一个账本路径共享。
const submitting = new Map<string, Set<string>>();

/** 先登记当前版本交接再做异步发送。失败只退回尚未送出的版本，不能撤销真回执。 */
export async function submitAnnotationSnapshot<T>(store: AnnotationStore, selected: Annotation[],
  sender: string, context: string, deliver: (snapshot: Annotation[]) => Promise<T>): Promise<T> {
  if (context.trim().length > 4000) throw new TaskControlError("补充说明最多 4000 字");
  const active = submitting.get(store.path) ?? new Set<string>();
  if (selected.some(item => active.has(item.id))) throw new TaskControlError("这些意见正在发送，请等待本次提交完成");
  submitting.set(store.path, active);
  selected.forEach(item => active.add(item.id));
  try {
    for (const item of selected) {
      if (item.status === "draft" || (item.status === "sent" && item.sent_via === "owner_pending")) {
        store.assignToAgent(item.id, sender, context);
      }
    }
    const current = new Map(store.list().map(item => [item.id, item]));
    return await deliver(selected.map(item => current.get(item.id)!));
  } catch (error) {
    store.resetUnsentAssignments(selected);
    throw error;
  } finally {
    selected.forEach(item => active.delete(item.id));
    if (!active.size) submitting.delete(store.path);
  }
}

export function pickAnnotationSubmission(
  items: Annotation[], ids?: string[], actor?: string,
  allowForeign = false, acceptRequirementSubmitted = false,
): Annotation[] {
  const eligible = items.filter((item) => pendingReviewAnnotation(item)
    || (!!ids?.length && item.artifact === OVERALL_STORY_ARTIFACT
      && ["sent", "verified"].includes(item.status)
      && ["overall_story_queue", "overall_story_processing", "overall_story"].includes(item.sent_via ?? ""))
    || (acceptRequirementSubmitted && !!ids?.length
      && item.artifact === TASK_REQUIREMENT_ARTIFACT
      && (item.route ?? "agent") === "agent"
      && ["sent", "verified"].includes(item.status)
      && (["requirement_queue", "requirement_review"].includes(item.sent_via ?? "")
        || (item.sent_via === "interrupt" && !!item.response))));
  // 省略 ID 时只能提交本人草稿，不能顺手带上他人的私人意见。
  const available = actor && (!allowForeign || !ids?.length)
    ? eligible.filter((item) => item.author === actor) : eligible;
  if (!ids?.length) {
    if (!available.length) throw new NotFoundError("没有待送出的批注");
    return available;
  }
  const wanted = new Set(ids);
  const picked = available.filter((item) => wanted.has(item.id));
  if (picked.length !== wanted.size) {
    throw new NotFoundError(actor
      ? "有批注不存在、已经送出，或不是你写的"
      : "有批注不存在或已经送出去了");
  }
  return picked;
}

export function requirementSubmissionReceipt(items: Annotation[], ids: string[]): string {
  const picked = items.filter((item) => ids.includes(item.id));
  const processing = picked.filter((item) => item.sent_via === "requirement_review").length;
  const queued = picked.filter((item) => item.sent_via === "requirement_queue").length;
  const processed = picked.filter((item) => item.sent_via === "interrupt" && !!item.response).length;
  if (!processing && !queued && !processed) {
    return "处理未启动或已失败，意见仍在待提交；请查看任务失败原因后重试。";
  }
  return [
    processing ? `${processing} 条正在由 Agent 处理` : "",
    queued ? `${queued} 条已排队，当前一批完成后自动处理` : "",
    processed ? `${processed} 条已有处理回执，请逐条复检` : "",
  ].filter(Boolean).join("；") + "。无需重复提交。";
}

/** 暂停只保存发送意图；恢复时先接续这批意见，再决定是否启动普通会话。 */
export function resumeQueuedAnnotationSubmission(input: {
  task: { summary: { status: string; waiting?: unknown; detail?: string; delivery?: { prepush?: PrePushVerificationState } }; resume?: boolean };
  notes: Annotation[]; from: string; changed: boolean;
  persist(): void; markReturned(): void; run(work: Promise<void>): void;
  submitDecision(): Promise<boolean>; deliver(): Promise<unknown>; enqueue(): Promise<void>;
}): boolean {
  if (!input.notes.length || input.changed) return false;
  input.task.summary.status = input.from === "waiting_for_human" && input.task.summary.waiting
    ? "waiting_for_human" : "queued";
  // 暂停已释放执行者；新意见接管后，旧验证不能在下一次部署时复活。
  const verification = input.task.summary.delivery?.prepush;
  if (verification?.active_attempt) input.task.summary.delivery!.prepush = failPrePushEnvironment(
    verification, new Date().toISOString(), "原验证未完成；恢复后先处理责任人提交的修改意见");
  input.task.resume = true;
  input.task.summary.detail = "已恢复，正在接续已提交的修改意见";
  input.persist(); input.markReturned();
  input.run((async () => {
    if (await input.submitDecision()) return;
    await input.deliver();
    if (input.task.summary.status === "queued") await input.enqueue();
  })());
  return true;
}

export function annotationSubmissionReceipt(items: Annotation[], sent: string[], requested: number, status: string): string {
  if (items.some(item => sent.includes(item.id) && item.sent_via === "queued_decision")) {
    return ["paused", "pausing"].includes(status) ? "意见已提交并排队，恢复任务后处理。"
      : "意见已排队，尚未送达；等待当前问题答复后一起送达。";
  }
  return sent.length < requested
    ? "发送期间部分意见已更新或已闭环；新版本保留当前状态，请查看逐条意见。"
    : status === "running" ? `已接收 ${sent.length} 条修改意见；当前工具结束后读取并结合处理，无需等整轮结束。读取状态见工作过程，完成情况以逐条回执为准。`
    : status === "queued" ? `已接收 ${sent.length} 条修改意见，已并入待启动的工作；启动后一起处理，无需重复提交。`
    : `已接收 ${sent.length} 条修改意见，处理进展见逐条状态，无需重复提交。`;
}
