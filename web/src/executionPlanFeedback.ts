export interface ExecutionPlanFeedbackDraft {
  title: string;
  detail: string;
}

export interface FeedbackExecutionPlan {
  plan_id: string;
  plan_revision: string;
  step: { phase: string; title: string };
  strategy: { title: string };
}

export function executionPlanFeedbackDraft(
  plan: FeedbackExecutionPlan,
): ExecutionPlanFeedbackDraft {
  return {
    title: `改进「${plan.strategy.title}」阶段执行方案`,
    detail: [
      `关联方案：${plan.plan_id}`,
      `阶段/步骤：${plan.step.phase} / ${plan.step.title}`,
      `方案快照：${plan.plan_revision}`,
      "",
      "我遇到的问题或建议：",
    ].join("\n"),
  };
}
