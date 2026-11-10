import type { CloudSession } from "./sessionDriver.ts";

/** 独立修订/预热会话也属于任务，不能只回收主 Agent。 */
const owners = new WeakMap<object, { epoch: number; sessions: Set<CloudSession> }>();
function state(owner: object) {
  let value = owners.get(owner);
  if (!value) owners.set(owner, value = { epoch: 0, sessions: new Set() });
  return value;
}

export function auxiliarySessionEpoch(owner: object): number {
  return state(owner).epoch;
}

export function hasAuxiliarySessions(owner: object): boolean {
  return state(owner).sessions.size > 0;
}

/** 在异步创建前取 epoch；取消期间才创建完的会话不能再启动。 */
export function trackAuxiliarySession(owner: object, session: CloudSession, epoch: number): void {
  const current = state(owner);
  if (current.epoch !== epoch) {
    session.dispose();
    throw new Error("任务已停止，本轮辅助会话不再启动");
  }
  current.sessions.add(session);
}

export function untrackAuxiliarySession(owner: object, session?: CloudSession): void {
  if (session) state(owner).sessions.delete(session);
}

/** 停止与重启后不能仍把基线显示为“编译中”，也不能冒充编译失败。 */
export function interruptWarmupReceipt(receipt?: {
  status: string; detail?: string; finished_at?: string;
}): boolean {
  if (receipt?.status !== "running") return false;
  receipt.status = "infrastructure_failure";
  receipt.detail = "预热因任务停止、服务重启或切换构建阶段而中断；基线是否编译通过尚未确认";
  receipt.finished_at = new Date().toISOString();
  return true;
}

export async function abortAuxiliarySessions(owner: object): Promise<void> {
  const current = state(owner);
  current.epoch += 1;
  const sessions = [...current.sessions];
  const results = await Promise.allSettled(sessions.map(async (session) => {
    await session.abort();
    current.sessions.delete(session);
  }));
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "辅助会话未能全部停止，请重试");
}
