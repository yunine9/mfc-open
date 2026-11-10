export interface VisibilitySource {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface PollingClock {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultClock: PollingClock = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(
    handle as ReturnType<typeof setInterval>),
};

/**
 * 内网多人同时开着工作台时，隐藏页签不应继续空转请求。重新可见时
 * 立即补一次，再恢复原周期；SSE 自己负责断线重放，不经过这里。
 */
export function startVisiblePolling(
  poll: () => void,
  intervalMs: number,
  source: VisibilitySource,
  options: { runOnStart?: boolean; clock?: PollingClock } = {},
): () => void {
  const clock = options.clock ?? defaultClock;
  let stopped = false;
  let timer: unknown;

  const clear = () => {
    if (timer === undefined) return;
    clock.clearInterval(timer);
    timer = undefined;
  };
  const schedule = () => {
    if (stopped || source.visibilityState !== "visible"
        || timer !== undefined) return;
    timer = clock.setInterval(() => {
      if (!stopped && source.visibilityState === "visible") poll();
    }, intervalMs);
  };
  const visibilityChanged = () => {
    clear();
    if (stopped || source.visibilityState !== "visible") return;
    poll();
    schedule();
  };

  source.addEventListener("visibilitychange", visibilityChanged);
  if (source.visibilityState === "visible") {
    if (options.runOnStart !== false) poll();
    schedule();
  }

  return () => {
    stopped = true;
    clear();
    source.removeEventListener("visibilitychange", visibilityChanged);
  };
}
