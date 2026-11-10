import type { Annotation } from "./annotations.ts";
import { recordKernelFeedbackResult, type KernelFeedbackItem, type KernelFeedbackResultItem, type KernelDeliveryHost } from "./kernelDelivery.ts";

/** 只展示已登记的逐条人工决定，不把整批状态当成每条的处理结果。 */
export function humanFeedbackReason(items: Pick<KernelFeedbackItem, "id" | "source">[], results: KernelFeedbackResultItem[]): string | undefined {
  const sources = new Map(items.map(item => [item.id, item.source]));
  const labels: Record<string, string> = {
    pipeline: "流水线验证", build_fix: "构建验证", mr_discussion: "MR 代码检视",
    workspace: "工作台意见", conflict: "合并冲突", scope: "交付范围", push_confirmation: "推送确认",
  };
  const reasons = results.filter(result => result.status === "needs_human")
    .map(result => `${labels[sources.get(result.id) ?? ""] ?? "交付反馈"}：${result.summary}`);
  return reasons.length ? `等待你决定以下反馈的处理方案：\n\n${reasons.join("\n\n")}` : undefined;
}

/** 作者已闭环或撤回的旧意见，不再要求 Agent 为同一条补答复。 */
export function resolvedWorkspaceFeedback(item: { id: string; source_revision?: number }, annotation?: Annotation): KernelFeedbackResultItem | undefined {
  if (!annotation) return undefined;
  const reason = annotation.status === "verified"
    ? annotation.resolution ? `责任人逐条处置：${annotation.resolution.outcome}；${annotation.resolution.reason}` : "批注作者已确认通过"
    : annotation.status === "dropped" ? "批注作者已撤回"
    : (annotation.rework ?? 0) > (item.source_revision ?? 0) ? "该版本已被新一轮意见替代"
    : undefined;
  return reason ? { id: item.id, status: "explained", summary: reason } : undefined;
}

/** 升级前结果已落盘但步骤未交还：重放原结果，不改结果、不重跑模型。 */
export function resumeRecordedFeedback(input: {
  host: KernelDeliveryHost; cwd: string; workspace: string; taskId: string;
  state: any; batch: any;
}): boolean {
  const { state, batch } = input;
  if (batch.status !== "awaiting_verification"
      || !["feedback_triage", "build", "domain_archive", "delivery_review", "push"].includes(state.current)) return false;
  recordKernelFeedbackResult({ ...input, batchId: batch.batch_id, changed: true, results: batch.results });
  return true;
}
