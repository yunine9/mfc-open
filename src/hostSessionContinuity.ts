import { renderDecision, type WaitingRecord } from "./humanGate.ts";
import type { HostAction } from "./taskHostTools.ts";
import type { CloudSession, Outcome } from "./sessionDriver.ts";

/** 只保留进程内空闲会话，持久恢复仍由原生 Pi 检查点负责。 */
interface SessionTask {
  driver?: CloudSession;
  controlEpoch: number;
  retainedSession?: { driver: CloudSession; epoch: number; message?: string };
  pendingMainSteers?: string[];
  pendingResume?: WaitingRecord;
  pendingAssistantHandoff?: string;
  resume?: boolean;
  mission?: string;
}

export function discardRetainedSession(task: SessionTask): void {
  const saved = task.retainedSession;
  task.retainedSession = undefined;
  saved?.driver.dispose();
}

export function retainIdleSession(task: SessionTask): void {
  if (!task.driver) return;
  if (!task.driver.isIdle) throw new Error("Agent 仍有未完成的调用，不能交接工作区");
  discardRetainedSession(task);
  const driver = task.driver;
  task.pendingMainSteers = [...(task.pendingMainSteers ?? []), ...driver.takeUndeliveredSteers()];
  task.retainedSession = { driver, epoch: task.controlEpoch };
  task.driver = undefined;
}

export function handoffSession(task: SessionTask, replace: boolean): void {
  if (!replace) return retainIdleSession(task);
  discardRetainedSession(task);
  task.controlEpoch += 1;
  task.pendingMainSteers = [...(task.pendingMainSteers ?? []), ...(task.driver?.takeUndeliveredSteers() ?? [])];
  task.driver?.dispose();
  task.driver = undefined;
}

export async function continueRetainedSession(task: SessionTask, epoch: number, host: {
  launch(): Promise<void>;
  persist(): void;
  settle(turn: Promise<Outcome>): Promise<void>;
}): Promise<void> {
  const saved = task.retainedSession;
  if (!saved || saved.epoch !== epoch || !saved.driver.isIdle) {
    discardRetainedSession(task);
    return host.launch();
  }
  task.retainedSession = undefined;
  task.driver = saved.driver;
  const message = [saved.message ?? task.mission ?? "继续当前尚未完成的工作。",
    task.pendingResume ? renderDecision(task.pendingResume) : "",
    task.pendingAssistantHandoff, ...(task.pendingMainSteers ?? [])].filter(Boolean).join("\n\n");
  const turn = saved.driver.continueWith(message);
  task.resume = false;
  task.pendingResume = undefined;
  task.pendingAssistantHandoff = undefined;
  task.pendingMainSteers = undefined;
  host.persist();
  await host.settle(turn);
}

/** 改工作树前停净旧容器，避免后台命令写入；目标登记、关联仓和 API 操作保留环境。 */
export function hostActionStopsContainer(action?: HostAction, replace = false): boolean {
  return replace || !action || ["push", "sync_branch", "retry_verification"].includes(action);
}
