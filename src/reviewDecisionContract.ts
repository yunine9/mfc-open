import type { StepChoiceEffect } from "./kernelChoices.ts";
export { pendingReviewAnnotation } from "./annotationPending";

export const REVIEW_ADJUST = "需要调整，按检视意见继续处理";
export const REVIEW_HOLD = "暂不确认，我先核对";

/** 识别明确要求继续修改的检视选项。内核可让 Agent 按材料生成具体文案；
 * 暂缓、核对和提问不算返工。服务端与网页共用此判据。 */
export function isReviewAdjustmentAnswer(answer: string): boolean {
  const value = answer.replace(/\s+/g, "");
  return /先调整|仍需(?:调整|修改)|需要.*(?:调整|修改)|按(?:当前)?检视意见.*(?:调整|修改|处理)|返工/.test(value);
}

/** 自由举卡可能没有内核步骤。责任人明确要求处理检视意见时仍须携带
 * 意见正文；普通“需要调整”和否定/暂缓回答不能擅自触发批量发送。 */
export function explicitlyRequestsReviewFeedback(answer: string): boolean {
  const value = answer.replace(/\s+/g, "");
  return /检视意见/.test(value)
    && /处理|修改|修复|调整/.test(value)
    && !/不|别|勿|暂缓|稍后|先核对|先看看|是否|要不要|[?？]/.test(value);
}

/** 正式单题检视由流程契约提供动作。澄清、多题和已有分支保持原样。
 * 只修正完全对不上契约的模型选项，绝不把历史回答翻译成“同意”。 */
export function reviewDecisionContract(
  question: Record<string, unknown>, effects: StepChoiceEffect[],
): { question: Record<string, unknown>; effects: StepChoiceEffect[] } {
  const items = question.questions as Array<{ question: string; options?: string[]; recommended?: string }> | undefined;
  const confirmation = effects.find(effect => effect.key === "confirm"
    && effect.closesFeedback);
  if (!confirmation || question.purpose === "clarification" || !Array.isArray(items)
      || items.length !== 1 || !Array.isArray(items[0]?.options) || !items[0].options.length) return { question, effects };
  const item = items[0];
  const canonical = confirmation.answers[0];
  if (!canonical) return { question, effects };
  const matched = item.options!.some(option => confirmation.answers.includes(option));
  const normalized = matched ? question : { ...question, questions: [{
    ...item, options: [canonical, REVIEW_ADJUST, REVIEW_HOLD], recommended: undefined,
  }] };
  const options = (normalized.questions as typeof items)[0].options!;
  const covered = new Set(effects.filter(effect => effect.handlesFeedback)
    .flatMap(effect => effect.answers));
  const adjustmentAnswers = options.filter(option =>
    isReviewAdjustmentAnswer(option) && !covered.has(option));
  return { question: normalized, effects: adjustmentAnswers.length
    ? [...effects, { key: "review_adjust", answers: adjustmentAnswers,
      allowsSourceEdit: true, handlesFeedback: true, closesFeedback: false }]
    : effects };
}

/** 统一提交只代填明确的单题检视返工选项；不回答澄清、多题或配置问题。 */
export function annotationReviewAnswer(question: Record<string, unknown>, effects: StepChoiceEffect[],
  pushConfirmation = false): Record<string, string> | undefined {
  if (question.purpose === "clarification") return;
  const contract = reviewDecisionContract(question, effects);
  const items = contract.question.questions as Array<{ question: string; options?: string[] }>;
  if (!Array.isArray(items) || items.length !== 1) return;
  const item = items[0];
  const answer = item.options?.find(option => pushConfirmation
    ? isReviewAdjustmentAnswer(option)
    : contract.effects.some(effect => effect.handlesFeedback && effect.answers.includes(option)));
  return answer ? { [item.question]: answer } : undefined;
}

export function annotationReviewSubmission(waiting: {
  question: Record<string, unknown>; waiting_id: string; state_version: number;
}, effects: StepChoiceEffect[], push: boolean, ids: string[], actor: string, context: string) {
  const selected = annotationReviewAnswer(waiting.question, effects, push);
  return selected ? { waiting_id: waiting.waiting_id, state_version: waiting.state_version,
    selected_options: selected, annotation_ids: ids, actor,
    comment: ["责任人提交修改意见，请按本次检视意见修改并逐条答复。", context].filter(Boolean).join("\n") } : undefined;
}

export async function submitAnnotationReviewDecision(input: {
  status: string;
  waiting?: { step: string; question: Record<string, unknown>; waiting_id: string; state_version: number };
  ids: string[]; actor: string; context: string;
  effects(): StepChoiceEffect[];
  decide(submission: NonNullable<ReturnType<typeof annotationReviewSubmission>>): Promise<unknown>;
}): Promise<boolean> {
  if (input.status !== "waiting_for_human" || !input.waiting) return false;
  const push = ["cloud_push_confirm", "host_push_confirm"].includes(input.waiting.step);
  const submission = annotationReviewSubmission(input.waiting, push ? [] : input.effects(),
    push, input.ids, input.actor, input.context);
  if (!submission) return false;
  await input.decide(submission);
  return true;
}
