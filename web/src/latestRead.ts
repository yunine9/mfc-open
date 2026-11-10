/** 同一个资源的后台刷新复用正在执行的请求，避免慢请求被轮询反复丢弃。
 * 切换资源立即取消旧请求；完成后不缓存正文，下一轮仍读取最新现场。 */
export class LatestRead<T> {
  private pending?: { key: string; controller: AbortController; promise: Promise<T> };

  read(key: string, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.pending?.key === key) return this.pending.promise;
    this.cancel();
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => load(controller.signal));
    const entry = { key, controller, promise };
    this.pending = entry;
    const clear = () => { if (this.pending === entry) this.pending = undefined; };
    void promise.then(clear, clear);
    return promise;
  }

  cancel(): void {
    this.pending?.controller.abort();
    this.pending = undefined;
  }
}
