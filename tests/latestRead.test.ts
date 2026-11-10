import { test } from "node:test";
import assert from "node:assert/strict";
import { LatestRead } from "../web/src/latestRead.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
test("慢读取跨多轮刷新只请求一次，完成后仍允许读取新内容", async () => {
  const reader = new LatestRead<string>(), slow = deferred<string>();
  let calls = 0;
  const load = async () => { calls++; return slow.promise; };
  const first = reader.read("file-a", load);
  await Promise.resolve();
  for (let tick = 0; tick < 8; tick++) assert.equal(reader.read("file-a", load), first);
  assert.equal(calls, 1);
  slow.resolve("current");assert.equal(await first, "current");
  assert.equal(await reader.read("file-a", async () => "updated"), "updated");
});
test("切换文件取消旧读取，旧读取完成不能清掉新文件请求", async () => {
  const reader = new LatestRead<string>(), a = deferred<string>(), b = deferred<string>();
  let signal!: AbortSignal;
  const first = reader.read("a", async s => { signal = s; return a.promise; });
  await Promise.resolve();
  const next = reader.read("b", async () => b.promise);
  assert.equal(signal.aborted, true);
  a.resolve("old");await first;
  assert.equal(reader.read("b", async () => "duplicate"), next);
  b.resolve("new");assert.equal(await next, "new");
});
test("失败可以重试，离开工作区会取消读取", async () => {
  const reader = new LatestRead<string>();
  await assert.rejects(reader.read("a", async () => {throw new Error("offline");}), /offline/);
  assert.equal(await reader.read("a", async () => "retry"), "retry");
  let signal!: AbortSignal;
  const pending = deferred<string>();
  const request = reader.read("b", async s => { signal=s;return pending.promise; });
  await Promise.resolve();reader.cancel();assert.equal(signal.aborted,true);
  pending.resolve("done");await request;
});
