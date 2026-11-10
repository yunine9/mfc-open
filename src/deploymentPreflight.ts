import { existsSync } from "node:fs";

export interface DeploymentRuntimeCheck {
  status: "ok" | "warning" | "error";
  detail: string;
  suggestion?: string;
}

export interface DeploymentRuntimeFacts {
  platform: NodeJS.Platform;
  pid: number;
  container: boolean;
}

/** 纯判断函数，部署与测试共用同一口径。 */
export function checkDeploymentRuntime(
  facts: DeploymentRuntimeFacts,
): DeploymentRuntimeCheck {
  if (facts.platform !== "linux") {
    return {
      status: "warning",
      detail: `当前运行于 ${facts.platform}，正式部署目标是 Linux`,
      suggestion: "本机可用于开发；上线前请在 Linux 部署自检中复验",
    };
  }
  if (!facts.container) {
    return {
      status: "ok",
      detail: "Linux 宿主进程已就绪",
      suggestion: "请由 systemd 等进程管理器直接管理 Node 进程并转发 SIGTERM",
    };
  }
  if (facts.pid !== 1) {
    return {
      status: "error",
      detail: `Linux 容器内服务不是 PID 1（当前 PID ${facts.pid}）`,
      suggestion: "容器启动命令请使用 `exec node --import tsx src/serve.ts …`（或直接运行编译后的 JS）；不要经 npm / tsx 启动器转一层",
    };
  }
  return {
    status: "ok",
    detail: "Linux 容器运行正常，服务直接接收停止信号（PID 1）",
  };
}

export function inspectDeploymentRuntime(): DeploymentRuntimeCheck {
  return checkDeploymentRuntime({
    platform: process.platform,
    pid: process.pid,
    container: existsSync("/.dockerenv") || existsSync("/run/.containerenv"),
  });
}
