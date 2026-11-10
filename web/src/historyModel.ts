import { instantMs } from "./time";
import { orderTaskHierarchy } from "./taskHierarchy";

interface HistoryTaskFields {
  id: string;
  title?: string;
  requirement: string;
  created_at: string;
  updated_at?: string;
  last_progress_at?: string;
}

/** 成果档案只收已经形成结果的任务。failed 同时是团队现场的异常
 * 信号和这里的历史事实，这是刻意保留的唯一重叠。 */
export function isDeliveryArchiveStatus(status: string): boolean {
  return ["completed", "failed", "canceled"].includes(status);
}

/**
 * PostgreSQL 未启用时，用当前服务已经恢复的任务提供可用但不冒充历史的读侧。
 * event_count=0 只是类型占位；界面在现场模式下不会把它展示成历史事件数。
 */
export function workspaceHistoryEntries<T extends HistoryTaskFields>(
  tasks: T[],
): Array<T & { event_count: number; updated_at: string }> {
  return tasks
    .map((task) => ({
      ...task,
      event_count: 0,
      updated_at: task.updated_at ?? task.last_progress_at ?? task.created_at,
    }))
    .sort((left, right) => {
      const leftAt = instantMs(left.updated_at);
      const rightAt = instantMs(right.updated_at);
      return (Number.isFinite(rightAt) ? rightAt : 0)
        - (Number.isFinite(leftAt) ? leftAt : 0);
    });
}

export function historyTaskTitle(task: Pick<HistoryTaskFields, "id" | "title" | "requirement">): string {
  const title = task.title?.trim();
  if (title) return title;
  const firstLine = task.requirement.split(/\r?\n/, 1)[0]?.trim();
  return firstLine || task.id;
}

/** 本机仍有现场时补齐历史投影的关系；主任务缺席时也保留子任务来源。 */
export function historyTaskHierarchy<T extends { id: string; parent_task_id?: string }>(
  entries: T[], tasks: Array<{ id: string; parent_task_id?: string }>,
): T[] {
  const current = new Map(tasks.map(task => [task.id, task]));
  return orderTaskHierarchy(entries.map(entry => ({ ...entry,
    parent_task_id: entry.parent_task_id ?? current.get(entry.id)?.parent_task_id,
  })));
}
