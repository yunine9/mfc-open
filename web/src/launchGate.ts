export interface LaunchGateBlocker {
  key: string;
  label: string;
  where: "admin" | "me";
}

export type LaunchGateState =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "blocked"; blockers: LaunchGateBlocker[] }
  | { kind: "error"; detail: string };

export interface LaunchGateCopy {
  enabled: boolean;
  title: string;
  ariaLabel: string;
  helper?: string;
  action?: "profile" | "retry";
}

/**
 * 顶部入口不再根据几个 token hint 猜能不能下单。服务端 blockers 才是
 * 权威事实；这里仅把“该找自己还是找管理员”翻译成短而可操作的提示。
 */
export function launchGateCopy(state: LaunchGateState): LaunchGateCopy {
  if (state.kind === "ready") {
    return {
      enabled: true,
      title: "发起新任务",
      ariaLabel: "发起新任务",
    };
  }
  if (state.kind === "checking") {
    return {
      enabled: false,
      title: "正在检查发起条件",
      ariaLabel: "发起新任务暂不可用，正在检查发起条件",
      helper: "正在检查发起条件…",
    };
  }
  if (state.kind === "error") {
    return {
      enabled: false,
      title: `未能检查发起条件：${state.detail}`,
      ariaLabel: "发起新任务暂不可用，未能检查发起条件",
      helper: "未能确认发起条件 · 点击重试",
      action: "retry",
    };
  }

  const details = state.blockers.map((item) => item.label).join("；");
  const hasPersonalBlocker = state.blockers.some((item) => item.where === "me");
  return {
    enabled: false,
    title: `暂不能发起：${details}`,
    ariaLabel: hasPersonalBlocker
      ? "发起新任务不可用，请先完善个人设置"
      : "发起新任务不可用，服务配置尚未就绪",
    helper: hasPersonalBlocker
      ? "完善个人设置后解锁"
      : "服务配置未就绪 · 点击重试",
    action: hasPersonalBlocker ? "profile" : "retry",
  };
}
