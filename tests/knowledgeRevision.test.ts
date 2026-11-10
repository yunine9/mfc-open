import assert from "node:assert/strict";
import { test } from "node:test";
import { createKnowledgeRevisionObserver } from "../web/src/knowledgeRevision.ts";
import { startKnowledgeDocumentRead } from "../web/src/knowledgeDocumentRetry.ts";

class Surface {
  visibilityState = "visible";
  listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    const group = this.listeners.get(type) ?? new Set();
    group.add(listener); this.listeners.set(type, group);
  }
  removeEventListener(type: string, listener: () => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string) { for (const listener of this.listeners.get(type) ?? []) listener(); }
  visibility(value: string) { this.visibilityState = value; this.emit("visibilitychange"); }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("首页和模块共享版本检查，稳定版本不刷新目录，变化后以实际目录版本确认", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const surface = new Surface();
  let remote = "a", reads = 0, changed = 0, checks = 0;
  const observer = createKnowledgeRevisionObserver({
    visibility: surface, focus: surface, read: async () => { reads++; return remote; },
    changed: () => { changed++; }, checked: () => { checks++; },
  });
  observer.recordDirectoryRevision("a");
  const stopHome = observer.start(), stopReader = observer.start();
  await settle();
  assert.equal(reads, 1);
  assert.equal(changed, 0);
  t.mock.timers.tick(30_000); await settle();
  assert.equal(reads, 2);
  assert.equal(changed, 0, "时间到期本身不导致目录重新下载");
  remote = "b"; surface.emit("focus"); await settle();
  assert.equal(changed, 1);
  observer.recordDirectoryRevision("b");
  t.mock.timers.tick(30_000); await settle();
  assert.equal(changed, 1);
  assert.equal(checks, 4, "每轮检查可驱动轻量来源状态刷新");
  stopHome();
  t.mock.timers.tick(30_000); await settle();
  assert.equal(reads, 5, "另一阅读入口仍持有观察器");
  stopReader();
  t.mock.timers.tick(60_000); await settle();
  assert.equal(reads, 5);
  assert.equal(surface.listeners.get("focus")?.size, 0);
  assert.equal(surface.listeners.get("visibilitychange")?.size, 0);
});

test("目录刷新失败后，相同远端版本在下一轮重试，成功载入后停止重复刷新", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const surface = new Surface();
  let changed = 0;
  const observer = createKnowledgeRevisionObserver({
    visibility: surface, focus: surface, read: async () => "b", changed: () => { changed++; },
  });
  observer.recordDirectoryRevision("a");
  const stop = observer.start(); await settle();
  assert.equal(changed, 1);
  // 第一次目录请求失败，不能把“已发现 b”当成“已经展示 b”。
  t.mock.timers.tick(30_000); await settle();
  assert.equal(changed, 2);
  observer.recordDirectoryRevision("b");
  t.mock.timers.tick(30_000); await settle();
  assert.equal(changed, 2);
  stop();
});

test("目录配置读取失败即使远端版本未变，也在下一轮恢复读取", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const surface = new Surface();
  let changed = 0;
  const observer = createKnowledgeRevisionObserver({
    visibility: surface, focus: surface, read: async () => "a", changed: () => { changed++; },
  });
  observer.recordDirectoryRevision("a");
  const stop = observer.start(); await settle();
  observer.markDirectoryReadFailed();
  t.mock.timers.tick(30_000); await settle();
  assert.equal(changed, 1, "不能把相同摘要误当作已经成功加载配置");
  observer.recordDirectoryRevision("a");
  t.mock.timers.tick(30_000); await settle();
  assert.equal(changed, 1);
  stop();
});

test("版本先返回、旧目录后到达时会立即再次核对，避免建立错误基线", async () => {
  const surface = new Surface();
  let changed = 0, reads = 0;
  const observer = createKnowledgeRevisionObserver({
    visibility: surface, focus: surface, read: async () => { reads++; return "b"; }, changed: () => { changed++; },
  });
  const stop = observer.start(); await settle();
  assert.equal(changed, 0, "首次未取得目录时先等待目录读取");
  observer.recordDirectoryRevision("a"); await settle();
  assert.equal(reads, 2);
  assert.equal(changed, 1);
  observer.recordDirectoryRevision("b");
  stop();
});

