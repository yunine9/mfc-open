import type { VisibilitySource } from "./visiblePolling";

/** 正文更新失败时保留调用方现有内容，可见时每 30 秒重试，离开后不接收旧结果。 */
export function startKnowledgeDocumentRead<T>(options: {
  visibility: VisibilitySource; read: () => Promise<T>;
  receive: (value: T) => void; failed: (error: unknown) => void;
}) {
  let live = true, reading = false, needsRetry = true;
  let retry: ReturnType<typeof setTimeout> | undefined;
  async function read() {
    clearTimeout(retry);
    if (!live || reading || options.visibility.visibilityState !== "visible") return;
    reading = true;
    try {
      const value = await options.read();
      if (live) options.receive(value);
      needsRetry = false;
    } catch (error) {
      needsRetry = true;
      if (live) options.failed(error);
    } finally {
      reading = false;
      if (live && needsRetry && options.visibility.visibilityState === "visible") retry = setTimeout(read, 30_000);
    }
  }
  const visibilityChanged = () => { if (needsRetry) void read(); };
  options.visibility.addEventListener("visibilitychange", visibilityChanged);
  void read();
  return () => {
    live = false; clearTimeout(retry);
    options.visibility.removeEventListener("visibilitychange", visibilityChanged);
  };
}
