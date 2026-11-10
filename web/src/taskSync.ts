export type TaskSyncState =
  | { kind: "loading"; last_success_at?: string }
  | { kind: "live"; last_success_at: string }
  | { kind: "error"; last_success_at?: string; detail: string };

export interface TaskSyncCopy {
  title: string;
  detail: string;
  retry: boolean;
}

/** 同一份状态文案供管理员与开发者共用，错误时必须明说当前是旧数据。 */
export function taskSyncCopy(state: TaskSyncState): TaskSyncCopy {
  if (state.kind === "error") {
    return {
      title: "数据更新中断",
      detail: state.last_success_at ? "当前显示上次结果 · 点击重试" : "尚未取得任务数据 · 点击重试",
      retry: true,
    };
  }
  if (state.kind === "loading") {
    return {
      title: "正在同步任务",
      detail: state.last_success_at ? "当前显示上次结果" : "正在取得最新现场",
      retry: false,
    };
  }
  return { title: "任务数据已同步", detail: "现场持续更新", retry: false };
}
