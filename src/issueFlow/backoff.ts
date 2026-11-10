/** 监看循环的退避与失败日志节流。
 *
 * 平台抖动时按原频率轮询会把一次故障放大成数万条失败；这里只做两件事：
 * 连续失败时按 2 的幂拉长等待（有上限），成功的下一轮立刻回到基础间隔；
 * 同一错误只记首条全文，之后每 10 次记一条计数，避免日志被同一条原因灌满。
 */

/** 单次等待上限：5 分钟。流水线一轮通常数分钟，再长就没有监看意义。 */
export const MAX_BACKOFF_MS = 300_000;

/** failures 为连续失败次数；首次失败后的下一次等待即 2 倍，随后 4/8…。 */
export function backoffMs(baseMs: number, failures: number): number {
  if (failures <= 0) return baseMs;
  const exponent = Math.min(failures, 8);
  return Math.min(MAX_BACKOFF_MS, baseMs * 2 ** exponent);
}

/** 退避多等出来的时间补回截止时间，避免平台抖动把轮询预算提前耗尽。
 * 返回原值表示不需要调整。 */
export function extendDeadlineByBackoff(
  deadline: string,
  baseMs: number,
  failures: number,
): string {
  const delay = backoffMs(baseMs, failures);
  const extra = delay - baseMs;
  if (extra <= 0) return deadline;
  return new Date(Date.parse(deadline) + extra).toISOString();
}

export class ConsecutiveFailureLog {
  private entries = new Map<string, { signature: string; count: number }>();
  constructor(
    private readonly log: (message: string) => void,
    private readonly every = 10,
  ) {}

  /** 返回该 key 当前连续出现的次数。 */
  fail(key: string, message: string): number {
    const signature = message.slice(0, 240);
    const entry = this.entries.get(key);
    if (!entry || entry.signature !== signature) {
      this.entries.set(key, { signature, count: 1 });
      this.log(message);
      return 1;
    }
    entry.count++;
    if (entry.count % this.every === 0) {
      this.log(`${key} 同错误已连续 ${entry.count} 次：${signature.slice(0, 160)}`);
    }
    return entry.count;
  }

  reset(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }
}
