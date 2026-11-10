import { hasTaskDemoPhaseCard, taskDemoPhaseSteps, type TaskDemoSnapshot } from "./taskDemoTypes";

/** 先核对全部历史记录；只有确实缺卡时才请求无工具 Agent 整理任务资料。 */
export async function prepareTaskDemoCards(snapshot: TaskDemoSnapshot, fetchSource: typeof fetch,
  signal: AbortSignal, onProgress: (phase: string) => void): Promise<TaskDemoSnapshot> {
  const prepared = structuredClone(snapshot);
  const phases = prepared.task.progress?.phases ?? [];
  for (const phase of phases) {
    if (hasTaskDemoPhaseCard(prepared, phase)) continue;
    onProgress(phase);
    const response = await fetchSource(`/tasks/${encodeURIComponent(snapshot.source_task_id)}/demo-card`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phase }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(100_000)]),
    });
    const result = await response.json() as {
      source_task_id?: string; phase?: string; context?: string; error?: string;
      questions?: Array<{ question: string; options: string[] }>; source_ids?: string[];
    };
    if (!response.ok) throw new Error(`${phase}：${result.error ?? "补充卡暂未生成，请重试"}`);
    if (result.source_task_id !== snapshot.source_task_id || result.phase !== phase
        || typeof result.context !== "string" || !Array.isArray(result.questions) || !result.questions.length
        || result.questions.some((q: { question?: unknown; options?: unknown }) => typeof q.question !== "string"
          || !Array.isArray(q.options) || !q.options.every((option: unknown) => typeof option === "string"))
        || !Array.isArray(result.source_ids) || !result.source_ids.length) {
      throw new Error(`${phase}：补充卡资料不完整，请重试`);
    }
    const id = `demo-supplement-${snapshot.source_task_id}-${phases.indexOf(phase)}`;
    const steps = taskDemoPhaseSteps(prepared.task, phase, prepared.phase_steps, prepared.step_titles);
    if (!steps.length) throw new Error(`${phase}：缺少阶段对应信息，无法补充卡片`);
    prepared.conversation.items.push({ kind: "card", id, waiting_id: id, step: steps[0],
      ts: new Date().toISOString(), purpose: "confirmation", annotation_ids: [],
      questions: result.questions, status: "waiting" });
    (prepared.card_contexts ??= {})[id] = { context: `依据原任务资料补充生成，非历史原话。\n\n${result.context}` };
    (prepared.supplemental_cards ??= {})[id] = result.source_ids;
  }
  return prepared;
}
