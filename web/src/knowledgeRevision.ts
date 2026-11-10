import { invalidateKnowledgeReads } from "./knowledgeReadCache";

interface EventSource {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
interface VisibilitySource extends EventSource { visibilityState: string }

/** 一个阅读会话只检查一份版本；定时器在请求结束后启动，隐藏及离开时停止。 */
export function createKnowledgeRevisionObserver(options: {
  visibility: VisibilitySource; focus: EventSource;
  read: (signal: AbortSignal) => Promise<string>;
  changed: () => void; checked?: () => void; interval?: number;
}) {
  let users = 0, epoch = 0, directoryRevision: string | undefined, observedRevision: string | undefined;
  let directoryReadFailed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { epoch: number; controller: AbortController } | undefined;
  const visible = () => users > 0 && options.visibility.visibilityState === "visible";
  function clear() { clearTimeout(timer); timer = undefined; }
  function check() {
    clear();
    if (!visible() || pending) return;
    const request = { epoch, controller: new AbortController() };
    pending = request;
    void options.read(request.controller.signal).then(next => {
      if (request.epoch !== epoch || !visible()) return;
      // 以实际载入的目录为准；上次刷新失败时，相同远端版本也要在下一轮重试。
      const changed = directoryReadFailed || (directoryRevision !== undefined ? directoryRevision !== next : observedRevision !== undefined);
      observedRevision = next;
      if (changed) options.changed();
    }).catch(() => { /* 保留可读内容；下一轮或重新聚焦时重试。 */ }).finally(() => {
      if (pending !== request) return;
      pending = undefined;
      if (!visible()) return;
      if (request.epoch !== epoch) check();
      else {
        options.checked?.();
        timer = setTimeout(check, options.interval ?? 30_000);
      }
    });
  }
  function visibilityChanged() {
    clear();
    if (visible()) check();
    else { epoch++; pending?.controller.abort(); }
  }
  return {
    check,
    markDirectoryReadFailed() { directoryReadFailed = true; },
    recordDirectoryRevision(next: string) {
      directoryRevision = next;
      directoryReadFailed = false;
      // 目录与版本检查可能交错；目录载入后再核对一次，避免以较新检查覆盖较旧目录。
      if (observedRevision !== undefined && observedRevision !== next) check();
    },
    start() {
      if (users++ === 0) {
        epoch++;
        options.visibility.addEventListener("visibilitychange", visibilityChanged);
        options.focus.addEventListener("focus", check);
        check();
      }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        if (--users > 0) return;
        epoch++; clear(); pending?.controller.abort();
        options.visibility.removeEventListener("visibilitychange", visibilityChanged);
        options.focus.removeEventListener("focus", check);
      };
    },
  };
}

const checkedListeners = new Set<() => void>();
let observer: ReturnType<typeof createKnowledgeRevisionObserver> | undefined;
let directoryRevision: string | undefined;
let directoryReadFailed = false;
function sharedObserver() {
  if (!observer) {
    const browser = globalThis as unknown as EventSource & { document: VisibilitySource };
    observer = createKnowledgeRevisionObserver({
      visibility: browser.document, focus: browser,
      read: async signal => {
        const response = await fetch("/knowledge-documents?view=revision", {
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), cache: "no-store",
        });
        if (!response.ok) throw new Error("知识版本读取失败");
        const value = await response.json() as { revision?: unknown };
        if (typeof value.revision !== "string" || !value.revision) throw new Error("知识版本格式不正确");
        return value.revision;
      },
      changed: invalidateKnowledgeReads,
      checked: () => { for (const listener of checkedListeners) listener(); },
    });
    if (directoryRevision) observer.recordDirectoryRevision(directoryRevision);
    if (directoryReadFailed) observer.markDirectoryReadFailed();
  }
  return observer;
}
export function observeKnowledgeRevision() { return sharedObserver().start(); }
export function checkKnowledgeRevision() { observer?.check(); }
export function recordKnowledgeDirectoryRevision(revision: string | undefined) {
  if (!revision) return;
  directoryReadFailed = false;
  directoryRevision = revision;
  observer?.recordDirectoryRevision(revision);
}
export function markKnowledgeDirectoryReadFailed() {
  directoryReadFailed = true;
  observer?.markDirectoryReadFailed();
}
/** 来源状态与版本检查共用节奏；读取状态不会触发完整目录刷新。 */
export function subscribeKnowledgeRevisionChecks(listener: () => void) {
  checkedListeners.add(listener);
  return () => { checkedListeners.delete(listener); };
}
