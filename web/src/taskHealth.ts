import { taskProgressTimestamp } from "../../src/taskProgressTime";
export interface HealthTask {
  luban_account?: string;
  status?: string;
  completed_at?: string;
  waiting?: { created_at?: string } | null;
  created_at: string;
  updated_at?: string;
  last_progress_at?: string;
  focus?: {
    headline: string;
    next_action: string;
    owner: "responsible" | "agent" | "platform" | "none";
    needs_attention: boolean;
  };
}

export interface TaskHealthFacts {
  current: string;
  next: string;
  actor: string;
  last_progress_at: string;
  needs_attention: boolean;
}

function actorLabel(task: HealthTask, viewerUsername: string): string {
  const owner = task.focus?.owner;
  if (owner === "agent") return "Agent 自动推进";
  if (owner === "platform") return "平台 / 外部系统";
  if (owner === "none") return "无需继续处理";
  const responsible = task.luban_account?.trim();
  if (!responsible) return "任务负责人";
  return responsible === viewerUsername ? `你 · ${responsible}` : responsible;
}

/** 健康栏只消费服务端焦点，不在浏览器重新解释状态机。 */
export function taskHealthFacts(
  task: HealthTask,
  viewerUsername: string,
): TaskHealthFacts | undefined {
  if (!task.focus) return undefined;
  return {
    current: task.focus.headline,
    next: task.focus.next_action,
    actor: actorLabel(task, viewerUsername),
    last_progress_at: taskProgressTimestamp(task),
    needs_attention: task.focus.needs_attention,
  };
}
