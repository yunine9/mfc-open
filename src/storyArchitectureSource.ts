import { join } from "node:path";
import { readArtifact } from "./artifacts.ts";
import { isMainTaskDelivery } from "./requirementDecisionContract.ts";
import type { TaskSummary } from "./taskService.ts";

/** 展示与更新共用文档白名单，包括尚未发布的分析 Story 和历史任务材料。 */
export function readArchitectureStory(task: TaskSummary, root: string | undefined) {
  const document = readArtifact(root, task.parent_task_id || isMainTaskDelivery(task) ? `${task.ticket ?? task.id}/story.md` : "task-materials/overall-story.md", {
    pipelineRoot: join(task.workspace, "pipeline"), taskMaterialRoot: task.workspace,
    publishedStory: task.requirement_graph?.source_document === "story.md" && task.requirement_graph.stage === "confirmed",
    analysisStory: task.requirement_graph && !task.parent_task_id && !isMainTaskDelivery(task) ? `${task.ticket ?? task.id}/story.md` : undefined,
  });
  // 旧任务可能已标记 confirmed，却从未登记全局修订；只回退到当前任务的精确文档名。
  return document ?? (isMainTaskDelivery(task)
    ? readArtifact(root, "task-materials/overall-story.md", { taskMaterialRoot: task.workspace })
    : readArtifact(root, `${task.ticket ?? task.id}/story.md`));
}