test("隐藏页停止轮询，恢复与聚焦立即检查，慢请求期间不重叠且忽略旧会话结果", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const surface = new Surface();
  const requests: Array<{ signal: AbortSignal; resolve: (value: string) => void }> = [];
  let changed = 0;
  const observer = createKnowledgeRevisionObserver({
    visibility: surface, focus: surface,
    read: signal => new Promise(resolve => { requests.push({ signal, resolve }); }),
    changed: () => { changed++; },
  });
  observer.recordDirectoryRevision("a");
  const stop = observer.start();
  surface.emit("focus"); surface.emit("focus"); t.mock.timers.tick(90_000);
  assert.equal(requests.length, 1);
  surface.visibility("hidden");
  assert.equal(requests[0].signal.aborted, true);
  surface.emit("focus"); t.mock.timers.tick(90_000);
  assert.equal(requests.length, 1);
  surface.visibility("visible");
  assert.equal(requests.length, 1, "旧请求未结束时不新开并发请求");
  requests[0].resolve("stale"); await settle();
  assert.equal(changed, 0);
  assert.equal(requests.length, 2, "旧请求结束后立即补可见页检查");
  requests[1].resolve("a"); await settle();
  surface.emit("focus"); assert.equal(requests.length, 3);
  stop(); assert.equal(requests[2].signal.aborted, true);
  requests[2].resolve("other-account"); await settle();
  assert.equal(changed, 0);
  t.mock.timers.tick(90_000);
  assert.equal(requests.length, 3);
});

test("首次隐藏不请求，检查失败在下一周期重试且不改变目录基线", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const surface = new Surface(); surface.visibilityState = "hidden";
  let calls = 0, changed = 0;
  const observer = createKnowledgeRevisionObserver({
    visibility: surface, focus: surface, read: async () => {
      if (++calls === 1) throw new Error("temporary outage");
      return "b";
    },
    changed: () => { changed++; },
  });
  observer.recordDirectoryRevision("a");
  const stop = observer.start(); await settle();
  assert.equal(calls, 0);
  surface.visibility("visible"); await settle();
  assert.equal(calls, 1); assert.equal(changed, 0);
  t.mock.timers.tick(30_000); await settle();
  assert.equal(calls, 2); assert.equal(changed, 1);
  stop();
});

test("新目录已载入但正文读取失败，正文独立重试恢复，隐藏不请求，离开丢弃旧结果", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const surface = new Surface();
  let calls = 0, failures = 0;
  const received: string[] = [];
  const stop = startKnowledgeDocumentRead({
    visibility: surface, read: async () => {
      if (++calls === 1) throw new Error("temporary body failure");
      return "new body";
    },
    receive: value => received.push(value), failed: () => { failures++; },
  });
  await settle();
  assert.equal(failures, 1);
  assert.equal(received.length, 0, "未收到正文时调用方保留现有文稿及错误，不伪造新版本");
  surface.visibility("hidden"); t.mock.timers.tick(60_000); await settle();
  assert.equal(calls, 1);
  surface.visibility("visible"); await settle();
  assert.deepEqual(received, ["new body"]);
  t.mock.timers.tick(60_000); await settle();
  assert.equal(calls, 2, "恢复成功后不持续轮询正文");
  stop();

  let finish!: (value: string) => void;
  const stopOld = startKnowledgeDocumentRead({
    visibility: surface, read: () => new Promise<string>(resolve => { finish = resolve; }),
    receive: value => received.push(value), failed: () => { failures++; },
  });
  surface.emit("visibilitychange");
  stopOld(); finish("stale body"); await settle();
  assert.deepEqual(received, ["new body"]);
  assert.equal(surface.listeners.get("visibilitychange")?.size, 0);
});

test("正文失败按30秒周期重试，未结束的读取不并发", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const surface = new Surface();
  let calls = 0, finish!: (value: string) => void;
  const values: string[] = [];
  const stop = startKnowledgeDocumentRead({
    visibility: surface, read: async () => {
      if (++calls === 1) throw new Error("retry");
      return new Promise<string>(resolve => { finish = resolve; });
    }, receive: value => values.push(value), failed: () => {},
  });
  await settle();
  t.mock.timers.tick(29_999); await settle(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 2);
  surface.emit("visibilitychange"); t.mock.timers.tick(90_000);
  assert.equal(calls, 2);
  finish("recovered"); await settle();
  assert.deepEqual(values, ["recovered"]);
  stop();
});
