/**
 * 时间维度:领导判断阻塞看的是"等了多久",不是"有几项在等"。
 * 等待时长全部由 waiting.created_at 算出——服务端本来就发,
 * 前端只做呈现,不推断状态。
 */

import { instantMs } from "./time";

type WaitableTask = {
  status: string;
  waiting?: { created_at?: string } | null;
  created_at: string;
};

/** 超过这个分钟数视为久等:徽章升级为红色,排序也靠它。 */
export const URGENT_MINUTES = 30;

/** 旧版 HumanGate 写的是 UTC 时钟，但错误地保存成无时区
 * `YYYY-MM-DD HH:mm:ss`。这类历史值必须补回 Z；标准 ISO 和真正带
 * 偏移量的时间保持原样。 */
export function waitingTimestamp(iso: string): number {
  return instantMs(iso);
}

/** 等待中的任务已等毫秒数;不在等待或没有时间戳返回 -1。 */
export function waitedMs(task: WaitableTask): number {
  if (task.status !== "waiting_for_human") return -1;
  const iso = task.waiting?.created_at;
  if (!iso) return -1;
  const started = waitingTimestamp(iso);
  if (Number.isNaN(started)) return -1;
  return Math.max(0, Date.now() - started);
}

export function formatWait(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

/** 排序:纯按创建时间倒序,最新的任务在最上面。用户实锤要"新任务放最
 * 上面";"待我核对"仍靠摘要卡与徽标提示,不靠位置。 */
export function byNewest(a: WaitableTask, b: WaitableTask): number {
  return instantMs(b.created_at) - instantMs(a.created_at);
}

/** 排序:等人的排最前(等最久的第一),其余按创建时间倒序。
 * "谁在等我、等了多久"是这块屏幕最该先回答的问题。 */
export function byUrgency(a: WaitableTask, b: WaitableTask): number {
  const left = waitedMs(a);
  const right = waitedMs(b);
  if (left >= 0 && right >= 0) return right - left;
  if (left >= 0) return -1;
  if (right >= 0) return 1;
  return instantMs(b.created_at) - instantMs(a.created_at);
}
