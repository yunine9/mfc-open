import type { FeedbackRecord, FeedbackStatus } from "./api";

export const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = {
  open: "待处理", repairing: "处理中", addressed: "已处理",
  awaiting_verification: "待核验", closed: "已完成", needs_human: "需要你决定",
  deferred: "已暂缓，未解决", superseded: "已被新版本替代",
  superseded_by_merge: "随合入结束",
};

/** 只翻译 API 的逐条状态；历史失败归档不冒充验证通过。 */
export function feedbackEnded(item: { status: FeedbackStatus }): boolean {
  return ["closed", "superseded", "superseded_by_merge"].includes(item.status);
}

export function feedbackCategory(item: { status: FeedbackStatus }): "closed" | "mine" | "agent" {
  return feedbackEnded(item) ? "closed"
    : ["needs_human", "deferred"].includes(item.status) ? "mine" : "agent";
}

export function feedbackStatusLabel(item: Pick<FeedbackRecord, "source" | "status">): string {
  if (item.source === "mr_discussion") {
    if (item.status === "awaiting_verification") return "已回复，等检视人确认";
    if (item.status === "closed") return "检视人已确认";
  }
  if (item.source === "workspace" && item.status === "awaiting_verification") return "等责任人逐条处置";
  return FEEDBACK_STATUS_LABEL[item.status];
}

export function feedbackSummary(items: Array<{ status: FeedbackStatus }>): string {
  const pending = items.filter(item => !feedbackEnded(item) && item.status !== "deferred").length;
  const deferred = items.filter(item => item.status === "deferred").length;
  if (pending || deferred) return [pending ? `${pending} 条待闭环` : "",
    deferred ? `${deferred} 条已暂缓` : ""].filter(Boolean).join("，");
  return items.some(item => item.status !== "closed") ? "已结束，保留历史记录" : "全部已闭环";
}
