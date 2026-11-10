import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { DeliveryOutbox } from "../src/deliveryOutbox.ts";

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-reply-scheduling-"));
  const outbox = new DeliveryOutbox(join(workspace, "delivery-outbox.jsonl"));
  const task: any = { summary: { id: "t", workspace, status: "await_merge",
    delivery: { mr_id: 1, mr_url: "http://platform/mr/1", sha: "abc",
      git_push: { sha: "abc" } } }, controlEpoch: 0 };
  const api: any = Object.create(TaskService.prototype);
  const background: Promise<unknown>[] = [];
  Object.assign(api, { options: { delivery: { pollIntervalMs: 1 } },
    tasks: new Map([["t", task]]), effectivePlatformUrl: () => "http://platform",
    deliveryOutbox: () => outbox, platformIdentity: () => ({}), persist: () => {},
    refreshOwnerInputs: () => {},
    bypass: (_task: unknown, _name: string, promise: Promise<unknown>) => {
      if (promise) background.push(promise);
    } });
  const enqueue = (id: string) => outbox.enqueueReviewReply({ discussion_id: id,
    repo: "repo", mr: 1, body: "已修", resolve: false, expected_sha: "abc" });
  return { api, task, outbox, enqueue, background,
    cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}

// 用可控信号触发超时，不依赖机器快慢或等待真实的 10 秒。
test("慢回复耗尽预算后，重启仍先发没轮到的回复；并发 flush 不重复发送", async (t) => {
  const f = fixture();
  let controller = new AbortController();
  let retry = false;
  t.mock.method(AbortSignal, "timeout", () => controller.signal);
  const calls: string[] = [];
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push(String(url));
    if (String(url).includes("/slow/")) {
      if (retry) throw new Error("still unavailable");
      started();
      return await new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
      });
    }
    return new Response("{}", { status: 200 });
  });
  try {
    f.enqueue("slow"); f.enqueue("fast");
    const first = f.api.flushReviewReplyOutbox(f.task);
    const duplicate = f.api.flushReviewReplyOutbox(f.task);
    await firstStarted;
    controller.abort();
    await Promise.all([first, duplicate]);
    assert.equal(calls.length, 1);
    // 新实例只靠持久化账恢复调度顺序，不需要内存队列或新状态。
    f.api.deliveryOutbox = () => new DeliveryOutbox(join(f.task.summary.workspace, "delivery-outbox.jsonl"));
    controller = new AbortController();
    retry = true;
    await f.api.flushReviewReplyOutbox(f.task);
    assert.match(calls[1], /\/fast\/reply$/);
    assert.equal(f.outbox.list().find(item => item.payload.discussion_id === "fast")?.state, "delivered");
    await f.api.flushReviewReplyOutbox(f.task);
    assert.equal(calls.filter(url => url.includes("/fast/")).length, 1);
  } finally { f.cleanup(); }
});

for (const terminal of ["completed", "canceled", "settling", "new_push"]) {
  test(`发送中变成 ${terminal}：迟到响应只落账，不再发送下一条或改终态`, async (t) => {
    const f = fixture();
    let release!: (response: Response) => void;
    let calls = 0;
    t.mock.method(globalThis, "fetch", () => {
      calls++;
      return new Promise<Response>(resolve => { release = resolve; });
    });
    try {
      f.enqueue("one"); f.enqueue("two");
      const running = f.api.flushReviewReplyOutbox(f.task);
      f.task.summary.status = ["settling", "new_push"].includes(terminal) ? "verifying" : terminal;
      if (terminal === "settling") f.task.mergeSettlement = Promise.resolve();
      if (terminal === "new_push") f.task.summary.delivery.git_push.sha = "new-sha";
      const status = f.task.summary.status;
      f.task.summary.detail = "终态";
      release(new Response("{}", { status: 200 }));
      await running;
      assert.equal(calls, 1);
      assert.equal(f.outbox.list()[0].state, "delivered");
      assert.equal(f.outbox.list()[1].state, "pending");
      if (terminal !== "new_push") f.api.markReviewReplyOutboxUnreadable(f.task, new Error("late failure"));
      assert.equal(f.task.summary.status, status);
      assert.equal(f.task.summary.detail, "终态");
    } finally { f.cleanup(); }
  });
}

test("MR 监控在回复请求未完成时仍能发现合入，且不会重新派发修复", async (t) => {
  const f = fixture();
  let release!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { release = resolve; }));
  let polls = 0;
  let settled = false;
  f.api.fetchGates = async () => ({ mrState: ++polls === 1 ? "opened" : "merged", gates: [] });
  f.api.fetchDiscussions = async () => ({ kind: "available", items: [] });
  f.api.settleMergeState = async () => { settled = true; f.task.summary.status = "completed"; };
  f.api.dispatchReviewRepair = async () => { assert.fail("不能因发送慢重派 Agent"); };
  // 监控的 timer 是 unref，测试期间保持事件循环有活跃句柄。
  const keepAlive = setInterval(() => {}, 1000);
  try {
    f.enqueue("slow");
    await f.api.watchMerge(f.task, 0);
    assert.equal(settled, true);
    assert.equal(f.outbox.list()[0].state, "pending", "合入观察无需等回复完成");
    release(new Response("{}", { status: 200 }));
    await Promise.all(f.background);
    assert.equal(f.task.summary.status, "completed");
  } finally { clearInterval(keepAlive); f.cleanup(); }
});
