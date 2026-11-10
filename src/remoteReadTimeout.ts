/** 远端只读查询既要中止 HTTP，也要在下游忽略 signal 时释放等待者。
 * 超时只结束查询，不允许并发重放推送、创建 MR 等写操作。 */
export async function withRemoteReadTimeout<T>(
  read: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 10_000,
  parent?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
  const signal = parent ? AbortSignal.any([parent, timeout]) : timeout;
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => read(signal)), interrupted]);
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener("abort", abort); }
}
