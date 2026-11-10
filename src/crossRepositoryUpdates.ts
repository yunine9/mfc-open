import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CrossRepositoryUpdate, TaskSummary } from "./taskService.ts";

interface CollaborationTask {
  summary: Pick<TaskSummary, "id" | "parent_task_id" | "workspace" | "cross_repository_updates">;
  cwd?: string;
}

/** 通知属于整条需求；依赖图只负责调度，不负责限制消息接收范围。 */
export function syncCrossRepositoryGroup<T extends CollaborationTask>(
  parent: T, tasks: Iterable<T>, persist: (task: T) => void,
  addition?: CrossRepositoryUpdate,
): CrossRepositoryUpdate[] {
  const children = [...tasks].filter((task) => task.summary.parent_task_id === parent.summary.id);
  const members = [parent, ...children];
  const byId = new Map<string, CrossRepositoryUpdate>();
  // 子任务上的旧副本也参与补齐，避免父账本旧版截断后再次丢失消息。
  for (const member of [...children, parent]) {
    for (const update of member.summary.cross_repository_updates ?? []) {
      if (update.parent_task_id === parent.summary.id) byId.set(update.id, update);
    }
  }
  if (addition) byId.set(addition.id, addition);
  const updates = [...byId.values()]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((update) => ({ ...update, target_task_ids: children
      .filter((task) => task.summary.id !== update.source_task_id)
      .map((task) => task.summary.id) }));
  if (!updates.length) return updates;
  for (const member of members) {
    if (JSON.stringify(member.summary.cross_repository_updates) === JSON.stringify(updates)) continue;
    member.summary.cross_repository_updates = structuredClone(updates);
    persist(member);
  }
  return updates;
}

/** 完整正文在当前 Agent 的工作目录落盘，启动/恢复不用把长历史挤进 prompt。 */
export function crossRepositoryUpdateContext(task: CollaborationTask): string {
  const updates = (task.summary.cross_repository_updates ?? [])
    .filter((update) => update.source_task_id !== task.summary.id);
  if (!updates.length) return "";
  // 不能因通知重建已回收的 clone 目录，否则 launch 会误判它还能 resume。
  const root = task.cwd && existsSync(task.cwd) ? task.cwd : task.summary.workspace;
  const path = join(root, ".mae-flow-work", "cross-repository-updates.md");
  const content = [
    "# 本需求的子任务通知（完整记录）", "",
    ...updates.flatMap((update) => [
      `## ${update.id}`, `时间：${update.created_at}`,
      `来源：${update.source_task_id} · ${update.source_repository ?? ""} · ${update.author}`,
      "", update.text, "",
    ]),
  ].join("\n");
  const instruction = "逐条判断是否影响本任务；无关就继续，已处理且没有新变化的内容无需重复修改。"
    + "有影响时在本任务范围内处理，只有确实存在歧义或冲突才向人提问。"
    + "通知不改变任务依赖顺序，也不授权越界修改。";
  try {
    mkdirSync(join(root, ".mae-flow-work"), { recursive: true });
    writeFileSync(path, content, { mode: 0o600 });
    return `本需求有 ${updates.length} 条其他子任务的通知。请读取完整记录 ${JSON.stringify(path)}，`
      + instruction;
  } catch {
    // 通知文件只是阅读投影；不能因它写不出而阻止任务继续或遗漏消息。
    return `${instruction}\n通知文件暂不可用，完整记录如下：\n${content}`;
  }
}
