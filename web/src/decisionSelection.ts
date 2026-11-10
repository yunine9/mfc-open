import { isReviewAdjustmentAnswer } from "../../src/reviewDecisionContract";

/**
 * 决策卡的选项不是一次性锁死的：再次点击当前选项即取消，点击别的
 * 选项则切换。返回新对象，便于 React 状态更新，也不改写旧快照。
 */
export function toggleDecisionChoice(
  current: Readonly<Record<string, string>>,
  question: string | number,
  choice: string,
): Record<string, string> {
  const key = String(question);
  const next = { ...current };
  if (next[key] === choice) delete next[key];
  else next[key] = choice;
  return next;
}

/** 从某道题退出既有选项；没有选中时保留原对象，避免无意义刷新。 */
export function clearDecisionChoice(
  current: Readonly<Record<string, string>>,
  question: string | number,
): Record<string, string> {
  const key = String(question);
  if (!(key in current)) return current as Record<string, string>;
  const next = { ...current };
  delete next[key];
  return next;
}

/** One reply field: preserve an explicit branch; otherwise the text is the answer. */
export function unifiedDecisionReply(selected: string | undefined, text: string): {
  freeResponse: string; notes: string;
} {
  const reply = text.trim();
  return selected ? { freeResponse: "", notes: reply } : { freeResponse: reply, notes: "" };
}

/** 新旧推送卡的调整选项均走返工，不因清单加载或变化切回推送按钮。 */
export function isAdjustmentAnswer(answer: string): boolean {
  return isReviewAdjustmentAnswer(answer);
}

/** 识别推送确认卡；代码展示和修改意见仍使用现有入口。 */
export function isPushConfirmation(waiting?: { step?: string; recommended_view?: string }): boolean {
  return waiting?.step === "cloud_push_confirm" || waiting?.step === "host_push_confirm";
}

/** 只有这次手势确实拖动并选中文字才忽略 click，旧选区不能锁死选项。 */
export function isDecisionTextDrag(
  start: { x: number; y: number } | undefined,
  end: { x: number; y: number },
  hasSelection: boolean,
): boolean {
  return !!start && hasSelection && Math.hypot(end.x - start.x, end.y - start.y) > 4;
}

/** 以服务端的排队事实为准，包含责任人转交的他人意见，排除已送达项。 */
export function queuedDecisionAnnotationIds(items: readonly {
  id: string; status: string; sent_via?: string;
  response?: { revision: number }; rework?: number;
}[]): string[] {
  return items.filter(item => item.status === "sent" && item.sent_via === "queued_decision"
    && item.response?.revision !== (item.rework ?? 0)).map(item => item.id);
}
