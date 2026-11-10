/** 确认只表达同意方案，后续动作由需求图决定。展示前归一，不改写历史答复。 */
export const REQUIREMENT_GRAPH_APPROVE = "确认方案";
/** 以下三个旧选项仅用于兼容识别，不再作为新卡片的选项来源。 */
export const REQUIREMENT_GRAPH_CONFIRM = "确认并生成任务";
export const REQUIREMENT_GRAPH_NO_CHANGE_CONFIRM = "确认分析结论";
export const REQUIREMENT_GRAPH_CONTINUE = "确认并继续开发";
export function confirmsRequirementGraph(answer: string): boolean {
  return [REQUIREMENT_GRAPH_APPROVE, REQUIREMENT_GRAPH_CONFIRM, REQUIREMENT_GRAPH_NO_CHANGE_CONFIRM, REQUIREMENT_GRAPH_CONTINUE].includes(answer.trim());
}

/** 单元关联到原任务表示在本任务交付，不是生成了一个指向自己的子任务。 */
export function isMainTaskDelivery(task: {
  id: string; parent_task_id?: string;
  requirement_graph?: { stage: string; repositories: Array<{ task_id?: string }> };
}): boolean {
  const graph = task.requirement_graph;
  return !task.parent_task_id && graph?.stage === "confirmed"
    && graph.repositories.length === 1 && graph.repositories[0].task_id === task.id;
}

export function requirementDecisionContract(question: Record<string, unknown>, analysis: boolean): Record<string, unknown> {
  const items = question.questions as Array<{ question: string; options?: string[]; recommended?: string }> | undefined;
  if (!analysis || question.purpose === "clarification" || !Array.isArray(items) || items.length !== 1 || !Array.isArray(items[0]?.options)) return question;
  const canonical = (option: string) => {
    if (confirmsRequirementGraph(option)) return REQUIREMENT_GRAPH_APPROVE;
    // 这里只识别举卡意图，不用于裁决用户答复。否定、暂缓和澄清不升级为确认。
    if (!/^确认/.test(option) || /不|暂|取消|拒绝/.test(option)) return option;
    return REQUIREMENT_GRAPH_APPROVE;
  };
  const item = items[0];
  return { ...question, questions: [{ ...item,
    options: [...new Set(item.options!.map(canonical))],
    ...(item.recommended ? { recommended: canonical(item.recommended) } : {}),
  }] };
}
