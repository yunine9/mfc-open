/** 提交入口的即时展示，只读取现有任务事实，不新增流程状态。 */
export interface AnnotationSubmissionAction { enabled: boolean; hint: string }
export interface AnnotationSubmissionView {
  ordinary: AnnotationSubmissionAction;
  story: AnnotationSubmissionAction;
}

export function annotationSubmissionView(input: {
  status: string; openMr: boolean; evidenceAwaiting: boolean;
  publishedStory: boolean; reviewDecision: boolean; requirementReview: boolean;
}): AnnotationSubmissionView {
  const { status } = input;
  let ordinary: AnnotationSubmissionAction;
  if (status === "canceled" || status === "completed") {
    ordinary = { enabled: false, hint: status === "canceled"
      ? "任务已停止，批注保留，不再启动修改。"
      : "任务已交付；如需继续修改代码，请创建后续任务。" };
  } else if (["paused", "pausing"].includes(status)) {
    ordinary = { enabled: true, hint: "提交后保存排队，恢复任务后处理；不会自动恢复任务。" };
  } else if (status === "waiting_for_human") {
    ordinary = { enabled: true, hint: input.requirementReview
      ? "提交后 Agent 修改需求文档，完成后再由你确认。"
      : input.reviewDecision
        ? "提交即要求按意见修改，无需再点卡片上的“需要调整”；不会确认通过或推送。"
        : "提交后保存排队；请先回答当前问题，意见会随答复一起交给 Agent。" };
  } else if (status === "running") {
    ordinary = { enabled: true, hint: "提交后加入当前工作，Agent 在可接收补充时处理，无需等整轮结束。" };
  } else if (status === "queued") {
    ordinary = { enabled: true, hint: "提交后加入待启动的工作，无需重复提交。" };
  } else if (input.openMr || input.evidenceAwaiting) {
    ordinary = { enabled: true, hint: "提交后继续处理当前任务的修改意见。" };
  } else {
    ordinary = { enabled: false, hint: "批注已保存；请先恢复或重跑任务，再提交修改意见。" };
  }
  return { ordinary, story: input.publishedStory && status !== "canceled"
    ? { enabled: true, hint: "提交后修改这份 Story 文档，已有修订会按顺序处理；不会替你修改子任务代码。" }
    : ordinary };
}
