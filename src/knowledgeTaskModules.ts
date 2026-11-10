import type { KnowledgeTaskRow } from "./knowledgeTaskCenterTypes";

/** 模块目录以最新一次领域萃取为准，旧任务仍保留在任务中心。 */
export function latestModuleKnowledgeTasks(tasks: KnowledgeTaskRow[]): Map<string, KnowledgeTaskRow> {
  const time = (task: KnowledgeTaskRow) => Date.parse(task.created_at ?? task.started_at ?? "") || 0;
  const modules = new Map<string, KnowledgeTaskRow>();
  for (const task of [...tasks].sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id))) {
    if (task.kind === "domain" && task.module_id && !modules.has(task.module_id)) modules.set(task.module_id, task);
  }
  return modules;
}
